/**
 * SSE 流式对话主流程（含原生工具调用）
 *
 * 事件序列：meta → [tool(running|done|error)] → thinking / delta 若干 → done 或 error
 *
 * 工具调用循环（关键新增）：
 *  1. 第一阶段：把 tools 一起发给模型并流式接收。
 *     - 若模型返回 tool_calls：逐个执行（emit tool 事件）→ 把「assistant(tool_calls) + tool(result)」
 *       拼回上下文 → 进入第二阶段。
 *     - 若没有 tool_calls：当前 content 就是最终回答，直接收尾。
 *  2. 第二阶段：不带 tools 再请求一次，让模型基于工具结果产出自然语言回答并流式下发。
 *
 * 三条踩坑后定下的纪律：
 *  1. 提前结束的路径（追问、取数失败）也必须先发 delta 再发 done。
 *  2. 天气取数失败不要把错误塞给模型编答案，直接回带原因的友好文案。
 *  3. 用户点停止时保留已生成的部分内容并落库，不丢上下文。
 *  4. 工具结果必须在服务端拼回上下文再二次请求，模型才能看到「它查到的数据」。
 */
import { Router } from 'express';
import { config } from '../config.js';
import {
  getSession, createSession, updateSessionModel,
  addMessage, listRecentMessages,
} from '../db.js';
import { buildContext, estimateTokens } from '../context.js';
import { chatStream } from '../ollama.js';
import { detectWeatherIntent } from '../intent-weather.js';
import { queryWeather, pickDayData, formatWeatherForModel, WeatherError } from '../weather.js';
import { executeTool, getToolSchemas } from '../tools/index.js';
import { queryOrder } from '../tools/order.js';
import { detectOrderIntent } from '../intent-order.js';
import { sseInit, sseKeepAlive, wrap } from '../middleware.js';
import { AppError, log } from '../util.js';

const router = Router();

function makeTitle(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > 24 ? t.slice(0, 24) + '…' : t || '新对话';
}

