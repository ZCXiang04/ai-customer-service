/**
 * 系统接口：健康检查、模型列表、运行时配置、运行状态
 */
import { Router } from 'express';
import { config, publicRuntimeInfo } from '../config.js';
import { health, listModels, listRunning } from '../ollama.js';
import { stats as dbStats } from '../db.js';
import { getWeatherStats } from '../weather.js';
import { listTools } from '../tools/index.js';

const router = Router();

/** 健康检查：Ollama 是否可达 + 模型是否齐全 */
router.get('/health', async (req, res) => {
  try {
    const { version, models } = await health();
    res.json({
      ok: true,
      ollama: config.ollama.baseUrl,
      version,
      model: config.ollama.defaultModel,
      models: models.map((m) => m.name),
      weatherEnabled: config.weather.enabled,
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      ollama: config.ollama.baseUrl,
      error: err.message,
      hint: `无法连接 Ollama。请确认服务已启动，且 OLLAMA_BASE_URL（当前 ${config.ollama.baseUrl}）指向的是 Ollama API 本体，而不是某个 Web UI 端口。`,
    });
  }
});

router.get('/models', async (_req, res) => {
  try {
    res.json({ models: await listModels(), defaultModel: config.ollama.defaultModel });
  } catch (err) {
    res.status(503).json({ error: err.message, models: [] });
  }
});

/** 给前端下发的运行时配置（绝不吐 AppKey） */
router.get('/config', (_req, res) => {
  res.json({
    ...publicRuntimeInfo(),
    toolsEnabled: config.tools.enabled,
    tools: config.tools.enabled ? listTools() : [],
  });
});

/** 运行状态：数据库统计、已加载模型、天气缓存 */
router.get('/status', async (_req, res) => {
  const running = await listRunning();
  res.json({
    db: dbStats(),
    running: running.map((m) => ({
      name: m.name,
      sizeVram: m.size_vram,
      contextLength: m.context_length,
    })),
    weather: getWeatherStats(),
    context: {
      maxChars: config.context.maxChars,
      requestedChars: config.context.requestedChars,
      warning: config.context.warning,
    },
  });
});

export default router;
