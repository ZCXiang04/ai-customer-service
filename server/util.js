/**
 * 公共工具：统一错误类型 + 带脱敏的日志
 *
 * 脱敏是硬要求：聚合数据 AppKey 一旦进日志/异常文案/响应体就算泄露。
 * 因此所有日志出口都必须过 sanitize()。
 */
import { config } from './config.js';

/** 带 HTTP 状态码的错误，路由层直接回给前端 */
export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL' } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

/** 把 AppKey 等敏感串换成 *** */
export function sanitize(input) {
  let text = typeof input === 'string' ? input : safeStringify(input);
  const key = config?.weather?.key;
  if (key) text = text.split(key).join('***');
  return text;
}

function safeStringify(v) {
  try {
    return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  } catch {
    return '[unserializable]';
  }
}

const ts = () => new Date().toISOString().slice(11, 23); // HH:mm:ss.mmm

export const log = {
  info(...args) {
    console.log(`[${ts()}]`, ...args.map(sanitize));
  },
  warn(...args) {
    console.warn(`[${ts()}] WARN`, ...args.map(sanitize));
  },
  error(...args) {
    console.error(`[${ts()}] ERROR`, ...args.map(sanitize));
  },
};

/** 截断长文本，避免把整段上下文打进日志 */
export function clip(text, max = 120) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) + `…(${s.length})` : s;
}
