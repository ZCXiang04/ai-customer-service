/**
 * 订单查询工具：从本地数据文件加载订单并提供查询能力。
 *
 * 设计要点：
 *  1. 数据只在服务端内存，浏览器永不直连数据源 —— 与「数据不出内网」初衷一致。
 *  2. 同时支持 CSV 与 XLSX（两步式：先读文件头判断，再选解析器）。
 *     业务方导出的文件无论叫 .csv 还是 .xlsx 都能直接喂进来，无需手工转格式。
 *  3. 建立四张索引：快递单号 / 顺序id / 手机号(纯数字) / 姓名(归一化)，查询 O(1)~O(n)。
 *  4. 支持按「订单号 / 手机号 / 姓名」查询；姓名或手机号可能命中多条，统一以列表返回。
 *  5. 手机号等敏感字段在「喂给模型的摘要」里保持完整（模型需据此回答），
 *     但前端卡片默认脱敏显示（见 web/app.js 的 maskPhone）。
 *  6. 未找到时返回清晰的中文提示，绝不编造订单字段。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../config.js';
import { log } from '../util.js';

const DATA_FILE = config.tools?.order?.dataFile || path.join(config.rootDir, '快递信息.csv');

/** 原始行（对象数组，键为表头） */
let ROWS = [];
const BY_TRACKING = new Map(); // 快递单号(大写) -> row
const BY_SEQ = new Map(); // 顺序id(字符串) -> row
const BY_PHONE = new Map(); // 手机号(纯数字) -> row[]
const BY_NAME = new Map(); // 姓名(归一化) -> row[]

/** 最小健壮 CSV 行解析：支持引号包裹，本数据无逗号故通常等价于 split(',') */
function splitLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQ = !inQ;
      continue;
    }
    if (c === ',' && !inQ) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** 把 xlsx 的 sheet1 解析成「表头 -> 行对象」数组（纯 JS，依赖 Node 内置 zlib） */
function parseXlsx(buf) {
  // 1) 遍历 zip 本地文件头，提取各 entry 的解压后文本
  const entries = {};
  let off = 0;
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) { off++; continue; }
    const flags = buf.readUInt16LE(off + 6);
    const method = buf.readUInt16LE(off + 8);
    const csize = buf.readUInt32LE(off + 18);
    const nlen = buf.readUInt16LE(off + 26);
    const elen = buf.readUInt16LE(off + 28);
    const start = off + 30 + nlen + elen;
    const name = buf.toString('utf8', off + 30, off + 30 + nlen);
    let raw = buf.subarray(start, start + csize);
    let text;
    if (flags & 0x08) {
      // 数据描述符：当前导出文件不含，遇之跳过以免解析错位
      off = start;
      continue;
    }
    if (method === 8) {
      try { text = zlib.inflateRawSync(raw).toString('utf8'); }
      catch { text = raw.toString('utf8'); }
    } else {
      text = raw.toString('utf8');
    }
    entries[name] = text;
    off = start + csize;
  }

  // 2) 共享字符串表（sharedStrings.xml）
  const sst = entries['xl/sharedStrings.xml'] || '';
  const strings = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(sst))) {
    const body = m[1];
    let t;
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let txt = '';
    while ((t = tRe.exec(body))) txt += t[1];
    strings.push(txt);
  }

  // 3) 取第一个工作表
  const sheetName = Object.keys(entries).find((k) => /worksheets\/sheet\d+\.xml$/.test(k));
  if (!sheetName) throw new Error('xlsx 中未找到工作表');
  const sheet = entries[sheetName];

  // 4) 解析行列 -> 二维矩阵
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  let rm;
  while ((rm = rowRe.exec(sheet))) {
    const body = rm[1];
    const cells = [];
    let cm;
    while ((cm = cellRe.exec(body))) {
      const attrs = cm[1];
      const inner = cm[2];
      const rMatch = attrs.match(/\br="([A-Z]+)(\d+)"/);
      const colLetter = rMatch ? rMatch[1] : '';
      const typeMatch = attrs.match(/\bt="([a-z]+)"/);
      const t = typeMatch ? typeMatch[1] : '';
      let value = '';
      if (t === 's') {
        const idx = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        value = idx != null ? (strings[+idx] ?? '') : '';
      } else if (t === 'inlineStr' || t === 'str') {
        const im = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        value = im ? im[1] : (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '';
      } else {
        // 数值或布尔：直接取 <v>
        value = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '';
      }
      cells.push({ col: colLetter, value });
    }
    rows.push(cells);
  }
  if (!rows.length) return [];

  // 5) 列字母 -> 索引
  const colToIdx = (s) => {
    let n = 0;
    for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const header = rows[0].map((c) => c.value.trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = {};
    for (const c of rows[i]) row[header[colToIdx(c.col)]] = c.value.trim();
    out.push(row);
  }
  return out;
}

function parseCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const header = splitLine(lines[0]).map((h) => h.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const row = {};
    header.forEach((h, idx) => {
      row[h] = (cells[idx] ?? '').trim();
    });
    out.push(row);
  }
  return out;
}

