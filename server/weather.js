/**
 * 天气客户端：聚合数据 · 简易天气预报
 * https://apis.juhe.cn/simpleWeather/query
 *
 * 三条硬规则：
 *  1. AppKey 只存在于 .env 与服务端内存 —— 不进日志、不进异常文案、不下发前端
 *  2. 进程内缓存（默认 10 分钟）。普通会员仅 50 次/天，不做缓存一次演示就打光
 *  3. 任何异常统一抛 WeatherError，带可直接展示给用户的中文文案
 */
import { config } from './config.js';
import { log } from './util.js';

/** city -> { at, data } */
const cache = new Map();

/** 观测计数器（不含任何敏感信息），供缓存有效性测试与排查使用 */
export const weatherStats = { upstreamRequests: 0, cacheHits: 0 };

export class WeatherError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'WeatherError';
    this.code = code;
    this.status = status;
  }
}

/** error_code → 用户可读文案。绝不含 key、URL、原始响应体 */
const ERROR_TEXT = {
  207301: '城市名有误，请换个说法试试，比如「北京天气」',
  207302: '暂时查不到这个城市的天气',
  207303: '天气服务网络异常，请稍后重试',
  10001: '天气服务密钥无效，请联系管理员检查配置',
  10012: '今日天气查询次数已达上限，明天再来试试',
  10013: '天气服务测试额度已用完',
  10021: '天气接口已停用',
};

/** 归一化缓存键：去空白、去行政后缀 */
function cacheKey(city) {
  return String(city).trim().replace(/\s+/g, '').replace(/(市|县|区|镇)$/, '');
}

/** 归一化成固定形状（契约见 README「天气工具输出契约」） */
function normalize(city, result = {}) {
  const rt = result.realtime || {};
  const future = Array.isArray(result.future) ? result.future : [];

  const forecast = future.map((f) => {
    const [low = '', high = ''] = String(f.temperature || '').replace(/℃/g, '').split('/');
    return {
      date: f.date || '',
      low: String(low).trim(),
      high: String(high).trim(),
      weather: f.weather || '',
      direct: f.direct || '',
    };
  });

  return {
    ok: true,
    city,
    source: 'juhe.simpleWeather',
    cached: false,
    realtime: {
      weather: rt.info || '',
      temperature: String(rt.temperature ?? '').trim(),
      humidity: String(rt.humidity ?? '').trim(),
      direct: rt.direct || '',
      power: rt.power || '',
      aqi: String(rt.aqi ?? '').trim(),
    },
    forecast,
  };
}

/**
 * 查询天气。命中缓存直接返回，不消耗额度。
 * @returns {Promise<object>}
 * @throws {WeatherError}
 */
export async function queryWeather(rawCity) {
  if (!config.weather.enabled) {
    throw new WeatherError('NOT_CONFIGURED', '天气服务未配置 JUHE_WEATHER_KEY', 503);
  }

  const city = String(rawCity || '').trim();
  if (!city) throw new WeatherError('EMPTY_CITY', '城市名不能为空', 400);

  const key = cacheKey(city);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < config.weather.cacheTtlMs) {
    weatherStats.cacheHits++;
    return { ...hit.data, cached: true };
  }

  const url = `${config.weather.apiUrl}?${new URLSearchParams({ city, key: config.weather.key })}`;
  weatherStats.upstreamRequests++;

  let json;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(config.weather.timeoutMs),
    });
    json = await res.json();
  } catch (err) {
    // 绝不打 url / err.stack —— 里面带 key
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new WeatherError(
      timeout ? 'TIMEOUT' : 'NETWORK',
      timeout ? '天气服务响应超时，请稍后重试' : '天气服务网络异常，请稍后重试'
    );
  }

  if (json?.error_code !== 0) {
    const code = json?.error_code;
    throw new WeatherError(
      String(code),
      ERROR_TEXT[code] || '天气查询失败，请稍后重试',
      code === 207301 || code === 207302 ? 400 : 502
    );
  }

  const data = normalize(city, json.result || {});
  cache.set(key, { at: Date.now(), data });
  log.info(`[weather] 已请求聚合数据 city=${city} 温度=${data.realtime.temperature}℃`);
  return { ...data, cached: false };
}

/** 取指定天数的数据（实时返回 realtime） */
export function pickDayData(data, day = '实时') {
  const idx = day === '后天' ? 2 : day === '明天' ? 1 : day === '今天' ? 0 : -1;
  if (idx < 0) return { ...data.realtime, day };
  const f = (data.forecast || [])[idx];
  if (!f) return { ...data.realtime, day };
  return {
    day,
    weather: f.weather,
    high: f.high,
    low: f.low,
    direct: f.direct,
    date: f.date,
    // 今天/实时才带实时温度。明天、后天给实时温度会误导成「那天的当前温度」
    temperature: idx <= 0 ? data.realtime?.temperature || '' : '',
  };
}

/**
 * 渲染成注入模型的 system 文本。
 * 所有数字原样来自接口，并显式禁止模型改动 / 推算 / 补充。
 */
export function formatWeatherForModel(data, day = '实时') {
  const rt = data.realtime || {};
  const lines = [];
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
  const na = '暂无数据';

  lines.push(`[天气数据·来自聚合数据实时接口 ${stamp}]`);
  lines.push(`城市：${data.city}`);
  lines.push(
    `实时：${rt.weather || na} ${rt.temperature ? rt.temperature + '℃' : na}` +
      `  湿度：${rt.humidity ? rt.humidity + '%' : na}` +
      `  风向：${rt.direct || na}  风力：${rt.power || na}` +
      `  空气质量：${rt.aqi || na}`
  );

  const near = (data.forecast || []).slice(0, 3);
  if (near.length) {
    lines.push(
      '近三天：' +
        near
          .map((f) => {
            const short = String(f.date || '').slice(5);
            const temp = f.low && f.high ? `${f.low}~${f.high}℃` : na;
            return `${short} ${f.weather || na} ${temp}`;
          })
          .join(' / ')
    );
  }

  lines.push(`用户询问的是：${day}`);
  if (rt.temperature && day !== '后天' && day !== '明天') {
    lines.push(`回答第一行必须先给出实时温度「${rt.temperature}℃」这个数字，不得改动。`);
  }
  lines.push('以上为接口返回的真实数据，回答时严格引用，禁止改动、推算或补充任何未给出的数值。');
  lines.push(`接口未给出的数据一律回答「${na}」，不许估算。`);

  return lines.join('\n');
}

export function getWeatherStats() {
  return { ...weatherStats, cacheSize: cache.size, cacheTtlMs: config.weather.cacheTtlMs };
}

/** 仅测试/运维使用 */
export function clearWeatherCache() {
  cache.clear();
}
