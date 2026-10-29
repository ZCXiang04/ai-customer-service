/**
 * 服务入口：浏览器 → 本服务(BFF) → Ollama
 *
 * 浏览器绝不直连 Ollama：既会暴露私有地址，也有 CORS 问题，
 * 与「数据不出内网」的初衷相悖。
 */
import express from 'express';
import { config } from './config.js';
import { log } from './util.js';
import { cors, rateLimit, authGuard, errorHandler } from './middleware.js';
import { health, warmup } from './ollama.js';
import chatRouter from './routes/chat.js';
import sessionsRouter from './routes/sessions.js';
import weatherRouter from './routes/weather.js';
import systemRouter from './routes/system.js';

const app = express();
app.set('trust proxy', true);

app.use(cors);
app.use(express.json({ limit: '2mb' }));

app.use('/api', rateLimit, authGuard);
app.use('/api', systemRouter);
app.use('/api', chatRouter);
app.use('/api', sessionsRouter);
app.use('/api', weatherRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在', code: 'NOT_FOUND' }));

app.use(express.static(config.webDir));
app.use(errorHandler);

/* 兜底：单个请求的异常不能带走整个进程 */
process.on('unhandledRejection', (err) => log.error('[unhandledRejection]', err?.message || err));
process.on('uncaughtException', (err) => log.error('[uncaughtException]', err?.message || err));

const server = app.listen(config.port, () => {
  log.info(`\n  AI 智能客服已启动  →  http://localhost:${config.port}`);
  log.info(`  Ollama            →  ${config.ollama.baseUrl}`);
  log.info(`  默认模型          →  ${config.ollama.defaultModel}`);
  log.info(
    `  上下文预算        →  ${config.context.maxChars} 字 / ${config.context.maxMessages} 条` +
      `（num_ctx=${config.ollama.numCtx}, num_predict=${config.ollama.numPredict}）`
  );
  log.info(`  天气工具          →  ${config.weather.enabled ? '已启用' : '未配置（静默关闭）'}`);
  if (config.weather.enabled) log.info(`  天气缓存          →  ${config.weather.cacheTtlMs / 1000}s`);
  if (config.context.warning) log.warn(`  ⚠ ${config.context.warning}`);
  if (config.security.accessToken) log.info('  访问口令          →  已启用');
  console.log('');

  // 异步自检与预热，不阻塞服务启动
  (async () => {
    try {
      const { version, models } = await health();
      log.info(`  Ollama ${version} 已连接，可用模型：${models.map((m) => m.name).join('、')}`);
      if (config.ollama.warmup) await warmup(config.ollama.defaultModel);
    } catch (err) {
      log.warn(`  ⚠ 启动自检失败：${err.message}`);
    }
  })();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info(`收到 ${sig}，正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

export { app };
