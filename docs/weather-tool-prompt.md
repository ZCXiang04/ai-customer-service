# 天气查询小工具 · 实施提示词

> 用途：把下面 **A 段**整段复制给开发 Agent（或作为本项目的实施任务单）。
> **B 段**是运行时注入给大模型的系统提示词，别混用。

---

## A. 开发实施提示词（可直接复制执行）

### A1. 背景（已确认的现状，不要重新假设）

项目：仓库根目录（私有化 AI 客服）。

- Node 22 + Express 4 + better-sqlite3，ESM（`package.json` 有 `"type": "module"`），零构建，改完 `npm start` 直接生效。
- `server/config.js` 集中配置，自带极简 `.env` 加载器，新增配置项走同一套 `num()/env.XXX || default` 写法。
- `server/ollama.js` 的 `chatStream()` 是 async generator，产出 `{type:'thinking'|'content', text}`。
- `server/routes/chat.js` 是 SSE 对话主流程，现有事件：`meta` → `thinking`* / `delta`* → `done` 或 `error`；前端 `web/app.js` 第 423-437 行按 `evt.type` 分发。
- **两个已踩过的坑必须遵守**：① 请求 Ollama 固定传 `think:false`，否则 2b 模型正文为空；② 浏览器绝不直连任何第三方 API，一律走后端代理。
- 本地模型是 `qwen3.5:2b`（CPU 推理，约 5-6 token/s）。

### A2. 目标（唯一目标，不要扩大范围）

在本客服中新增**天气查询小工具**：用户说「北京天气怎么样」「深圳明天下雨吗」这类话时，服务端调用聚合数据实时天气接口拿到**真实数据**，再让本地模型基于该数据用自然语言回答。**模型不允许自己编造任何温度、天气、风力数值。**

范围是「能用、可信、省额度」，不做登录态、不做多工具框架、不做前端大改。

### A3. 接口契约（聚合数据 · 简易天气预报）

- 地址：`https://apis.juhe.cn/simpleWeather/query`
- 方式：GET（文档也支持 POST form），Header `Content-Type: application/x-www-form-urlencoded`
- 参数：`city`（城市名或城市 ID，需 utf8 urlencode）、`key`（AppKey）
- 成功判定：**`error_code === 0`**，数据在 `result`
- `result.realtime`：`info`（天气）、`wid`（天气标识）、`temperature`（℃）、`humidity`（%）、`direct`（风向）、`power`（风力）、`aqi`（可能为空字符串）
- `result.future`：**近 5 天**数组，`{date, temperature("1/7℃"), weather, wid:{day,night}, direct}`，索引 0 = 今天
- 常见错误码：`207301` 错误的查询城市名、`207302` 查不到该城市、`207303` 网络错误请重试、`10001` 错误的 KEY、`10012` 请求超过次数限制、`10013` 测试 KEY 超过请求限制、`10021` 接口停用

**额度红线**：普通会员 **50 次/天**。必须做缓存与限流，否则一次演示就把当天额度打光。

### A4. 实现步骤（按序做，每步可独立验证）

1. **配置**：`config.js` 增加 `weather: { enabled, key: env.JUHE_WEATHER_KEY || '', cacheTtlMs: num(env.WEATHER_CACHE_TTL_MS, 600000), timeoutMs: 8000 }`；`.env` 增加 `JUHE_WEATHER_KEY=`（留空即功能关闭）。**key 只允许出现在服务端与 `.env`**。
2. **客户端** `server/weather.js`：`fetch` + `AbortSignal.timeout`；URLSearchParams 编码；进程内 Map 缓存（key = 城市名，TTL 默认 10 分钟，命中不打日志以外的请求）；错误码 → 中文文案映射表；返回归一化对象（见 A5）。网络/超时异常统一抛 `WeatherError(code, message)`。
3. **路由** `server/routes/weather.js`：`GET /api/weather?city=xxx`。校空、长度 ≤ 20；未配置 key 时返回 `503 {error:'天气服务未配置 JUHE_WEATHER_KEY'}`；正常返回归一化 JSON。`server/index.js` 里 `app.use('/api', weatherRouter)` 挂载。
4. **意图识别** `server/intent-weather.js`（**用确定性规则，不要依赖 2b 模型做 function calling**）：
   - 命中意图：`/天气|气温|几度|多少度|下雨|下雪|刮风|湿度|空气质量|aqi/i`
   - 抽城市：优先匹配内置城市词典（34 省会 + 主要地级市，允许「北京」「北京市」「深圳市南山区」→ 取「北京」「深圳」）；词典未命中时兜底正则 `/([一-龥]{2,7}?)(?:市|县|区|镇)?(?:的)?(?:今天|明天|后天)?(?:的)?(?:天气|气温)/`
   - 抽时间：`今天→future[0]`、`明天→future[1]`、`后天→future[2]`；出现「现在/实时/此刻」或没时间词 → 用 `realtime`
   - **抽不到城市就追问，不许猜**：返回 `{needCity:true}`，由 chat 流程回一句「想查哪个城市的天气？」