// 必须 wrap：Express 4 不捕获 async 路由抛出的错误，漏了会挂死响应
router.post('/chat', wrap(async (req, res) => {
  const { sessionId, message, model, think, systemPrompt, temperature } = req.body || {};

  if (typeof message !== 'string' || !message.trim()) {
    throw new AppError('message 不能为空', { status: 400, code: 'EMPTY_MESSAGE' });
  }
  if (message.length > 8000) {
    throw new AppError('消息过长（上限 8000 字）', { status: 400, code: 'MESSAGE_TOO_LONG' });
  }

  const text = message.trim();
  let session = sessionId ? getSession(sessionId) : null;
  const useModel = model || session?.model || config.ollama.defaultModel;

  if (!session) {
    session = createSession({ title: makeTitle(text), model: useModel });
  } else if (model && model !== session.model) {
    session = updateSessionModel(session.id, model) || session;
  }

  // 系统提示词优先级：本次请求 > 会话自定义 > 服务端默认；空串一律回落
  const effectivePrompt =
    typeof systemPrompt === 'string' && systemPrompt.trim()
      ? systemPrompt.trim()
      : session.system_prompt || config.defaultSystemPrompt;

  addMessage({ sessionId: session.id, role: 'user', content: text });

  /* ---------- SSE 建立（必须在任何业务事件之前） ---------- */
  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  sseInit(res);
  const stopPing = sseKeepAlive(res); // 本机 CPU 推理慢，加载期可能长时间无数据

  const ac = new AbortController();
  let clientGone = false;
  // 注意：必须监听 res 而不是 req。Node 里 req 的 'close' 在「请求体读完」时就会触发，
  // 用它判断客户端断开会导致请求刚进来就被中断 —— 表现为模型瞬间返回空内容。
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      ac.abort();
    }
  });

  // 跨阶段累计的显示内容 / 思考，确保两阶段流式输出都落进最终落库文本
  let fullContent = '';
  let fullThinking = '';
  const emit = {
    thinking: (t) => { fullThinking += t; send({ type: 'thinking', text: t }); },
    content: (t) => { fullContent += t; send({ type: 'delta', text: t }); },
  };

  /** 统一收尾：落库 → 补发 delta（若没流式发过）→ 发 done → 关流 */
  const finish = (content, { thinking = '', extra = {}, streamed = false } = {}) => {
    const messageId = addMessage({
      sessionId: session.id,
      role: 'assistant',
      content,
      thinking,
      model: useModel,
    });
    if (content && !streamed) send({ type: 'delta', text: content });
    send({ type: 'done', messageId, sessionId: session.id, content, thinking, ...extra });
    stopPing();
    res.end();
  };

  /**
   * 单次流式调用：把流式块实时 emit 出去，并收集 tool_calls / stats 返回。
   * @returns {Promise<{content,thinking,toolCalls,stats}>}
   */
  async function runStream(messages, tools) {
    let content = '';
    let thinking = '';
    let stats = null;
    const callMap = new Map(); // index -> { function:{name,arguments} }

    for await (const part of chatStream({
      model: useModel,
      messages,
      think: Boolean(think),
      signal: ac.signal,
      temperature,
      tools,
    })) {
      if (part.type === 'thinking') {
        thinking += part.text;
        emit.thinking(part.text);
      } else if (part.type === 'content') {
        content += part.text;
        emit.content(part.text);
      } else if (part.type === 'toolcall' && Array.isArray(part.calls)) {
        // 合并跨分片的 tool_calls（按 index），兼容「一次性给全」与「分片增量」两种模式
        for (const c of part.calls) {
          const fn = c.function || {};
          const idx = typeof fn.index === 'number' ? fn.index : callMap.size;
          const ex = callMap.get(idx) || { function: { name: '', arguments: {} } };
          if (fn.name) ex.function.name = fn.name;
          let args = fn.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { /* 忽略解析失败的分片 */ }
          }
          ex.function.arguments = Object.assign(ex.function.arguments || {}, args || {});
          callMap.set(idx, ex);
        }
      } else if (part.type === 'stats') {
        stats = part;
      }
    }

    const toolCalls = [...callMap.values()].map((c) => ({
      function: { name: c.function.name, arguments: c.function.arguments || {} },
    }));
    return { content, thinking, toolCalls, stats };
  }

  try {
    /* ---------- 天气旁路（规则触发，独立于原生工具） ---------- */
    const extraSystem = [];
    let intent = config.weather.enabled ? detectWeatherIntent(text) : { hit: false };
    const toolsUsed = [];

    if (intent.hit) {
      // 没说城市：配置了默认城市就按默认查（并告知模型要说明），否则追问
      if (intent.needCity) {
        if (config.weather.defaultCity) {
          intent = { ...intent, city: config.weather.defaultCity, needCity: false, viaDefault: true };
        } else {
          finish('想查哪个城市的天气？直接说城市名就行，比如「北京天气」「深圳明天下雨吗」。');
          return;
        }
      }

      send({
        type: 'tool', name: 'weather', tool: 'weather', status: 'running',
        args: { city: intent.city, day: intent.day },
      });

      try {
        const data = await queryWeather(intent.city);
        send({
          type: 'tool', name: 'weather', tool: 'weather', status: 'done',
          args: { city: intent.city, day: intent.day },
          data: pickDayData(data, intent.day),
        });
        extraSystem.push(formatWeatherForModel(data, intent.day));
        if (intent.viaDefault) {
          extraSystem.push(`用户没有指定城市，本次按默认城市「${intent.city}」查询，回答开头用一句话自然说明这一点。`);
        }
        toolsUsed.push('weather');
      } catch (err) {
        // 城市无效 ≠ 服务故障：发中性「未找到城市」卡片并追问，不要红色报错吓用户
        const isCityErr =
          err instanceof WeatherError &&
          ['207301', '207302', 'EMPTY_CITY'].includes(String(err.code));
        if (isCityErr) {
          send({
            type: 'tool', name: 'weather', tool: 'weather', status: 'done',
            args: { city: intent.city, day: intent.day },
            data: { cityNotFound: true, city: intent.city },
          });
          finish(
            `没有查到「${intent.city}」的天气数据。请告诉我正确的城市名，` +
              '比如「北京天气」「上海明天下雨吗」，我再帮你查。'
          );
          return;
        }
        const reason = err instanceof WeatherError ? err.message : '天气查询失败，请稍后重试';
        send({
          type: 'tool', name: 'weather', tool: 'weather', status: 'error',
          args: { city: intent.city }, error: reason,
        });
        // 取数失败绝不把错误丢给模型编答案
        finish(`${reason}。你可以稍后再问一次，或者换个城市试试。`);
        return;
      }
    }

    /* ---------- 订单意图确定性旁路（手机号 / 已知姓名） ----------
       与天气旁路同理：模型对「凭姓名查」的 tool calling 触发不稳定，
       这里用规则把手机号 / 已知收件人姓名识别出来，由服务端直接查并注入结果，
       保证「手机号 / 姓名查询」稳定可用。命中后不再交给模型二次调用同一工具。 */
    let orderHandled = false;
    if (config.tools.enabled && !intent.hit) {
      const oi = detectOrderIntent(text);
      if (oi.hit) {
        send({ type: 'tool', tool: 'query_order', name: 'query_order', status: 'running', args: oi });
        const ores = queryOrder(oi);
        toolsUsed.push('query_order');
        if (ores.ok && !ores.notFound) {
          send({
            type: 'tool', tool: 'query_order', name: 'query_order', status: 'done',
            args: oi, data: ores.data,
          });
          extraSystem.push(ores.summary);
        } else if (ores.ok && ores.notFound) {
          // 查无此人/此号：把友好提示塞给模型，让它自然回复，不再编数据
          send({
            type: 'tool', tool: 'query_order', name: 'query_order', status: 'done',
            args: oi, data: ores.data,
          });
          extraSystem.push(ores.summary);
        } else {
          send({
            type: 'tool', tool: 'query_order', name: 'query_order', status: 'error',
            args: oi, error: ores.error || '订单查询失败',
          });
          finish(ores.error || '订单查询失败，请稍后重试。');
          return;
        }
        orderHandled = true;
      }
    }

    /* ---------- 组装上下文 ---------- */
    const history = listRecentMessages(session.id, config.context.maxMessages + 20);
    const { messages, trimmed } = buildContext({
      history,
      systemPrompt: effectivePrompt,
      currentMessage: text,
      extraSystem,
      maxMessages: config.context.maxMessages,
      maxChars: config.context.maxChars,
    });

    const toolSchemas = config.tools.enabled ? getToolSchemas() : [];
    if (orderHandled) {
      // 订单已由确定性旁路处理，剔除 query_order 避免模型在第二阶段重复调用
      toolSchemas.length = 0;
      toolSchemas.push(...getToolSchemas().filter((t) => t.function?.name !== 'query_order'));
    }
    send({
      type: 'meta',
      sessionId: session.id,
      model: useModel,
      think: Boolean(think),
      trimmed,
      promptTokens: estimateTokens(messages.map((m) => m.content).join('')),
      toolsUsed,
    });

    /* ---------- 第一阶段：带 tools 流式检测 ---------- */
    const r1 = await runStream(messages, toolSchemas);

    // 没有触发工具调用：r1.content 即最终回答
    if (!r1.toolCalls.length) {
      if (!r1.content && !r1.thinking) {
        finish('模型这次没有产出内容，可能被超时中断了。换个说法再试一次，或换一个模型。', {
          extra: { empty: true, stats: r1.stats },
        });
        return;
      }
      finish(r1.content, {
        thinking: r1.thinking,
        streamed: true,
        extra: {
          aborted: clientGone,
          stats: r1.stats,
          tokensPerSecond:
            r1.stats && r1.stats.evalDurationMs > 0
              ? Number((r1.stats.evalCount / (r1.stats.evalDurationMs / 1000)).toFixed(1))
              : null,
        },
      });
      return;
    }

    /* ---------- 工具执行阶段 ---------- */
    const toolResultMsgs = [];
    for (const tc of r1.toolCalls) {
      const name = tc.function?.name;
      const args = tc.function?.arguments || {};
      send({ type: 'tool', tool: name, name, status: 'running', args });
      const result = executeTool(name, args);
      toolsUsed.push(name);

      if (result.ok) {
        send({
          type: 'tool', tool: name, name, status: 'done', args,
          data: result.data ?? null,
        });
      } else {
        send({
          type: 'tool', tool: name, name, status: 'error', args,
          error: result.error || '工具执行失败',
        });
      }
      toolResultMsgs.push({
        role: 'tool',
        name,
        content: result.ok ? result.summary : (result.error || '工具执行失败'),
      });
    }

    /* ---------- 第二阶段：不带 tools，让模型基于结果作答 ---------- */
    const assistantWithCall = {
      role: 'assistant',
      content: r1.content || '',
      tool_calls: r1.toolCalls.map((c) => ({
        function: { name: c.function.name, arguments: c.function.arguments },
      })),
    };
    const messages2 = [...messages, assistantWithCall, ...toolResultMsgs];

    const r2 = await runStream(messages2, null);

    if (!r2.content && !r2.thinking) {
      finish('已为你查询，但模型未能生成回答。请重试，或换一个模型。', {
        extra: { empty: true, stats: r2.stats, toolsUsed },
      });
      return;
    }

    finish(fullContent, {
      thinking: fullThinking,
      streamed: true,
      extra: {
        aborted: clientGone,
        stats: r2.stats,
        toolsUsed,
        tokensPerSecond:
          r2.stats && r2.stats.evalDurationMs > 0
            ? Number((r2.stats.evalCount / (r2.stats.evalDurationMs / 1000)).toFixed(1))
            : null,
      },
    });
  } catch (err) {
    stopPing();
    log.error(`[chat] ${err.message}`);
    if (!res.writableEnded) {
      send({ type: 'error', error: err.message });
      res.end();
    }
  }
}));

export default router;