/** 模块加载即建索引；失败仅告警，不影响其它功能 */
loadOrders();

export function loadOrders() {
  try {
    const buf = fs.readFileSync(DATA_FILE);
    const isXlsx = buf.slice(0, 2).toString('latin1') === 'PK';
    ROWS = isXlsx ? parseXlsx(buf) : parseCsv(buf.toString('utf8'));

    BY_TRACKING.clear();
    BY_SEQ.clear();
    BY_PHONE.clear();
    BY_NAME.clear();
    for (const r of ROWS) {
      const track = (r['快递单号'] || '').toUpperCase();
      if (track) BY_TRACKING.set(track, r);
      const seq = String(r['顺序id'] || '').trim();
      if (seq) BY_SEQ.set(seq, r);

      const ph = digitsOnly(r['用户手机号']);
      if (ph) pushMap(BY_PHONE, ph, r);

      const nm = normName(r['姓名']);
      if (nm) pushMap(BY_NAME, nm, r);
    }
    const kind = isXlsx ? 'xlsx' : 'csv';
    log.info(`[order] 已加载 ${ROWS.length} 条订单（${kind}），来源 ${path.basename(DATA_FILE)}`);
  } catch (err) {
    log.warn(`[order] 加载订单数据失败：${err.message}`);
    ROWS = [];
  }
  return ROWS;
}

function digitsOnly(s) {
  return String(s || '').replace(/\D+/g, '');
}
function normName(s) {
  return String(s || '').replace(/\s+/g, '').trim().toLowerCase();
}
function pushMap(map, key, val) {
  const arr = map.get(key) || [];
  arr.push(val);
  map.set(key, arr);
}

function normalizeNo(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, '');
}

function toOrder(row) {
  return {
    seq: row['顺序id'],
    orderNo: row['快递单号'],
    name: row['姓名'],
    phone: row['用户手机号'],
    city: row['居住城市'],
    item: row['购买物品'],
    status: row['订单状态'] || '',
  };
}

/**
 * 统一查询入口：支持 orderNo / phone / name 任一或多组合。
 * @returns {{ok:boolean, notFound?:boolean, matchType?:string, query?:string, summary:string, data:object}}
 */
