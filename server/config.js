/**
 * 集中配置 + 极简 .env 加载器
 *
 * 加载优先级：环境变量 > .env > 内置默认值
 * 新增配置项一律走 str() / num() / bool()，不要直接读 process.env。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- .env 极简解析器 ---------------- */

function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = (() => {
  try {
    return parseEnv(fs.readFileSync(path.join(rootDir, '.env'), 'utf8').replace(/^﻿/, ''));
  } catch {
    return {};
  }
})();

const env = { ...fileEnv, ...process.env };

/* ---------------- 取值助手 ---------------- */

const str = (v, fallback = '') => (v === undefined || v === null ? fallback : String(v).trim());
const num = (v, fallback) => {
  const s = str(v);
  // 空串必须走默认值：Number('') === 0 且 0 是 finite，
  // 不挡住的话「.env 里没写的数值项」会静默变成 0（超时 0ms = 立刻中断）。
  if (s === '') return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v, fallback = false) => {
  const s = str(v).toLowerCase();
  if (!s) return fallback;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
};

/* ---------------- Ollama ---------------- */

/**
 * 上下文字符预算推导（关键，别绕过）
 *
 * Ollama 的 num_ctx 同时装「提示词 + 本次输出」，装不下会**静默截断** ——
 * 连 system prompt 都可能被丢掉，而且不给任何报错。所以输入侧必须主动给输出留位：
 *   可用 token = num_ctx - num_predict - 余量
 *   可用字符 ≈ 可用 token × 1.4 × 0.85 （中文约 1 token≈1.4 字，再留 15% 估算误差）
 */
const CHARS_PER_TOKEN = 1.4;
const SAFETY_RATIO = 0.85;
const RESERVED_TOKENS = 64;

function deriveContextChars(ctxTokens, predictTokens, requested) {
  const usableTokens = Math.max(0, ctxTokens - predictTokens - RESERVED_TOKENS);
  const derived = Math.floor(usableTokens * CHARS_PER_TOKEN * SAFETY_RATIO);
  if (derived <= 0) return 0;
  return Math.min(requested, derived);
}

const numCtx = num(env.NUM_CTX, 4096); // 默认用 Ollama 原生值，避免一上来就触发模型重载
const numPredict = num(env.NUM_PREDICT, 1024);
const numPredictThinking = num(env.NUM_PREDICT_THINKING, 2048);

const requestedChars = num(env.MAX_CONTEXT_CHARS, 12000);
const contextChars = deriveContextChars(numCtx, numPredict, requestedChars);

/** 配置想要的 > 实际装得下的 → 说明这段历史永远用不上，启动时提醒一次 */
const contextCharsWarning =
  requestedChars > contextChars
    ? `MAX_CONTEXT_CHARS=${requestedChars} 超过 num_ctx=${numCtx} 装得下的量，` +
      `已自动收敛为 ${contextChars} 字。想放更多历史需同时调大 NUM_CTX 或调小 NUM_PREDICT。`
    : null;

export const config = {
  rootDir,
  webDir: path.join(rootDir, 'web'),
  dataDir: path.join(rootDir, 'server', 'data'),

  port: num(env.PORT, 3000),

  ollama: {
    baseUrl: str(env.OLLAMA_BASE_URL, 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    defaultModel: str(env.DEFAULT_MODEL, 'qwen3.5:2b'),
    /**
     * 必须显式传 think:false —— qwen3.5 默认开启思考模式，
     * 会把整个 token 预算烧在 thinking 上，正文返回空，界面表现为「无任何输出」。
     */
    thinkDefault: false,
    keepAlive: str(env.KEEP_ALIVE, '30m'), // 本机独占时建议更久，避免每轮冷加载
    temperature: num(env.TEMPERATURE, 0.7),
    numCtx,
    numPredict,
    numPredictThinking,
    /** 首字节超时：模型挂死/冷加载过慢时给明确报错，而不是让用户对着空白页面干等 */
    firstTokenTimeoutMs: num(env.FIRST_TOKEN_TIMEOUT_MS, 120000),
    /** 流式空闲超时：相邻两块的最大间隔 */
    streamIdleTimeoutMs: num(env.STREAM_IDLE_TIMEOUT_MS, 60000),
    /** 启动时预热模型：本机冷启动可能几十秒，提前加载能明显改善首问体验 */
    warmup: bool(env.WARMUP, true),
  },

  context: {
    maxMessages: num(env.MAX_HISTORY_MESSAGES, 20),
    maxChars: contextChars,
    requestedChars,
    warning: contextCharsWarning,
  },

  defaultSystemPrompt:
    str(env.SYSTEM_PROMPT) ||
    '你是一名专业、耐心、有礼貌的中文智能客服助手。' +
    '请用简洁清晰的中文回答用户问题；遇到信息不足时先礼貌追问关键信息，' +
    '不要编造公司政策、价格、订单状态等事实性内容。' +
    '用户明确提供的信息（如姓名、订单号）必须准确记住，被问起时直接复述，不要反问用户。' +
    '当上下文中出现以 [天气数据·来自聚合数据实时接口] 开头的系统消息时，' +
    '其中的数字就是权威事实，你必须原样引用，不得改动、推算或补充任何未给出的数值。',

  weather: {
    enabled: Boolean(str(env.JUHE_WEATHER_KEY)),
    key: str(env.JUHE_WEATHER_KEY),
    apiUrl: str(env.WEATHER_API_URL, 'https://apis.juhe.cn/simpleWeather/query'),
    cacheTtlMs: num(env.WEATHER_CACHE_TTL_MS, 600000), // 普通会员仅 50 次/天，别调太小
    timeoutMs: num(env.WEATHER_TIMEOUT_MS, 15000), // 聚合数据偶发慢，8s 太紧
    // 用户说「我所在的城市 / 当地天气」又查不出城市时的兜底；留空则追问用户
    defaultCity: str(env.WEATHER_DEFAULT_CITY, ''),
  },

  tools: {
    /** 工具调用总开关。为 false 时 /api/chat 行为与未接入工具时完全一致 */
    enabled: bool(env.ENABLE_TOOLS, true),
    order: {
      /** 订单数据源 CSV。默认指向项目根目录的「快递信息.csv」 */
      dataFile: str(env.ORDER_DATA_FILE) || path.join(rootDir, '快递信息.csv'),
    },
  },

  security: {
    accessToken: str(env.ACCESS_TOKEN), // 为空则不校验
    rateLimitPerMin: num(env.RATE_LIMIT_PER_MIN, 60),
    corsOrigins: str(env.CORS_ORIGINS)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

/** 下发给前端的非敏感信息（绝不吐 AppKey） */
export function publicRuntimeInfo() {
  return {
    model: config.ollama.defaultModel,
    ollamaBaseUrl: config.ollama.baseUrl,
    numCtx: config.ollama.numCtx,
    numPredict: config.ollama.numPredict,
    maxHistoryMessages: config.context.maxMessages,
    maxContextChars: config.context.maxChars,
    weatherEnabled: config.weather.enabled,
    defaultSystemPrompt: config.defaultSystemPrompt,
  };
}
