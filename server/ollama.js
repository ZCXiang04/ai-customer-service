/**
 * Ollama 客户端
 *
 * 三条踩过坑后定下的硬规则：
 *  1. 必须显式传 think:false。qwen3.5 默认开思考模式，会把整个 token 预算烧在 thinking 上、
 *     正文返回空 —— 界面表现就是「模型没输出」。
 *  2. 必须显式传 num_ctx。Ollama 默认只给 4096，超了静默截断，连 system prompt 都会丢。
 *  3. Node 22 的 Response.body 只有 getReader()，没有 read()。用错会直接挂死在流读取上。
 */
import { config } from './config.js';
import { log } from './util.js';

const base = () => config.ollama.baseUrl;

/* ---------------- 基础查询 ---------------- */

async function getJson(pathname, timeoutMs = 8000) {
  const res = await fetch(`${base()}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  return res.json();
}

export async function getVersion() {
  const j = await getJson('/api/version');
  return j.version || 'unknown';
}

export async function listModels() {
  const j = await getJson('/api/tags', 10000);
  return (j.models || []).map((m) => ({
    name: m.name,
    size: m.size || 0,
    family: m.details?.family || '',
    parameterSize: m.details?.parameter_size || '',
    quantization: m.details?.quantization_level || '',
  }));
}

/** 当前已加载的模型（含实际 context_length / 是否跑在显存） */
export async function listRunning() {
  try {
    const j = await getJson('/api/ps', 5000);
    return j.models || [];
  } catch {
    return [];
  }
}

export async function health() {
  const version = await getVersion();
  const models = await listModels();
  return { ok: true, version, models };
}

/* ---------------- 流式对话 ---------------- */

/**
 * 流式对话。
 * @yields {{type:'thinking',text}|{type:'content',text}|{type:'stats',...}}
 *
 * @param {object}  o
 * @param {string}  o.model
 * @param {Array}   o.messages          [{role, content}]；工具调用场景会带 tool_calls / tool 角色
 * @param {boolean} [o.think]           默认 false
 * @param {AbortSignal} [o.signal]      用户中断
 * @param {number}  [o.temperature]
 * @param {Array}   [o.tools]           Ollama tools 结构；传入即开启原生工具调用
 *
 * @yields {{type:'thinking',text}|{type:'content',text}|{type:'toolcall',calls}|{type:'stats',...}}
 */
export async function* chatStream({
  model,
  messages,
  think = config.ollama.thinkDefault,
  signal,
  temperature,
  tools,
}) {
  const payload = {
    model,
    stream: true,
    think, // 关键参数，见文件头第 1 条
    keep_alive: config.ollama.keepAlive,
    messages,
    options: {
      num_ctx: config.ollama.numCtx, // 关键参数，见文件头第 2 条
      num_predict: think ? config.ollama.numPredictThinking : config.ollama.numPredict,
      temperature: temperature ?? config.ollama.temperature,
    },
    // 传入 tools 即开启原生工具调用；模型可能在 content 之外返回 tool_calls
    ...(tools && tools.length ? { tools } : {}),
  };

  /* 超时策略：首字节宽松（要等冷加载），之后按相邻两块间隔计时 */
  let timedOut = null; // 'first' | 'idle'
  const ac = new AbortController();
  const arm = (ms, phase) => {
    clearTimeout(arm.t);
    arm.t = setTimeout(() => {
      timedOut = phase;
      ac.abort();
    }, ms);
  };
  if (signal) {
    if (signal.aborted) return;
    signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  arm(config.ollama.firstTokenTimeoutMs, 'first');

  let res;
  try {
    res = await fetch(`${base()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(arm.t);
    if (timedOut) {
      throw new Error(
        timedOut === 'first'
          ? `模型 ${model} 在 ${config.ollama.firstTokenTimeoutMs / 1000}s 内没有产出任何内容，可能正在冷加载或已卡死`
          : `模型 ${model} 生成中断，超过 ${config.ollama.streamIdleTimeoutMs / 1000}s 没有新内容`
      );
    }
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return; // 用户中断
    throw new Error(`无法连接 Ollama（${base()}）：${err?.cause?.code || err.message}`);
  }

  if (!res.ok) {
    clearTimeout(arm.t);
    const text = await res.text().catch(() => '');
    // 端口填错（比如填了 Web UI 的端口）会返回 HTML，这里给出可执行的排查提示
    const isJson = text.trimStart().startsWith('{');
    throw new Error(
      isJson
        ? `Ollama HTTP ${res.status} ${text.slice(0, 200)}`
        : `Ollama HTTP ${res.status}，响应不是 JSON（开头：${text.slice(0, 60)}）。` +
          `请确认 OLLAMA_BASE_URL 指向的是 Ollama API 本体，而不是某个 Web UI 端口。`
    );
  }

  /* 关键：Node 22 里只有 getReader() */
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let gotFirst = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;

        let json;
        try {
          json = JSON.parse(line);
        } catch {
          continue; // 忽略非 JSON 行（比如 Ollama 偶尔的心跳）
        }

        if (json.error) throw new Error(String(json.error));

        if (!gotFirst && (json.message?.content || json.message?.thinking || json.done)) {
          gotFirst = true;
          arm(config.ollama.streamIdleTimeoutMs, 'idle');
        } else if (gotFirst) {
          arm(config.ollama.streamIdleTimeoutMs, 'idle');
        }

        const msg = json.message || {};
        if (msg.thinking) yield { type: 'thinking', text: msg.thinking };
        if (msg.content) yield { type: 'content', text: msg.content };
        // 原生工具调用：模型请求调用工具，这里原样透传给上层（chat.js 负责执行后回传）
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          yield { type: 'toolcall', calls: msg.tool_calls };
        }

        if (json.done) {
          yield {
            type: 'stats',
            evalCount: json.eval_count || 0,
            promptEvalCount: json.prompt_eval_count || 0,
            totalDurationMs: Math.round((json.total_duration || 0) / 1e6),
            evalDurationMs: Math.round((json.eval_duration || 0) / 1e6),
            doneReason: json.done_reason || '',
          };
          return;
        }
      }
    }
  } catch (err) {
    clearTimeout(arm.t);
    if (timedOut) {
      throw new Error(
        timedOut === 'first'
          ? `模型 ${model} 在 ${config.ollama.firstTokenTimeoutMs / 1000}s 内没有产出任何内容`
          : `模型 ${model} 生成中断，超过 ${config.ollama.streamIdleTimeoutMs / 1000}s 没有新内容`
      );
    }
    if (err?.name === 'AbortError') return; // 用户点停止
    throw err;
  } finally {
    clearTimeout(arm.t);
    try {
      await reader.cancel();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 预热模型：本机 CPU 冷启动可能十几到几十秒。
 * 让服务启动时先把模型加载好，用户第一次提问就不用干等。
 */
export async function warmup(model) {
  const target = model || config.ollama.defaultModel;
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.ollama.firstTokenTimeoutMs);
    const res = await fetch(`${base()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: target,
        stream: false,
        think: false,
        keep_alive: config.ollama.keepAlive,
        messages: [{ role: 'user', content: 'ping' }],
        options: { num_ctx: config.ollama.numCtx, num_predict: 1 },
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    log.info(`[ollama] 预热 ${target} ${res.ok ? '完成' : '失败'} 耗时 ${Date.now() - t0}ms`);
    return res.ok;
  } catch (err) {
    log.warn(`[ollama] 预热 ${target} 失败：${err.message}`);
    return false;
  }
}