export function queryOrder({ orderNo, order_no, phone, name } = {}) {
  const no = (orderNo || order_no || '').toString();
  const hasOrderNo = !!String(no || '').trim();
  const hasPhone = !!String(phone || '').trim();
  const hasName = !!String(name || '').trim();

  if (!hasOrderNo && !hasPhone && !hasName) {
    return {
      ok: true,
      notFound: true,
      data: { notFound: true, count: 0, orders: [] },
      summary: '查询条件不足。请提供订单号/快递单号、收件人手机号或收件人姓名中的任意一项。',
    };
  }

  let rows = [];
  let matchType = '';
  let query = '';

  if (hasOrderNo) {
    query = no;
    matchType = 'orderNo';
    const nn = normalizeNo(no);
    let row = BY_TRACKING.get(nn) || BY_SEQ.get(String(no).trim());
    if (!row && nn.length >= 8) {
      const tail = nn.slice(-8);
      row = ROWS.find((r) => r['快递单号'] && r['快递单号'].toUpperCase().endsWith(tail)) || null;
    }
    if (row) rows = [row];
  } else if (hasPhone) {
    const ph = digitsOnly(phone);
    query = phone;
    matchType = 'phone';
    rows = BY_PHONE.get(ph) || [];
  } else if (hasName) {
    const nm = normName(name);
    query = name;
    matchType = 'name';
    rows = BY_NAME.get(nm) || ROWS.filter((r) => normName(r['姓名']).includes(nm));

    // 姓名仅给片段时：从「精确匹配 + 包含匹配」中收敛到非空且去重，避免整表误命中
    if (!BY_NAME.get(nm)) {
      const filtered = ROWS.filter((r) => {
        const rn = normName(r['姓名']);
        return rn === nm || (nm.length >= 1 && rn.includes(nm));
      });
      const seen = new Set();
      rows = filtered.filter((r) => {
        const k = r['快递单号'] || JSON.stringify(r);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  }

  if (!rows.length) {
    const hint =
      matchType === 'phone'
        ? `未找到手机号「${query}」关联的订单。请确认手机号是否正确。`
        : matchType === 'name'
        ? `未找到收件人「${query}」的订单。请确认姓名是否正确。`
        : `未找到订单号/快递单号「${query}」的订单。请确认订单号或快递单号是否正确。`;
    return {
      ok: true,
      notFound: true,
      matchType,
      query,
      summary:
        hint +
        '或提供其它线索（如收件人姓名、手机号）以便进一步核实。',
      data: { notFound: true, matchType, query, count: 0, orders: [] },
    };
  }

  const orders = rows.map(toOrder);
  const label = matchType === 'phone' ? '手机号' : matchType === 'name' ? '姓名' : '订单号/快递单号';

  const summary =
    `订单查询结果（匹配条件：${label}=${query}；来自本地订单数据「${path.basename(DATA_FILE)}」，共 ${ROWS.length} 条记录）：\n` +
    orders
      .map(
        (o, i) =>
          `【记录 ${i + 1}】\n` +
          `订单号/快递单号：${o.orderNo}\n` +
          `收件人：${o.name}\n` +
          `收货城市：${o.city}\n` +
          `购买物品：${o.item}\n` +
          `订单状态：${o.status || '未知'}\n` +
          `联系电话：${o.phone}`
      )
      .join('\n') +
    `\n请严格基于以上真实数据用中文回答用户，不要编造任何未给出的字段（如物流轨迹、价格）。` +
    `若用户问及数据中没有的信息，如实告知无法查询。`;

  return {
    ok: true,
    notFound: false,
    matchType,
    query,
    summary,
    data: { notFound: false, matchType, query, count: orders.length, orders },
  };
}

// 向后兼容：旧调用方若仍按单号查，可继续用
export function queryOrderByNo(rawNo) {
  return queryOrder({ orderNo: rawNo });
}

/**
 * 从一段文本里提取中国手机号（容忍空格/连字符），命中返回纯数字串，否则 null。
 * 仅作「确定性旁路」的意图识别用，不用于数据库匹配（匹配在 queryOrder 内做）。
 */
export function extractPhone(text) {
  const cleaned = String(text || '').replace(/[\s-]/g, '');
  const m = cleaned.match(/(?<!\d)(1[3-9]\d{9})(?!\d)/);
  return m ? m[1] : null;
}

/**
 * 从一段文本里识别是否包含「已知收件人姓名」（精确全名匹配，最长优先）。
 * 命中返回归一化姓名，否则 null。用于确定性旁路，让「凭姓名查」稳定可用。
 */
export function matchNameInText(text) {
  const t = String(text || '');
  let best = null;
  for (const nm of BY_NAME.keys()) {
    if (nm && t.toLowerCase().includes(nm)) {
      if (!best || nm.length > best.length) best = nm;
    }
  }
  return best;
}

export function orderStats() {
  return { loaded: ROWS.length, source: path.basename(DATA_FILE) };
}
