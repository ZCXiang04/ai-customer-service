/**
 * 中间件：跨域 / 限流 / 鉴权 / 统一错误处理 / SSE 辅助
 */
import { config } from './config.js';
import { AppError, log } from './util.js';

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function originAllowed(origin) {
  if (!origin) return true; // 同源或 curl
  if (LOCAL_ORIGIN_RE.test(origin)) return true;
  return config.security.corsOrigins.includes(origin);
}

/** 跨域：默认放行 localhost / 127.0.0.1，其他来源需在 .env 的 CORS_ORIGINS 显式配置 */
export function cors(req, res, next) {
  const origin = req.headers.origin;
  if (originAllowed(origin)) {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
}

/** 单 IP 每分钟限流 */
export function rateLimit(req, res, next) {
  const limit = config.security.rateLimitPerMin;
  if (limit <= 0) return next();

  const key = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = rateLimit.buckets.get(key);

  if (!bucket || now - bucket.start > 60000) {
    rateLimit.buckets.set(key, { start: now, count: 1 });
    return next();
  }
  bucket.count++;
  if (bucket.count > limit) {
    return res.status(429).json({
      error: `请求过于频繁（每分钟上限 ${limit} 次）`,
      code: 'RATE_LIMITED',
    });
  }
  next();
}
rateLimit.buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimit.buckets) {
    if (now - v.start > 60000) rateLimit.buckets.delete(k);
  }
}, 60000).unref();

/** 可选访问口令：设置了 ACCESS_TOKEN 才生效 */
export function authGuard(req, res, next) {
  const token = config.security.accessToken;
  if (!token) return next();

  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : req.query?.token || '';
  if (provided !== token) {
    return res.status(401).json({ error: '未授权：口令错误或缺失', code: 'UNAUTHORIZED' });
  }
  next();
}

/** 异步路由包装，避免 try/catch 满天飞 */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err, req, res, _next) {
  const status = err instanceof AppError ? err.status : 500;
  const code = err instanceof AppError ? err.code : 'INTERNAL';
  const message = status === 500 ? '服务内部错误，请查看服务端日志' : err.message;

  if (status >= 500) {
    // 已过脱敏；这里仍不打印 req.url，避免查询串里带 token
    log.error(`[http] ${req.method} ${req.path} → ${err.message}`);
  }
  if (res.headersSent) {
    return res.end();
  }
  res.status(status).json({ error: message, code });
}

/**
 * SSE 初始化。
 * 注意 X-Accel-Buffering: no —— 反向代理会缓冲导致流式失效。
 */
export function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
}

/** SSE 心跳：本地 CPU 推理慢，加载/思考期间长时间无数据，代理或浏览器可能断开 */
export function sseKeepAlive(res, intervalMs = 15000) {
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, intervalMs);
  return () => clearInterval(timer);
}