5. **接入对话流** `server/routes/chat.js`：在 `addMessage` 之后、`chatStream` 之前插入天气分支。命中且取数成功时：
   - 先 `send({type:'tool', name:'weather', status:'running', args:{city, day}})`，取数后 `send({type:'tool', name:'weather', status:'done', data})`；失败发 `status:'error'` 并带上中文原因
   - 把归一化数据序列化成一段 `[天气数据·来自聚合数据实时接口]` 文本，作为**独立的 system 消息**追加进 `messages`（放在历史之后、当前用户提问之前），并在该段末尾写明「以上为接口返回的真实数据，必须严格据此回答，任何数字都不许改动或推算」
   - 取数失败时**不要**把错误塞给模型编答案，直接结束本次请求并回一句带原因的友好文案
6. **前端** `web/app.js`：在 `evt.type` 分发里新增 `tool` 分支（`status==='running'` 显示「正在查询天气…」，`done` 渲染一张小卡片：城市 / 天气 / 温度 / 风 / 湿度 / AQI，AQI 空则隐藏）。**不改现有 `meta/delta/done/error` 语义**，老客户端不升级也要能正常对话（未知事件忽略即可）。
7. **冒烟测试** `server/smoke-test.js` 追加用例（见 A7）。
8. **文档**：`README.md` 的接口表补 `GET /api/weather`，配置表补 `JUHE_WEATHER_KEY` / `WEATHER_CACHE_TTL_MS`。

### A5. 输出契约（合法 JSON，三处都必须是这个形状）

`/api/weather` 成功响应：

```json
{
  "ok": true,
  "city": "苏州",
  "source": "juhe.simpleWeather",
  "cached": false,
  "realtime": {
    "weather": "阴",
    "temperature": "4",
    "humidity": "82",
    "direct": "西北风",
    "power": "3级",
    "aqi": "80"
  },
  "forecast": [
    { "date": "2026-09-17", "low": "1", "high": "7", "weather": "小雨转多云", "direct": "北风转西北风" }
  ]
}
```

SSE `tool` 事件（行格式 `data: {...}\n\n`）：

```json
{ "type": "tool", "name": "weather", "status": "done", "args": { "city": "苏州", "day": "今天" }, "data": { "city": "苏州", "weather": "阴", "temperature": "4", "humidity": "82", "direct": "西北风", "power": "3级", "aqi": "80" } }
```

注入模型的 system 消息文本（示意，非 JSON）：

```
[天气数据·来自聚合数据实时接口 2026-09-17 16:41]
城市：苏州  天气：阴  温度：4℃  湿度：82%  风向：西北风  风力：3级  空气质量：80
近三天：09-17 小雨转多云 1~7℃ / 09-18 多云转阴 2~11℃ / 09-19 多云 6~12℃
以上为接口返回的真实数据，回答时严格引用，禁止改动、推算或补充任何未给出的数值。
```

### A6. 约束（硬性的，违反即返工）

