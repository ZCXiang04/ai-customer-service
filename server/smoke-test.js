/**
 * 端到端冒烟测试：node server/smoke-test.js
 *
 * 前提：服务已启动（npm start）。
 * 额度提示：真实天气用例只用「北京」一个城市，10 分钟缓存内只消耗 1 次。
 *          日常回归优先跑 `npm run test:weather`（本地 mock，零额度）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';

/** 从 .env 读 AppKey，用于「响应中不得出现 AppKey」的泄露扫描 */
const LOCAL_KEY = (() => {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const m = fs.readFileSync(path.join(root, '.env'), 'utf8')
      .match(/^\s*JUHE_WEATHER_KEY\s*=\s*(.*)$/m);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
})();

let failures = 0;
const line = (s = '') => console.log(s);

function check(cond, label, extra = '') {
  if (cond) {
    console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`);
  }
  return cond;
}

/** 发一次对话，收集 SSE 事件 */
async function chat(payload) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const out = { meta: null, content: '', thinking: '', tools: [], done: null, error: null, raw: '' };
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    out.raw += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const l = raw.split('\n').find((x) => x.startsWith('data:'));
      if (!l) continue;
      const data = l.slice(5).trim();
      if (!data) continue;
      let e;
      try { e = JSON.parse(data); } catch { continue; }
      if (e.type === 'meta') out.meta = e;
      else if (e.type === 'thinking') out.thinking += e.text;
      else if (e.type === 'delta') out.content += e.text;
      else if (e.type === 'tool') out.tools.push(e);
      else if (e.type === 'done') out.done = e;
      else if (e.type === 'error') out.error = e;
    }
  }
  return out;
}

const getJson = async (p) => (await fetch(`${BASE}${p}`)).json();

(async () => {
  line('=== AI 智能客服 · 端到端冒烟测试 ===');
  line(`目标：${BASE}\n`);

  /* ── 1 健康检查 ── */
  line('[1] 健康检查');
  const health = await getJson('/api/health');
  check(health.ok === true, '服务与 Ollama 连通', `v${health.version}`);
  check(Array.isArray(health.models) && health.models.length > 0, '模型列表非空', (health.models || []).join('、'));
  const conf = await getJson('/api/config');
  check(typeof conf.defaultSystemPrompt === 'string' && conf.defaultSystemPrompt.length > 0, '默认提示词可读');
  check(!('key' in conf), '运行时配置不吐任何密钥字段');

  /* ── 2 静态资源 ── */
  line('\n[2] 静态资源');
  for (const p of ['/', '/app.js', '/style.css']) {
    const r = await fetch(`${BASE}${p}`);
    check(r.ok, `GET ${p}`, `HTTP ${r.status}`);
  }

  /* ── 3 基础对话（流式）── */
  line('\n[3] 基础对话');
  const r1 = await chat({ message: '用一句话介绍你自己' });
  check(r1.meta !== null, '收到 meta 事件');
  check(r1.content.trim().length > 0, '流式正文非空', r1.content.slice(0, 60).replace(/\n/g, ' '));
  const sid = r1.meta?.sessionId;

  /* ── 4 多轮记忆 ── */
  line('\n[4] 连续对话记忆');
  await chat({ sessionId: sid, message: '我叫李雷，订单号 B2024，请记住。' });
  await chat({ sessionId: sid, message: '今天天气不错' }); // 插入无关一轮，避免模型顺势接话
  const r3 = await chat({ sessionId: sid, message: '我叫什么名字？我的订单号是多少？只回答这两项。' });
  check(r3.content.includes('李雷'), '记住姓名', r3.content.slice(0, 60).replace(/\n/g, ' '));
  check(/B\s*2024/i.test(r3.content), '记住订单号');

  /* ── 5 消息落库 ── */
  line('\n[5] 消息持久化');
  const detail = await getJson(`/api/sessions/${sid}`);
  check((detail.messages || []).length >= 6, '消息已落库', `${(detail.messages || []).length} 条`);
  check(detail.messages.some((m) => m.role === 'user'), '含用户消息');
  check(detail.messages.some((m) => m.role === 'assistant' && m.content), '含助手回复');

  /* ── 6 会话 CRUD ── */
  line('\n[6] 会话管理');
  const created = await (
    await fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '冒烟会话', model: health.model }),
    })
  ).json();
  const cid = created.session?.id;
  check(Boolean(cid), '创建会话');
  const patched = await (
    await fetch(`${BASE}/api/sessions/${cid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '改过的名字', systemPrompt: '你只说文言文。' }),
    })
  ).json();
  check(patched.session?.title === '改过的名字', '重命名');
  check(patched.session?.systemPrompt === '你只说文言文。', '写入自定义提示词');
  const cleared = await (
    await fetch(`${BASE}/api/sessions/${cid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: '' }),
    })
  ).json();
  check(cleared.session?.systemPrompt === '', '空串恢复默认提示词');
  const delRes = await fetch(`${BASE}/api/sessions/${cid}`, { method: 'DELETE' });
  check(delRes.ok, '删除会话');

  /* ── 7 自定义提示词生效 ── */
  line('\n[7] 会话级提示词覆盖默认');
  const pSess = await (
    await fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '提示词用例', systemPrompt: '你是一名翻译，用户说中文你译英文，只输出译文。' }),
    })
  ).json();
  // 注意：别用「今天天气很好」这类句子，它会命中天气意图
  const pr = await chat({ sessionId: pSess.session.id, message: '请把「你好」翻译成英文' });
  check(!/[一-龥]/.test(pr.content), '自定义提示词生效（译文不含中文）', pr.content.slice(0, 60).replace(/\n/g, ' '));
  await fetch(`${BASE}/api/sessions/${pSess.session.id}`, { method: 'DELETE' });

  /* ── 8~11 天气（未配置则整组跳过）── */
  const weatherOn = Boolean(health.weatherEnabled);
  line(`\n[8-11] 天气工具（${weatherOn ? '已启用' : '未配置，整组跳过'}）`);

  if (weatherOn) {
    const wr = await fetch(`${BASE}/api/weather?city=${encodeURIComponent('北京')}`);
    const wj = await wr.json();
    check(wr.status === 200 && wj.ok === true, 'GET /api/weather 返回 200 且 ok', `HTTP ${wr.status}`);
    check(/^-?\d+$/.test(String(wj.realtime?.temperature ?? '')), '实时温度是数字字符串', wj.realtime?.temperature);

    const stats0 = (await getJson('/api/weather/_stats')).upstreamRequests;
    const wc = await chat({ message: '北京今天多少度？' });
    const tool = wc.tools.find((t) => t.type === 'tool' && t.name === 'weather' && t.status === 'done');
    check(Boolean(tool), 'SSE 出现 weather/工具完成事件');
    check(
      Boolean(tool) && wc.content.includes(String(tool.data.temperature)),
      '正文原样引用接口温度',
      tool ? `接口 ${tool.data.temperature} / 正文：${wc.content.slice(0, 50).replace(/\n/g, ' ')}` : ''
    );

    const wr2 = await fetch(`${BASE}/api/weather?city=${encodeURIComponent('北京市')}`);
    const wj2 = await wr2.json();
    const stats1 = (await getJson('/api/weather/_stats')).upstreamRequests;
    check(wj2.cached === true && stats1 === stats0, '同城市复用缓存，上游计数未增加', `${stats0} → ${stats1}`);

    const ask = await chat({ message: '天气怎么样？' });
    check(/哪个城市/.test(ask.content), '缺城市时追问', ask.content.slice(0, 40).replace(/\n/g, ' '));
    check(!ask.tools.some((t) => t.name === 'weather' && t.status === 'done'), '缺城市时不发起查询');

    // 零泄露：任何响应体都不得出现 AppKey
    const key = process.env.JUHE_WEATHER_KEY || LOCAL_KEY;
    if (key) {
      const leaky = [JSON.stringify(wj), JSON.stringify(wc.done || {}), wc.raw].filter((s) => s.includes(key));
      check(leaky.length === 0, '响应与 SSE 流中不含 AppKey');
    } else {
      line('  SKIP  AppKey 零泄露扫描（环境变量未提供 key）');
    }
  }

  /* ── 12 参数校验 ── */
  line('\n[12] 参数校验');
  const bad = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '   ' }),
  });
  check(bad.status === 400, '空消息返回 400', `HTTP ${bad.status}`);
  const badCity = await fetch(`${BASE}/api/weather?city=`);
  check([400, 503].includes(badCity.status), '空城市返回 400/503', `HTTP ${badCity.status}`);

  // 清理
  if (sid) await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' });

  line(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n测试异常终止：', err.message);
  console.error('请确认服务已启动：npm start\n');
  process.exit(1);
});
