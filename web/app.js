/**
 * 前端单页 —— 零第三方依赖
 *
 * Markdown 渲染、代码着色、流式解析全部自研：
 * 不引任何 CDN，一方面避免离线/内网环境加载失败，
 * 另一方面「数据不出内网」的私有化场景下本就不该外链第三方资源。
 *
 * 后端寻址：页面可能被静态托管（源里没有 /api），因此启动时会依次探测候选地址，
 * 判定标准很严格 —— 必须返回 JSON 且带 ollama 字段，否则视为不是后端。
 */
(function () {
  'use strict';

  /* ── 元素 ─────────────────────────────────────────── */
  const $ = (id) => document.getElementById(id);
  const els = {
    sidebar: $('sidebar'), sessionList: $('sessionList'), newChatBtn: $('newChatBtn'),
    status: $('status'), menuBtn: $('menuBtn'), scrim: $('scrim'),
    chatTitle: $('chatTitle'), chatSubtitle: $('chatSubtitle'),
    modelSelect: $('modelSelect'), thinkToggle: $('thinkToggle'),
    promptBtn: $('promptBtn'), promptDot: $('promptDot'),
    banner: $('banner'), bannerText: $('bannerText'), bannerRetry: $('bannerRetry'),
    bannerClose: $('bannerClose'),
    messages: $('messages'), input: $('input'), sendBtn: $('sendBtn'), stopBtn: $('stopBtn'),
    hint: $('hint'),
    promptModal: $('promptModal'), promptClose: $('promptClose'), promptInput: $('promptInput'),
    promptSave: $('promptSave'), promptCancel: $('promptCancel'), promptReset: $('promptReset'),
    presets: $('presets'), defaultPromptText: $('defaultPromptText'),
  };

  const API_BASE_KEY = 'ai-kefu.apiBase';

  const state = {
    apiBase: null,
    sessions: [],
    currentId: null,
    streaming: false,
    controller: null,
    model: '',
    think: false,
    systemPrompt: '',   // 当前会话的自定义提示词，'' = 用默认
    defaultPrompt: '',
    nearBottom: true,
    lastFailedText: '',
  };

  /* ── 小工具 ───────────────────────────────────────── */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* file:// 下不可用，忽略 */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
  };

  function api(path) {
    return `${state.apiBase}${path}`;
  }

  async function request(path, options) {
    const res = await fetch(api(path), options);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON（例如静态服务器的 404 页面）*/ }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  /* ── 后端自动寻址 ─────────────────────────────────── */
  async function pingBackend(base) {
    if (!base) return false;
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return false;
      const j = await res.json();
      return Boolean(j && Object.prototype.hasOwnProperty.call(j, 'ollama'));
    } catch {
      return false;
    }
  }

  async function resolveApiBase() {
    const q = new URLSearchParams(location.search).get('api');
    const host = location.hostname || '127.0.0.1';
    const candidates = [
      q,
      store.get(API_BASE_KEY),
      location.origin && location.origin !== 'null' ? location.origin : '',
      `${location.protocol || 'http:'}//${host}:3000`,
      'http://127.0.0.1:3000',
      'http://localhost:3000',
    ].filter(Boolean);

    for (const c of [...new Set(candidates)]) {
      if (await pingBackend(c)) {
        store.set(API_BASE_KEY, c);
        return c;
      }
    }
    store.del(API_BASE_KEY);
    return null;
  }

  /* ── 自研 Markdown ────────────────────────────────── */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeUrl(u) {
    const t = String(u || '').trim();
    return /^(https?:|mailto:|#|\/)/i.test(t) ? t : '#';
  }

  const KEYWORDS = new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
    'class', 'extends', 'import', 'export', 'from', 'default', 'await', 'async',
    'try', 'catch', 'finally', 'throw', 'new', 'this', 'typeof', 'instanceof',
    'def', 'self', 'None', 'True', 'False', 'null', 'nil', 'true', 'false',
    'undefined', 'and', 'or', 'not', 'in', 'is', 'elif', 'lambda', 'yield',
    'public', 'private', 'static', 'void', 'int', 'string', 'SELECT', 'FROM', 'WHERE',
  ]);

  /** 极简着色：注释 / 字符串 / 数字 / 关键字 */
  function highlight(code) {
    const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)\b/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      out += escapeHtml(code.slice(last, m.index));
      if (m[1]) out += `<span class="tok-com">${escapeHtml(m[1])}</span>`;
      else if (m[2]) out += `<span class="tok-str">${escapeHtml(m[2])}</span>`;
      else if (m[3]) out += `<span class="tok-num">${escapeHtml(m[3])}</span>`;
      else if (m[4]) out += KEYWORDS.has(m[4]) ? `<span class="tok-key">${m[4]}</span>` : m[4];
      last = m.index + m[0].length;
    }
    out += escapeHtml(code.slice(last));
    return out;
  }

  const PLACE_BLOCK = '\u0000B';
  // escapeHtml 会把块级引用的「>」转成 &gt;，两种形态都得认
  const QUOTE_RE = /^(?:>|&gt;)\s?/;
  const PLACE_INLINE = '\u0000I';

  function isBlockStart(line) {
    return (
      /^\u0000B\d+\u0000$/.test(line) ||
      /^#{1,6}\s+/.test(line) ||
      QUOTE_RE.test(line) ||
      /^\s*([-*+]|\d+\.)\s+/.test(line) ||
      /^\|/.test(line) ||
      /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())
    );
  }

  function splitRow(line) {
    return line.replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
  }

  function mdToHtml(src) {
    const codeBlocks = [];
    const inlineCodes = [];
    let text = String(src || '');

    // 1) 先抽走围栏代码块
    text = text.replace(/```([\w+#-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
      codeBlocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
      return `\n${PLACE_BLOCK}${codeBlocks.length - 1}\n`;
    });
    // 2) 再抽走行内代码，避免被强调/链接规则破坏
    text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
      inlineCodes.push(code);
      return `${PLACE_INLINE}${inlineCodes.length - 1}`;
    });
    // 3) 转义 —— 之后插入的 HTML 全部由我们生成
    text = escapeHtml(text);

    const inline = (s) =>
      s
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
          (_m, t, u) => `<a href="${safeUrl(u)}" target="_blank" rel="noopener noreferrer">${t}</a>`)
        .replace(new RegExp(`${PLACE_INLINE}(\\d+)`, 'g'),
          (_m, n) => `<code>${escapeHtml(inlineCodes[Number(n)])}</code>`);

    const lines = text.split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      const mBlock = line.trim().match(new RegExp(`^${PLACE_BLOCK}(\\d+)$`));
      if (mBlock) {
        const b = codeBlocks[Number(mBlock[1])];
        const tag = b.lang ? `<span class="code-lang">${escapeHtml(b.lang)}</span>` : '';
        html += `<pre>${tag}<code>${highlight(b.code)}</code></pre>`;
        i++;
        continue;
      }

      const mH = line.match(/^(#{1,6})\s+(.*)$/);
      if (mH) {
        const lv = Math.min(mH[1].length, 3);
        html += `<h${lv}>${inline(mH[2])}</h${lv}>`;
        i++;
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { html += '<hr>'; i++; continue; }

      if (QUOTE_RE.test(line)) {
        const buf = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) {
          buf.push(inline(lines[i].replace(QUOTE_RE, '')));
          i++;
        }
        html += `<blockquote>${buf.join('<br>')}</blockquote>`;
        continue;
      }

      if (/^\|/.test(line) && i + 1 < lines.length && /^\|?[\s:|-]+\|/.test(lines[i + 1])) {
        const head = splitRow(lines[i]);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        html +=
          '<table><thead><tr>' +
          head.map((c) => `<th>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>';
        continue;
      }

      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push(inline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')));
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        html += `<${tag}>${items.map((t) => `<li>${t}</li>`).join('')}</${tag}>`;
        continue;
      }

      if (!line.trim()) { i++; continue; }

      const buf = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
      if (buf.length) html += `<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`;
      else i++;
    }

    return html;
  }

  /* ── 消息渲染 ─────────────────────────────────────── */
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }

  function appendMessage(msg) {
    const wrap = el('div', `msg ${msg.role}`);
    wrap.dataset.id = msg.id || '';

    const avatar = el('div', 'avatar', msg.role === 'user' ? '我' : 'AI');
    const col = el('div', 'col');

    // 助手消息的思考过程折叠区（有内容才显示）
    let thinkBox = null;
    let thinkBody = null;
    if (msg.role === 'assistant') {
      thinkBox = el('details', 'think-box');
      thinkBox.innerHTML = '<summary>思考过程</summary>';
      thinkBody = el('div', 'think-body', '');
      thinkBox.appendChild(thinkBody);
      thinkBox.hidden = true;
      col.appendChild(thinkBox);
    }

    const bubble = el('div', 'bubble');
    const content = el(msg.role === 'user' ? 'div' : 'div',
      msg.role === 'user' ? 'plain' : 'content markdown');
    if (msg.role === 'user') content.textContent = msg.content || '';
    else content.innerHTML = mdToHtml(msg.content || '');
    bubble.appendChild(content);

    // 天气卡片容器
    const toolBox = el('div', 'tool-box');
    if (msg.role === 'assistant') col.appendChild(toolBox);
    col.appendChild(bubble);

    const stats = el('div', 'stats', '');
    const actions = el('div', 'actions');
    if (msg.role === 'assistant') {
      const copyBtn = el('button', '', '复制');
      copyBtn.onclick = () => {
        navigator.clipboard?.writeText(msg.content || '').catch(() => {});
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
      };
      actions.appendChild(copyBtn);
      col.appendChild(actions);
      col.appendChild(stats);
    }

    wrap.appendChild(avatar);
    wrap.appendChild(col);
    els.messages.appendChild(wrap);

    msg._el = wrap;
    msg._contentEl = content;
    msg._thinkBox = thinkBox;
    msg._thinkBody = thinkBody;
    msg._toolBox = toolBox;
    msg._statsEl = stats;
    msg._actionsEl = actions;
    return wrap;
  }

  /* ── 天气卡片 ─────────────────────────────────────── */
  function renderWeatherCard(box, evt) {
    const d = evt.data || {};
    const args = evt.args || {};

    // 城市无效：中性提示卡，不是红色报错
    if (d.cityNotFound) {
      const tip = el(
        'div',
        'weather-card not-found',
        `<div class="wc-head"><span class="wc-city">未找到城市</span>` +
          `<span class="wc-day">${escapeHtml(args.day || '')}</span>` +
          `<span class="wc-src">聚合数据实时接口</span></div>` +
          `<div class="wc-tip">没有查到「${escapeHtml(d.city || args.city || '')}」的天气数据。` +
          `请换个说法，比如「北京天气」「上海明天下雨吗」。</div>`
      );
      box.innerHTML = '';
      box.appendChild(tip);
      scrollToBottom();
      return;
    }

    const na = '暂无数据';
    const temp = d.temperature ?? (d.high ? `${d.low}~${d.high}` : null);

    const rows = [
      ['天气', d.weather || na],
      ['风向', d.direct || na],
      ['风力', d.power || na],
      ['湿度', d.humidity ? d.humidity + '%' : na],
    ];
    if (d.aqi) rows.push(['空气质量', d.aqi]);

    const head = `<div class="wc-head">
        <span class="wc-city">${escapeHtml(d.city || args.city || '')}</span>
        <span class="wc-day">${escapeHtml(args.day || d.day || '实时')}</span>
        <span class="wc-src">聚合数据实时接口</span>
      </div>`;
    const tempHtml = temp
      ? `<div class="wc-temp">${escapeHtml(String(temp))}<span>${d.temperature ? '℃' : '℃'}</span></div>`
      : `<div class="wc-temp">${na}</div>`;
    const grid = `<div class="wc-grid">${rows
      .map(([k, v]) => `<div>${escapeHtml(k)}<b>${escapeHtml(String(v))}</b></div>`)
      .join('')}</div>`;

    const card = el('div', 'weather-card', head + tempHtml + grid);
    box.innerHTML = '';
    box.appendChild(card);
    scrollToBottom();
  }

  /* ── 订单卡片 ─────────────────────────────────────── */
  // 手机号脱敏：前 3 + **** + 后 4。模型上下文里仍是完整号码，仅卡片展示脱敏
  function maskPhone(p) {
    const s = String(p || '').trim();
    if (!/^\d{7,}$/.test(s)) return s || '暂无';
    return s.slice(0, 3) + '****' + s.slice(-4);
  }

  function renderToolRunning(tool, evt) {
    let label = '正在调用工具…';
    if (tool === 'query_order') {
      const a = evt.args || {};
      const q = a.order_no || a.phone || a.name || '';
      label = `正在查询订单（${q ? escapeHtml(q) : '按线索'}） …`;
    } else if (tool === 'weather') label = '正在查询天气…';
    else label = `正在调用工具：${escapeHtml(tool || '')} …`;
    return `<div class="tool-running">${label}</div>`;
  }

  function renderToolError(tool, evt) {
    return `<div class="tool-error">${escapeHtml(tool || '工具')} 调用失败：${escapeHtml(evt.error || '未知错误')}</div>`;
  }

  function renderToolResult(tool, evt) {
    const text = (evt.data && (evt.data.text || evt.data.summary)) || '已完成';
    return `<div class="tool-card"><div class="tc-head"><span class="tc-name">${escapeHtml(tool || '工具')}</span></div><div class="tc-body">${escapeHtml(text)}</div></div>`;
  }

  function renderOrderCard(box, evt) {
    const d = evt.data || {};

    if (d.notFound || !d.orders || !d.orders.length) {
      const q = (d.query || (evt.args && (evt.args.order_no || evt.args.phone || evt.args.name)) || '');
      const card = el(
        'div',
        'order-card not-found',
        `<div class="oc-head"><span class="oc-no">未找到订单</span><span class="oc-src">本地订单数据</span></div>` +
          `<div class="oc-tip">${escapeHtml(q)}：未匹配到订单。请确认订单号/快递单号、手机号或收件人姓名是否正确。</div>`
      );
      box.innerHTML = '';
      box.appendChild(card);
      scrollToBottom();
      return;
    }

    const na = '暂无数据';
    const cards = d.orders
      .map((o) => {
        const rows = [
          ['订单号/快递单号', o.orderNo],
          ['收件人', o.name || na],
          ['手机号', maskPhone(o.phone)],
          ['收货城市', o.city || na],
          ['购买物品', o.item || na],
          ['订单状态', o.status || na],
        ];
        const countTag = d.orders.length > 1 ? `<span class="oc-count">共 ${d.orders.length} 条</span>` : '';
        const head = `<div class="oc-head">
            <span class="oc-no">${escapeHtml(o.orderNo || '')}</span>
            <span class="oc-src">本地订单数据${countTag}</span>
          </div>`;
        const grid = `<div class="oc-grid">${rows
          .map(([k, v]) => `<div>${escapeHtml(k)}<b>${escapeHtml(String(v))}</b></div>`)
          .join('')}</div>`;
        return `<div class="order-card">${head + grid}</div>`;
      })
      .join('');

    box.innerHTML = cards;
    scrollToBottom();
  }

  /* ── 滚动 ─────────────────────────────────────────── */
  function scrollToBottom(force) {
    if (force || state.nearBottom) {
      els.messages.scrollTop = els.messages.scrollHeight;
    }
  }

  /* ── 会话列表 ─────────────────────────────────────── */
  function renderSessions() {
    els.sessionList.innerHTML = '';
    if (!state.sessions.length) {
      els.sessionList.appendChild(el('div', 'empty-sessions', '还没有会话'));
      return;
    }
    for (const s of state.sessions) {
      const item = el('div', 'session-item' + (s.id === state.currentId ? ' active' : ''));
      item.appendChild(el('div', 'name', escapeHtml(s.title || '新对话')));
      const del = el('button', 'del', '✕');
      del.title = '删除会话';
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`删除会话「${s.title}」？`)) return;
        try {
          await request(`/api/sessions/${s.id}`, { method: 'DELETE' });
          if (state.currentId === s.id) startNewChat();
          await loadSessions();
        } catch (err) { setBanner(err.message); }
      };
      item.appendChild(del);
      item.onclick = () => openSession(s.id);
      item.ondblclick = async () => {
        const t = prompt('重命名会话', s.title || '新对话');
        if (!t || !t.trim()) return;
        try {
          await request(`/api/sessions/${s.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: t.trim() }),
          });
          await loadSessions();
        } catch (err) { setBanner(err.message); }
      };
      els.sessionList.appendChild(item);
    }
  }

  async function loadSessions(silent = false) {
    try {
      const data = await request('/api/sessions');
      state.sessions = data.sessions || [];
      renderSessions();
    } catch (err) {
      // 流式过程中刷新列表失败属正常抖动，静默即可，别弹横幅打扰
      if (!silent) setBanner(err.message);
    }
  }

  async function openSession(id) {
    if (state.streaming) return;
    try {
      const data = await request(`/api/sessions/${id}`);
      const s = data.session || {};
      state.currentId = id;
      state.systemPrompt = s.systemPrompt || '';
      if (s.model && s.model !== state.model) {
        state.model = s.model;
        els.modelSelect.value = s.model;
      }
      els.chatTitle.textContent = s.title || '新对话';
      updatePromptIndicator();

      els.messages.innerHTML = '';
      const msgs = data.messages || [];
      if (!msgs.length) {
        renderWelcome();
      } else {
        for (const m of msgs) {
          const msg = {
            id: m.id, role: m.role, content: m.content, thinking: m.thinking || '',
          };
          appendMessage(msg);
          if (msg.role === 'assistant' && msg.thinking) {
            msg._thinkBody.textContent = msg.thinking;
            msg._thinkBox.hidden = false;
          }
        }
      }
      renderSessions();
      scrollToBottom(true);
      closeSidebar();
    } catch (err) {
      setBanner(err.message);
    }
  }

  function startNewChat() {
    state.currentId = null;
    state.systemPrompt = '';
    els.chatTitle.textContent = '新对话';
    els.messages.innerHTML = '';
    renderWelcome();
    renderSessions();
    updatePromptIndicator();
    closeSidebar();
    els.input.focus();
  }

  const SUGGESTIONS = [
    '帮我查订单 SF133052943974',
    '北京今天多少度？',
    '如何申请退款，需要多久到账？',
    '帮我把这段话改写得更有礼貌：你们怎么还没发货',
  ];

  function renderWelcome() {
    const w = el('div', 'welcome');
    w.innerHTML = `<h2>有什么可以帮您？</h2><div>由本地部署的 ${escapeHtml(state.model || '模型')} 提供，数据不出本机</div>`;
    const box = el('div', 'suggestions');
    for (const s of SUGGESTIONS) {
      const b = el('button', '', escapeHtml(s));
      b.onclick = () => { els.input.value = s; autoGrow(); els.input.focus(); };
      box.appendChild(b);
    }
    w.appendChild(box);
    els.messages.appendChild(w);
  }

  /* ── 发送与流式 ───────────────────────────────────── */
  async function parseSse(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = raw.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try { onEvent(JSON.parse(data)); } catch { /* 忽略坏帧 */ }
      }
    }
  }

  async function send() {
    const text = els.input.value.trim();
    if (!text || state.streaming) return;

    els.messages.querySelector('.welcome')?.remove();

    // 用户气泡
    const userMsg = { role: 'user', content: text };
    appendMessage(userMsg);
    els.input.value = '';
    autoGrow();
    scrollToBottom(true);

    // 助手占位气泡
    const aiMsg = { role: 'assistant', content: '', thinking: '' };
    appendMessage(aiMsg);
    aiMsg._contentEl.classList.add('streaming');
    scrollToBottom(true);

    setStreaming(true);
    state.lastFailedText = text;

    const controller = new AbortController();
    state.controller = controller;

    let firstDelta = true;
    let pending = false;

    const paint = () => {
      pending = false;
      aiMsg._contentEl.innerHTML = mdToHtml(aiMsg.content);
      if (aiMsg.thinking && aiMsg._thinkBody) {
        aiMsg._thinkBody.textContent = aiMsg.thinking;
        aiMsg._thinkBox.hidden = false;
      }
      scrollToBottom();
    };
    const schedulePaint = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(paint);
    };

    try {
      const res = await fetch(api('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.currentId,
          message: text,
          model: state.model || undefined,
          think: state.think,
          systemPrompt: state.systemPrompt || undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.error || msg; } catch { /* 忽略 */ }
        throw new Error(msg);
      }

      let needRefreshSessions = false;

      await parseSse(res, (evt) => {
        if (evt.type === 'meta') {
          if (!state.currentId) {
            state.currentId = evt.sessionId;
            needRefreshSessions = true;
          }
          if (evt.model && evt.model !== state.model) {
            state.model = evt.model;
            els.modelSelect.value = evt.model;
          }
        } else if (evt.type === 'tool') {
          const tool = evt.tool || evt.name;
          if (evt.status === 'running') {
            aiMsg._toolBox.innerHTML = renderToolRunning(tool, evt);
            scrollToBottom();
          } else if (evt.status === 'done') {
            if (tool === 'query_order') renderOrderCard(aiMsg._toolBox, evt);
            else if (tool === 'weather') renderWeatherCard(aiMsg._toolBox, evt);
            else aiMsg._toolBox.innerHTML = renderToolResult(tool, evt);
          } else {
            aiMsg._toolBox.innerHTML = renderToolError(tool, evt);
          }
        } else if (evt.type === 'thinking') {
          aiMsg.thinking += evt.text;
          schedulePaint();
        } else if (evt.type === 'delta') {
          if (firstDelta) {
            firstDelta = false;
            aiMsg._contentEl.classList.remove('streaming');
          }
          aiMsg.content += evt.text;
          schedulePaint();
        } else if (evt.type === 'done') {
          aiMsg.content = evt.content || aiMsg.content;
          if (evt.thinking) aiMsg.thinking = evt.thinking;
          aiMsg._contentEl.classList.remove('streaming');
          paint();

          const bits = [];
          if (evt.tokensPerSecond) bits.push(`${evt.tokensPerSecond} tok/s`);
          if (evt.stats && evt.stats.evalCount) bits.push(`${evt.stats.evalCount} tokens`);
          if (evt.stats && evt.stats.totalDurationMs) bits.push(`${(evt.stats.totalDurationMs / 1000).toFixed(1)}s`);
          if (evt.aborted) bits.push('已中断');
          if (evt.trimmed) bits.push(`上下文已裁剪 ${evt.trimmed} 条`);
          aiMsg._statsEl.textContent = bits.join(' · ');

          if (needRefreshSessions) loadSessions(true);
          if (evt.empty) setBanner('模型这次没有产出内容，换个说法或换一个模型试试。');
        } else if (evt.type === 'error') {
          aiMsg.content = `⚠ ${evt.error}`;
          aiMsg._contentEl.innerHTML = mdToHtml(aiMsg.content);
          aiMsg._contentEl.classList.remove('streaming');
          // 气泡里已展示错误，横幅只做非阻塞提醒，8 秒自动消失
          setBanner(evt.error);
        }
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        aiMsg._contentEl.classList.remove('streaming');
        aiMsg._statsEl.textContent = '已停止生成';
      } else {
        aiMsg.content = `⚠ 请求失败：${err.message}`;
        aiMsg._contentEl.innerHTML = mdToHtml(aiMsg.content);
        aiMsg._contentEl.classList.remove('streaming');
        setBanner(err.message);
      }
    } finally {
      setStreaming(false);
      state.controller = null;
      paint();
    }
  }

  function setStreaming(v) {
    state.streaming = v;
    els.sendBtn.hidden = v;
    els.stopBtn.hidden = !v;
    els.hint.textContent = v ? '生成中…本地推理较慢，请稍候' : '模型运行在本地，回复速度受机器性能影响';
  }

  /* ── 提示条 ───────────────────────────────────────── */
  // sticky=true 仅用于「后端不可达」这类需要用户点重试的场景；
  // 其余提示一律 8 秒自动消失。空消息绝不弹 —— 这是「莫名重试栏」的根因。
  let bannerTimer = null;
  function setBanner(msg, { sticky = false } = {}) {
    if (!msg || !String(msg).trim()) return;
    clearTimeout(bannerTimer);
    els.bannerText.textContent = msg;
    els.bannerRetry.hidden = !sticky;
    els.banner.hidden = false;
    if (!sticky) bannerTimer = setTimeout(clearBanner, 8000);
  }
  function clearBanner() {
    clearTimeout(bannerTimer);
    bannerTimer = null;
    els.banner.hidden = true;
  }

  /* ── 提示词弹窗 ───────────────────────────────────── */
  const PRESETS = [
    { name: '恢复默认', value: '' },
    { name: '技术支持', value: '你是一名资深技术支持工程师。回答要给出可执行的步骤，按 1、2、3 分点说明；涉及命令或配置时给出完整代码块。不确定时说明需要哪些信息。' },
    { name: '售前顾问', value: '你是一名售前顾问。用简洁专业的语言介绍产品能力，突出价值；不承诺未经确认的价格、折扣与交付时间；最后主动询问客户的业务场景。' },
    { name: '极简回答', value: '回答控制在三句话以内，只给结论，不展开解释。' },
    { name: '中英互译', value: '你是一名翻译。用户给中文就译英文，给英文就译中文。只输出译文，不要解释、不要加引号。' },
    { name: 'JSON 输出', value: '所有回答必须是合法 JSON 对象，不要使用 Markdown 代码块包裹，不要输出任何解释文字。' },
  ];

  function renderPresets() {
    els.presets.innerHTML = '';
    for (const p of PRESETS) {
      const b = el('button', '', escapeHtml(p.name));
      b.onclick = () => { els.promptInput.value = p.value; };
      els.presets.appendChild(b);
    }
  }

  function openPromptModal() {
    els.promptInput.value = state.systemPrompt || '';
    els.promptModal.hidden = false;
    els.promptInput.focus();
  }
  function closePromptModal() {
    els.promptModal.hidden = true;
  }

  async function savePrompt() {
    const value = els.promptInput.value;
    state.systemPrompt = value;
    updatePromptIndicator();
    closePromptModal();

    if (state.currentId) {
      try {
        await request(`/api/sessions/${state.currentId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ systemPrompt: value }),
        });
      } catch (err) { setBanner(err.message); }
    }
  }

  function updatePromptIndicator() {
    els.promptDot.hidden = !state.systemPrompt;
  }

  /* ── 初始化 ───────────────────────────────────────── */
  async function initHealth() {
    try {
      const h = await request('/api/health');
      if (h.ok) {
        els.status.className = 'foot-status ok';
        els.status.textContent = `Ollama ${h.version} 已连接`;
        els.chatSubtitle.textContent = `${h.ollama} · ${h.model}`;
        clearBanner();
      } else {
        els.status.className = 'foot-status err';
        els.status.textContent = 'Ollama 不可达';
        setBanner(h.error || 'Ollama 不可达，请检查服务与 OLLAMA_BASE_URL 配置。', { sticky: true });
      }
    } catch (err) {
      els.status.className = 'foot-status err';
      els.status.textContent = '后端不可用';
      setBanner(`无法连接后端：${err.message}。请确认已执行 npm start。`, { sticky: true });
    }
  }

  async function initModels() {
    try {
      const data = await request('/api/models');
      const models = data.models || [];
      const names = models.length ? models.map((m) => m.name) : [data.defaultModel];
      els.modelSelect.innerHTML = '';
      for (const n of names) {
        const o = document.createElement('option');
        o.value = n;
        o.textContent = n;
        els.modelSelect.appendChild(o);
      }
      state.model = names.includes(state.model) ? state.model : (data.defaultModel || names[0]);
      els.modelSelect.value = state.model;
    } catch {
      const o = document.createElement('option');
      o.value = 'qwen3.5:2b';
      o.textContent = 'qwen3.5:2b';
      els.modelSelect.appendChild(o);
      state.model = 'qwen3.5:2b';
    }
  }

  async function initConfig() {
    try {
      const c = await request('/api/config');
      state.model = c.model || state.model;
      state.defaultPrompt = c.defaultSystemPrompt || '';
      els.modelSelect.value = state.model;
      els.defaultPromptText.textContent = state.defaultPrompt || '（未获取）';
    } catch { /* 忽略 */ }
  }

  /* ── 事件绑定 ─────────────────────────────────────── */
  function autoGrow() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 180) + 'px';
  }

  function openSidebar() { els.sidebar.classList.add('open'); els.scrim.hidden = false; }
  function closeSidebar() { els.sidebar.classList.remove('open'); els.scrim.hidden = true; }

  function bindEvents() {
    els.sendBtn.onclick = send;
    els.stopBtn.onclick = () => state.controller?.abort();
    els.newChatBtn.onclick = startNewChat;
    els.menuBtn.onclick = openSidebar;
    els.scrim.onclick = closeSidebar;

    els.input.addEventListener('input', autoGrow);
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });

    els.messages.addEventListener('scroll', () => {
      const m = els.messages;
      state.nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
    });

    els.modelSelect.onchange = () => { state.model = els.modelSelect.value; };
    els.thinkToggle.onchange = () => { state.think = els.thinkToggle.checked; };

    els.promptBtn.onclick = openPromptModal;
    els.promptClose.onclick = closePromptModal;
    els.promptCancel.onclick = closePromptModal;
    els.promptSave.onclick = savePrompt;
    els.promptReset.onclick = () => { els.promptInput.value = ''; };
    els.promptModal.onclick = (e) => { if (e.target === els.promptModal) closePromptModal(); };
    els.promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); savePrompt(); }
      if (e.key === 'Escape') closePromptModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.promptModal.hidden) closePromptModal();
    });

    els.bannerRetry.onclick = async () => { clearBanner(); await initHealth(); };
    els.bannerClose.onclick = clearBanner;
  }

  async function init() {
    bindEvents();
    autoGrow();
    setStreaming(false);
    renderPresets();
    updatePromptIndicator();
    renderWelcome();

    state.apiBase = await resolveApiBase();
    if (!state.apiBase) {
      els.status.className = 'foot-status err';
      els.status.textContent = '未找到后端';
      setBanner('未找到后端服务。请在项目目录执行 npm start，然后刷新页面。');
      // 每 10 秒自动重连，服务起来后页面自己恢复
      setInterval(async () => {
        const base = await resolveApiBase();
        if (base) location.reload();
      }, 10000);
      return;
    }

    await Promise.all([initHealth(), initModels(), loadSessions(), initConfig()]);
  }

  init();
})();