1. **零编造**：模型侧任何温度/湿度/AQI/风力只能来自注入的接口数据；答案里出现的数字必须能在注入文本中找到。注入数据里没有的项（如 AQI 为空）就回答「暂无数据」，不许估。
2. **零泄露 + 省额度**：AppKey 只存在于 `.env` 与服务端内存，绝不出现在前端代码、SSE 事件、日志、错误文案里；同城市 10 分钟内复用缓存；未配置 key 时整个功能静默关闭，`/api/chat` 行为与今天完全一致。
3. **不破坏现有链路**：`think:false`、上下文裁剪、`keep_alive`、中断保护、用户主动停止时保留部分内容等现有逻辑一律不动；天气是**旁路增强**，取数失败要优雅降级（回一句提示），不能让 SSE 流挂死或 500。
4. **幂等/可测**：天气分支只在「命中意图且拿到城市」时触发；同一条消息不得重复请求接口。

### A7. 验收标准（必须能被程序自动判定）

> **主标准**：`node server/smoke-test.js` 全部用例 PASS，且满足以下三条硬性断言——
> ① `GET /api/weather?city=北京` 返回 HTTP 200 且 `body.ok === true`、`/^-?\d+$/.test(body.realtime.temperature)`；
> ② 向 `/api/chat` 发送「北京今天多少度」时，SSE 流中**必须出现** `type==='tool' && name==='weather' && status==='done'` 事件，且最终 `content` 中包含该事件 `data.temperature` 的原始字符串；
> ③ 连续两次相同城市查询，服务端日志中 Juhe 实际请求计数只 +1（缓存生效）。

补充断言（同样写进 smoke-test 或单独脚本）：

```js
// ① 归一化结果
const r = await (await fetch(BASE + '/api/weather?city=' + encodeURIComponent('北京'))).json();
assert(r.ok === true && /^-?\d+$/.test(r.realtime.temperature), '实时温度必须是数字字符串');

// ② 数字可溯源：正文里出现的温度必须来自接口
const { content, tools } = await chat({ message: '北京今天多少度' });
const w = tools.find((t) => t.type === 'tool' && t.name === 'weather' && t.status === 'done');
assert(w, '必须产出 weather 工具事件');
assert(content.includes(w.data.temperature), `正文必须原样引用接口温度 ${w.data.temperature}`);

// ③ 未知城市走追问，不调接口
const bad = await chat({ message: '天气怎么样' });
assert(/哪个城市/.test(bad.content) && !bad.tools.some((t) => t.name === 'weather'), '缺城市时必须追问且不发起查询');
```

未配置 `JUHE_WEATHER_KEY` 时，`/api/chat` 的现有 4 项冒烟用例必须照旧 PASS（功能静默关闭）。

---

## B. 运行时系统提示词（注入给 `qwen3.5:2b` 的工具说明）

> 使用方式：仅在命中天气意图、且成功拿到数据时，作为**追加的 system 消息**临时拼进 `messages`，不改动会话本身的 `system_prompt`。

```
你现在可以使用「天气查询」工具的数据。

规则：
1. 当用户的问题涉及天气、气温、下雨、湿度、空气质量时，必须先参考上下文中
   以 [天气数据·来自聚合数据实时接口] 开头的那一段。
2. 该段是权威事实。回答中的城市、天气、温度、湿度、风力、空气质量等所有数值，
   必须与那段完全一致，不得改动、四舍五入、换算或推算。
3. 那段里没有的信息（例如 AQI 显示为空、没有你要的那一天的预报），
   直接回答「暂无数据」，严禁自行估计或编造。
4. 除天气外的其它问题，按常规客服身份回答，不要主动提及本工具。
5. 用简洁口语化的中文回答，一到三句话，可给一句出行建议（建议属于常识发挥，
   但仍不得编造数值）。

示例：
用户：苏州今天天气怎么样？
助手：苏州今天阴，4℃，湿度 82%，西北风 3 级，空气质量指数 80。出门有点凉，建议带件外套。
```

---

## 备注：快速自检命令

```bash
# 1. 先看 key 是否配好（应有值，不要打印到聊天里）
grep -c JUHE_WEATHER_KEY .env

# 2. 单独验接口
curl -s "http://localhost:3000/api/weather?city=%E5%8C%97%E4%BA%AC"

# 3. 全量冒烟
node server/smoke-test.js
```
