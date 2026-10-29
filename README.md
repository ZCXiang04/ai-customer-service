# AI 智能客服（私有化部署）

浏览器 → Node BFF → 本地 Ollama，会话落 SQLite。模型与数据全程不出本机。

**当前配置**：Ollama `http://127.0.0.1:11434`（v0.34.1），模型 `qwen3.5:2b`。

## 特性

- **私有化**：模型与会话数据全程留在本机，浏览器不直连 Ollama，前端零第三方 CDN 依赖。
- **流式对话**：SSE 增量输出，可随时中断且保留已生成内容。
- **连续会话**：SQLite 持久化 + 多会话管理，支持会话级 system prompt。
- **工具调用**：Ollama 原生 Function Calling（订单查询）+ 确定性规则旁路（天气 / 订单意图）。
- **工程细节**：上下文条数与字符双上限裁剪、双超时保护、密钥脱敏日志、启动时模型预热。

## 技术栈

Node 18+ / Express 4 / better-sqlite3 / Ollama + qwen3.5:2b / 原生 JS SPA（零构建、零第三方前端依赖）

---

## 快速开始

前置条件：**Node >= 20**，本机已装好 [Ollama](https://ollama.com) 且能访问 `http://127.0.0.1:11434`。

```bash
ollama pull qwen3.5:2b   # 仅首次；也可换成任意其它模型

cp .env.example .env     # 仅首次；不配也能直接跑，全部走内置默认值
npm install              # 仅首次
npm start                # 启动，打开 http://localhost:3000
```

想启用天气工具，在 `.env` 里填 `JUHE_WEATHER_KEY`（聚合数据 AppKey）；留空则天气功能静默关闭，其余功能不受影响。

改完服务端代码直接 `npm start` 重启即可，零构建步骤。

---

## 架构

```
┌─────────────┐        ┌──────────────────┐        ┌──────────────────┐
│  浏览器 SPA  │  HTTP  │  Node BFF :3000  │  HTTP  │  Ollama :11434   │
│  web/       │ ─────► │  server/         │ ─────► │  qwen3.5:2b      │
│  零外部依赖  │ ◄───── │  + SQLite 持久化  │ ◄───── │  本机推理         │
└─────────────┘  SSE   └──────────────────┘  NDJSON └──────────────────┘
                              │
                              └─► 聚合数据天气 API（可选，服务端调用）
```

**浏览器绝不直连 Ollama**：既会暴露私有地址，也有 CORS 问题，与「数据不出本机」的初衷相悖。

---

## 目录结构

```
server/
  config.js            集中配置 + 极简 .env 加载器
  util.js              统一错误类型 + 带 AppKey 脱敏的日志
  db.js                SQLite：sessions / messages，缺列自动迁移
  context.js           上下文裁剪：条数 + 字符双上限，工具数据独立注入
  ollama.js            Ollama 客户端：think:false、num_ctx、双超时、预热、tools 透传
  middleware.js        跨域 / 限流 / 鉴权 / 错误处理 / SSE 辅助
  weather.js           聚合数据天气客户端：缓存、错误码映射、防编造文本
  intent-weather.js    天气意图识别（确定性规则，约 300 城词典）
  intent-order.js      订单意图识别（手机号 / 已知姓名），旁路保底
  tools/
    index.js           工具注册中心：getToolSchemas() / executeTool()
    order.js           订单查询工具：CSV/XLSX 自动识别 + 按单号/手机号/姓名查询
  routes/
    chat.js            POST /api/chat（SSE 流式主流程 + 工具调用循环）
    sessions.js        会话 CRUD + 会话级提示词
    weather.js         GET /api/weather
    system.js          health / models / config / status
  smoke-test.js        端到端冒烟测试
  weather-mock-test.js 天气模块自测（本地 mock，零额度）
  order-test.js        订单工具自测（纯本地，零额度）
  inspect-context.js   打印某会话真实送给模型的上下文
web/
  index.html / style.css / app.js    零第三方依赖
```

---

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | Ollama 连通性、版本、模型列表 |
| GET | `/api/models` | 可用模型 |
| GET | `/api/config` | 运行时配置（不含任何密钥） |
| GET | `/api/status` | 数据库统计、已加载模型、天气缓存 |
| POST | `/api/chat` | SSE 流式对话，body `{sessionId?, message, model?, think?, systemPrompt?}` |
| GET | `/api/sessions` | 会话列表 |
| GET | `/api/sessions/:id` | 会话详情（含全部消息） |
| POST | `/api/sessions` | 新建会话 |
| PATCH | `/api/sessions/:id` | 改标题 / 模型 / 提示词（`systemPrompt:''` 恢复默认） |
| DELETE | `/api/sessions/:id` | 删除会话 |
| GET | `/api/weather?city=北京` | 天气查询（未配置 AppKey 时 503） |
| GET | `/api/weather/_stats` | 上游请求次数、缓存命中次数 |

### SSE 事件序列

```
meta → [tool(<name>, running|done|error)] → thinking* / delta* → done | error
```

- `meta`：`sessionId`、`model`、`trimmed`（被裁剪的历史条数）、`promptTokens`、`toolsUsed`
- `tool`：`{tool:<name>, name:<name>, status, args, data}`，失败时带 `error`。
  `weather` 与 `query_order` 均走**确定性规则旁路**（服务端识别意图后直接查，稳定可控）；`query_order` 同时保留原生工具调用能力（模型也可主动调用）。
- `thinking` / `delta`：流式增量，深度思考模式下才有 thinking
- `done`：`messageId`、`content`、`stats`、`tokensPerSecond`、`aborted`、`toolsUsed`
- `error`：`{error}`

未知事件应被忽略 —— 老客户端不升级也能正常对话。

---

## 配置（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | **必须是 Ollama 的 API 端口**。桌面版 Web 界面是另一个端口（形如 5xxxx），填错时 `/api/chat` 返回 HTML，表现为「流式解析失败、无输出」 |
| `DEFAULT_MODEL` | `qwen3.5:2b` | 默认模型 |
| `PORT` | `3000` | 服务端口 |
| `NUM_CTX` | `4096` | 上下文窗口，同时装提示词与输出，装不下会**静默截断** |
| `NUM_PREDICT` | `768` | 单次生成上限 |
| `NUM_PREDICT_THINKING` | `1536` | 深度思考模式下的生成上限 |
| `MAX_HISTORY_MESSAGES` | `20` | 携带的历史条数 |
| `MAX_CONTEXT_CHARS` | `12000` | 历史字符上限，会被自动收敛到 `NUM_CTX` 装得下的量 |
| `TEMPERATURE` | `0.7` | 采样温度 |
| `KEEP_ALIVE` | `30m` | 模型驻留时长，避免每轮冷加载 |
| `FIRST_TOKEN_TIMEOUT_MS` | `120000` | 首字节超时（含冷加载） |
| `STREAM_IDLE_TIMEOUT_MS` | `60000` | 流式相邻两块的最大间隔 |
| `WARMUP` | `true` | 启动时预热模型 |
| `ACCESS_TOKEN` | 空 | 访问口令，留空不校验 |
| `RATE_LIMIT_PER_MIN` | `60` | 单 IP 每分钟请求数 |
| `CORS_ORIGINS` | 空 | 额外跨域白名单（localhost 默认放行） |
| `JUHE_WEATHER_KEY` | 空 | 聚合数据天气 AppKey，**留空则天气功能静默关闭** |
| `WEATHER_CACHE_TTL_MS` | `600000` | 天气缓存时长。普通会员仅 50 次/天，别调太小 |
| `WEATHER_DEFAULT_CITY` | 空 | 用户说「我所在的城市/当地天气」时按此城市查询；留空则追问 |
| `ENABLE_TOOLS` | `true` | 工具调用总开关。置 `false` 时 `/api/chat` 行为与未接入工具时完全一致 |
| `ORDER_DATA_FILE` | `<项目根>/快递信息.csv` | 订单数据源路径，内容可为 CSV 或 XLSX（自动识别） |

---

## 关键实现说明

1. **`think: false` 必须显式传。** qwen3.5 默认开启思考模式，会把整个 token 预算烧在 thinking 上、正文返回空 —— 界面表现就是「模型没输出」。只有用户勾选「深度思考」时才置为 true。

2. **`num_ctx` 必须显式传。** Ollama 默认只给 4096，超出会静默截断，连 system prompt 都可能被丢掉，且不给任何报错。
   因此输入侧会主动给输出留位：`可用字符 ≈ (num_ctx − num_predict − 64) × 1.4 × 0.85`，超配时启动时打一条警告。

3. **双超时保护。** 首字节超时（等冷加载）+ 流式空闲超时。模型挂死时前端会收到明确的中文报错，而不是对着空白页面干等。

4. **Node 22 的 `Response.body` 只有 `getReader()`**，没有 `read()`。用错会直接挂死在流读取上。

5. **提前结束的路径也发 delta。** 追问、天气取数失败这类分支，除 `done` 外必须先发一条 `delta`，否则只认 delta 的客户端会看到一片空白。

6. **用户中断保留已生成内容。** 点「停止」后部分回复仍会落库，不丢上下文。

7. **前端零第三方依赖。** Markdown 渲染、代码着色、SSE 解析全部自研。不引 CDN —— 私有化场景本就不该外链第三方资源，也能在离线/内网环境正常工作。

8. **后端自动寻址。** 页面可能被静态托管（源里没有 `/api`），启动时会依次探测 `?api=` 参数 → localStorage → 页面同源 → `<主机>:3000` → `127.0.0.1:3000` → `localhost:3000`。判定标准很严格：必须返回 JSON 且带 `ollama` 字段。找不到时每 10 秒自动重连。

9. **启动时预热模型。** 本机 CPU 冷加载可能十几秒，预热后首次提问不用干等。

---

## 天气工具

命中「天气 / 气温 / 几度 / 下雨 / 下雪 / 湿度 / 空气质量」等词，且能从约 300 城词典中抽出城市时触发；抽不到城市就追问，绝不猜测。

**防编造**：接口数据以独立 system 消息注入（位于历史之后、当前提问之前），末尾强制声明「严格引用，禁止改动、推算或补充任何未给出的数值」；接口没给的项回答「暂无数据」。取数失败时不会把错误丢给模型编答案，而是直接回带原因的友好文案。

**省额度**：同城市结果默认缓存 10 分钟；AppKey 只存在于 `.env` 与服务端内存，绝不进日志、异常文案、SSE 事件与响应体。

### 输出契约

```jsonc
// GET /api/weather?city=苏州
{
  "ok": true, "city": "苏州", "source": "juhe.simpleWeather", "cached": false,
  "realtime": { "weather": "阴", "temperature": "4", "humidity": "82",
                "direct": "西北风", "power": "3级", "aqi": "" },
  "forecast": [ { "date": "2026-09-18", "low": "1", "high": "7",
                  "weather": "小雨转多云", "direct": "北风转西北风" } ]
}
```

---

## 测试

```bash
npm run test:order     # 订单工具自测，纯本地 CSV/XLSX，零额度消耗
npm run test:weather   # 天气模块自测，本地 mock 顶替上游，零额度消耗
npm test               # 端到端冒烟测试（会真实调用天气接口，北京一个城市，缓存期内只算 1 次）
npm run inspect <id>   # 打印某会话真实送给模型的上下文
```

日常回归**优先跑 `test:order` / `test:weather`**：都不消耗外部额度，且覆盖的断言更全。

---

## 工具调用（Tool Calling）

系统支持 **Ollama 原生工具调用**：模型决定是否调用工具，BFF 执行后再把结果喂回模型生成最终回答。后端采用「注册中心」模式，新增工具只需两步：

1. 在 `server/tools/` 下新建一个模块，导出 `run(args) → { ok, summary, data }`（`summary` 喂给模型，`data` 给前端渲染卡片）。
2. 在 `server/tools/index.js` 的 `REGISTRY` 里登记：`name` / `description` / `parameters`(JSON Schema) / `run`。

`chat.js` 会在请求模型时把 `getToolSchemas()` 挂到 `tools` 字段；模型返回 `tool_calls` 后逐个 `executeTool()`，把 `assistant(tool_calls) + tool(result)` 拼回上下文，再发起一次不带 `tools` 的请求生成最终回答。

### 订单查询工具 `query_order`

数据源为项目根目录的 `快递信息.csv`（后缀是 csv，但内容**可以是 Excel(xlsx) 也能是 CSV**，服务启动时会自动识别文件头选择解析器，无需手工转格式）。列：顺序id、姓名、用户手机号、居住城市、快递单号、购买物品、订单状态。

支持三种入参（任一即可，非必填）：
- `order_no`：支持**快递单号**（如 `SF133052943974`）或**顺序id**；大小写/空格容错；用户只给后 8 位时按后缀匹配。
- `phone`：**收件人手机号**（如 `13265525189`，容忍空格/连字符）。
- `name`：**收件人姓名**（如 `吕静`）；姓名可能命中多条，统一以列表返回。

触发方式（双保险）：
1. **确定性旁路**：`intent-order.js` 在用户消息里识别出手机号或已知姓名时，由服务端直接查询并注入结果，保证「凭手机号/姓名查」稳定可用（模型对纯姓名查询的 tool calling 触发不稳定）。
2. **原生工具调用**：订单号查询、或复杂追问仍走 `tools` 协议，由模型自行决定。

- 命中：返回收件人、手机号、城市、物品、订单状态等真实数据，模型据此作答，**绝不编造**数据里没有的字段（如物流轨迹、价格）。
- 未命中：返回友好提示，请用户确认线索 —— 前端显示「未找到订单」卡片，而非报错。
- 同名/同号多条：前端以多张卡片列出，并标注「共 N 条」。
- **隐私**：手机号在「喂给模型的摘要」中保持完整（模型需据此回答），但**前端卡片默认脱敏显示**（前 3 + `****` + 后 4）。如需显示完整号码，去掉 `web/app.js` 中 `maskPhone` 的脱敏即可。

---

## 常见问题

**页面显示「后端不可用」**
先在浏览器直接访问 `http://localhost:3000/api/health`。若那里正常，说明页面是从别的源（编辑器预览 / 静态托管）打开的，那种源里没有 `/api`；请改用 `http://localhost:3000` 打开，或让前端自动寻址生效。

**模型没有任何输出**
先确认 `OLLAMA_BASE_URL` 指向的是 Ollama API 本体（默认 11434）而不是桌面版 Web 界面端口。端口填错时响应是 HTML，会表现为流式解析失败。可用 `curl http://127.0.0.1:11434/api/version` 验证。

**回复很慢**
本机是 CPU 推理（`size_vram: 0`），约 5~7 token/s。想提速需要让 Ollama 跑在 GPU 上，或换更小的模型。界面右下角会显示本次的 tok/s。

**上下文「记不住」**
`MAX_CONTEXT_CHARS` 会被 `NUM_CTX` 收敛。想放更长历史，需同时调大 `NUM_CTX`（代价是内存与加载时间）。

---

## 安全提醒

- 若把服务暴露到内网以外，务必设置 `ACCESS_TOKEN`，并按需收紧 `CORS_ORIGINS`。
- `JUHE_WEATHER_KEY` 属于密钥，不要提交到代码仓库。`.env` 已在 `.gitignore` 中，仓库只提供 `.env.example`。
- 历史实现备份放在 `.archive/`（已在 `.gitignore` 中，不进仓库），确认无需回滚后可删除。

---

## 示例数据

`快递信息.csv` 由 `generate_express_data.py` 生成的 100 条**虚构**订单数据（姓名 / 手机号 / 单号均为随机生成），仅用于演示订单查询工具。需要重新生成：

```bash
python generate_express_data.py
```

---

## 开源协议

[MIT](LICENSE) © 2026 ZCXiang04
