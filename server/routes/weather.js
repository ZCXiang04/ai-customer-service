/**
 * 天气查询接口（供前端直接调用；对话链路里的天气走 chat.js 旁路）
 */
import { Router } from 'express';
import { config } from '../config.js';
import { queryWeather, getWeatherStats, WeatherError } from '../weather.js';
import { AppError } from '../util.js';
import { wrap } from '../middleware.js';

const router = Router();

// 必须用 wrap：Express 4 不捕获 async 路由里抛出的错误，
// 漏了它就会变成 unhandledRejection，响应挂死 → 客户端 fetch failed
router.get('/weather', wrap(async (req, res) => {
  if (!config.weather.enabled) {
    throw new AppError('天气服务未配置 JUHE_WEATHER_KEY', { status: 503, code: 'WEATHER_DISABLED' });
  }

  const city = String(req.query.city || '').trim();
  if (!city) throw new AppError('city 不能为空', { status: 400, code: 'EMPTY_CITY' });
  if (city.length > 20) throw new AppError('city 过长（上限 20 字）', { status: 400, code: 'CITY_TOO_LONG' });

  try {
    res.json(await queryWeather(city));
  } catch (err) {
    if (err instanceof WeatherError) {
      throw new AppError(err.message, { status: err.status, code: err.code });
    }
    throw err;
  }
}));

/** 观测用：上游请求次数、缓存命中次数（不含任何敏感信息） */
router.get('/weather/_stats', (_req, res) => {
  res.json(getWeatherStats());
});

export default router;
