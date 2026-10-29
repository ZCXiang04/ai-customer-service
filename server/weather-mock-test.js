/**
 * 天气模块自测（本地 mock，零额度消耗）：node server/weather-mock-test.js
 *
 * 起一个本地 HTTP 服务顶替聚合数据接口，覆盖：
 * 归一化、缓存、错误码映射、超时、非 JSON 响应、AppKey 零泄露、意图识别。
 */
import http from 'node:http';

const TEST_KEY = 'MOCK-KEY-DO-NOT-LEAK-9527';

let failures = 0;
function check(cond, label, extra = '') {
  if (cond) console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`);
  }
  return cond;
}

/* ── mock 上游：用 city 名控制返回行为 ── */
const upstreamCalls = [];

const MOCK = {
  北京: { error_code: 0, result: {
    realtime: { info: '晴', wid: '00', temperature: '29', humidity: '35', direct: '南风', power: '4-5级', aqi: '110' },
    future: [
      { date: '2026-09-18', temperature: '18/30℃', weather: '晴转多云', wid: { day: '00', night: '01' }, direct: '南风转北风' },
      { date: '2026-09-19', temperature: '17/29℃', weather: '多云', wid: { day: '01', night: '01' }, direct: '北风' },
      { date: '2026-09-20', temperature: '16/28℃', weather: '阴', wid: { day: '02', night: '02' }, direct: '东北风' },
    ],
  } },
  苏州: { error_code: 0, result: {
    realtime: { info: '阴', wid: '02', temperature: '4', humidity: '82', direct: '西北风', power: '3级', aqi: '' },
    future: [{ date: '2026-09-18', temperature: '1/7℃', weather: '小雨转多云', wid: {}, direct: '北风转西北风' }],
  } },
  错误301: { error_code: 207301, reason: '错误的查询城市名' },
  错误302: { error_code: 207302, reason: '查不到该城市' },
  错误10001: { error_code: 10001, reason: '错误的KEY' },
  错误10012: { error_code: 10012, reason: '请求超过次数限制' },
  错误10013: { error_code: 10013, reason: '测试KEY超过请求限制' },
  错误未知: { error_code: 999999, reason: '未定义错误' },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock.local');
  const city = url.searchParams.get('city') || '';
  const key = url.searchParams.get('key') || '';
  upstreamCalls.push({ city, key });

  if (city === '坏json') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<html><body>oops</body></html>');
  }
  if (city === '慢') {
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }, 3000);
    return;
  }
  const body = MOCK[city] || MOCK.北京;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${server.address().port}/query`;

/* ── 必须在 import config 之前设置，config 只在首次加载时读 env ── */
process.env.WEATHER_API_URL = mockUrl;
process.env.JUHE_WEATHER_KEY = TEST_KEY;
process.env.WEATHER_TIMEOUT_MS = '800';
process.env.WEATHER_CACHE_TTL_MS = '600000';

const { config } = await import('./config.js');
const { queryWeather, formatWeatherForModel, pickDayData, getWeatherStats, WeatherError } =
  await import('./weather.js');
const { detectWeatherIntent, dayIndex } = await import('./intent-weather.js');

(async () => {
  console.log('=== 天气模块自测（mock 上游，零额度）===\n');

  /* ── 1 归一化 ── */
  console.log('[1] 归一化输出');
  const r = await queryWeather('北京');
  check(r.ok === true, 'ok 为 true');
  check(r.city === '北京', 'city 原样返回');
  check(/^-?\d+$/.test(r.realtime.temperature), '实时温度是数字字符串', r.realtime.temperature);
  check(r.realtime.weather === '晴' && r.realtime.humidity === '35', '实时字段正确', `${r.realtime.weather} ${r.realtime.humidity}%`);
  check(Array.isArray(r.forecast) && r.forecast.length === 3, '预报为数组', `${r.forecast.length} 天`);
  check(r.forecast[0].low === '18' && r.forecast[0].high === '30', '预报温度拆分正确', `${r.forecast[0].low}~${r.forecast[0].high}`);
  check(r.cached === false, '首次查询未命中缓存');

  /* ── 2 缓存 ── */
  console.log('\n[2] 缓存');
  const before = upstreamCalls.length;
  const r2 = await queryWeather('北京市'); // 行政后缀应归一化到同一缓存键
  check(r2.cached === true, '带「市」后缀命中同一缓存');
  check(upstreamCalls.length === before, '上游未被再次请求', `${before} → ${upstreamCalls.length}`);

  /* ── 3 错误码映射 ── */
  console.log('\n[3] 错误码 → 中文文案');
  const cases = [
    ['错误301', 400, '城市名有误'],
    ['错误302', 400, '查不到'],
    ['错误10001', 502, '密钥无效'],
    ['错误10012', 502, '次数已达上限'],
    ['错误10013', 502, '测试额度'],
    ['错误未知', 502, '天气查询失败'],
  ];
  for (const [city, status, keyword] of cases) {
    try {
      await queryWeather(city);
      check(false, `${city} 应抛错`);
    } catch (err) {
      const ok = err instanceof WeatherError && err.status === status && err.message.includes(keyword);
      check(ok, `${city} → ${status} / 含「${keyword}」`, err.message);
    }
  }

  /* ── 4 异常路径 ── */
  console.log('\n[4] 异常路径');
  try {
    await queryWeather('坏json');
    check(false, '非 JSON 响应应抛错');
  } catch (err) {
    check(err.code === 'NETWORK', '非 JSON 响应 → NETWORK', err.message);
  }
  try {
    await queryWeather('慢');
    check(false, '超时应抛错');
  } catch (err) {
    check(err.code === 'TIMEOUT', '慢响应 → TIMEOUT', err.message);
  }
  try {
    await queryWeather('   ');
    check(false, '空城市应抛错');
  } catch (err) {
    check(err.code === 'EMPTY_CITY' && err.status === 400, '空城市 → 400', err.message);
  }

  /* ── 5 AppKey 零泄露 ── */
  console.log('\n[5] AppKey 零泄露');
  let leaked = false;
  for (const call of upstreamCalls) {
    if (call.key !== TEST_KEY) leaked = true;
  }
  check(!leaked, '上游只收到正确的 key（未被改写）');
  const errTexts = [];
  for (const city of ['错误301', '错误10001', '错误未知']) {
    try { await queryWeather(city); } catch (e) { errTexts.push(e.message, e.stack || ''); }
  }
  check(!errTexts.some((t) => t.includes(TEST_KEY)), '错误文案与堆栈不含 AppKey');
  check(!mockUrl.includes(TEST_KEY), 'mock 地址本身不含 AppKey');

  /* ── 6 未配置时静默关闭 ── */
  console.log('\n[6] 未配置 key');
  const savedEnabled = config.weather.enabled;
  config.weather.enabled = false;
  try {
    await queryWeather('北京');
    check(false, '未配置应抛错');
  } catch (err) {
    check(err.code === 'NOT_CONFIGURED' && err.status === 503, 'NOT_CONFIGURED / 503', err.message);
  }
  config.weather.enabled = savedEnabled;

  /* ── 7 注入模型的文本 ── */
  console.log('\n[7] 注入模型的 system 文本');
  const text = formatWeatherForModel(r, '实时');
  check(text.startsWith('[天气数据·来自聚合数据实时接口'), '带来源标记');
  check(text.includes('29℃') && text.includes('35%'), '原样引用接口数值');
  check(text.includes('禁止改动、推算或补充'), '含禁止编造约束');
  check(text.includes('暂无数据'), '含「暂无数据」指引');
  const aqiEmpty = {
    city: '苏州',
    realtime: MOCK.苏州.result.realtime, // aqi 为空串
    forecast: [{ date: '2026-09-18', low: '1', high: '7', weather: '小雨转多云', direct: '北风转西北风' }],
  };
  const t2 = formatWeatherForModel(aqiEmpty, '实时');
  check(t2.includes('空气质量：暂无数据'), 'AQI 为空 → 暂无数据，不估算');
  check(!t2.includes('110'), '不会串入其它城市的数值');

  /* ── 8 pickDayData ── */
  console.log('\n[8] 天数选择');
  check(pickDayData(r, '实时').temperature === '29', '实时 → realtime');
  check(pickDayData(r, '今天').weather === '晴转多云', '今天 → future[0]');
  check(pickDayData(r, '明天').weather === '多云', '明天 → future[1]');
  check(pickDayData(r, '后天').weather === '阴', '后天 → future[2]');
  check(dayIndex('明天') === 1 && dayIndex('实时') === -1, 'dayIndex 映射正确');

  /* ── 9 意图识别 ── */
  console.log('\n[9] 意图识别');
  const intentCases = [
    ['北京天气怎么样', '北京', '实时'],
    ['深圳明天下雨吗', '深圳', '明天'],
    ['苏州后天气温多少', '苏州', '后天'],
    ['北京今天多少度', '北京', '今天'],
    ['上海市南汇区现在天气', '上海', '实时'],
    ['广州湿度多少', '广州', '实时'],
    ['杭州空气质量', '杭州', '实时'],
    ['乌鲁木齐此刻气温', '乌鲁木齐', '实时'],
    ['天气怎么样', null, null],
    ['今天天气', null, null],
    ['帮我写个请假条', null, null],
    ['明天会下雪吗', null, null],
    ['今天天气很好', null, null],   // 陈述句不该触发查询
    ['这气温真不错', null, null],
    ['用户所在的城市今天天气如何', null, null],  // 兜底正则曾抠出「用户所在的城」
    ['我所在的城市天气如何', null, null],
    ['当地气温多少', null, null],
    ['帮我查下本地的天气', null, null],
  ];
  for (const [text_, city, day] of intentCases) {
    const got = detectWeatherIntent(text_);
    const ok = city === null
      ? (!got.hit || got.needCity)
      : (got.hit && got.city === city && got.day === day);
    check(ok, `"${text_}"`, city ? `→ ${got.city}/${got.day}` : '→ 追问城市');
  }

  /* ── 10 统计 ── */
  console.log('\n[10] 观测统计');
  const st = getWeatherStats();
  check(st.upstreamRequests > 0 && st.cacheHits >= 1, '统计可用', `上游 ${st.upstreamRequests} 次 / 缓存命中 ${st.cacheHits} 次`);

  server.close();
  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试异常：', err);
  server.close();
  process.exit(1);
});
