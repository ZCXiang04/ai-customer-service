/**
 * SQLite 会话与消息存储
 *
 * 建表一律 IF NOT EXISTS，缺列用 PRAGMA table_info 探测后 ALTER ——
 * 老库不用删，服务升级不会丢历史会话。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { log } from './util.js';

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new Database(path.join(config.dataDir, 'chat.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT '新对话',
  model         TEXT NOT NULL,
  -- 空串表示「使用服务端默认提示词」。用空串而不是 NULL：
  -- 历史库里该列是 NOT NULL，写 NULL 会直接触发约束错误。
  system_prompt TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,      -- user | assistant | system
  content      TEXT NOT NULL DEFAULT '',
  thinking     TEXT,               -- 深度思考模式下的思考过程
  model        TEXT,               -- 生成该条回复的模型
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
`);

/** 缺列自动补齐 */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    log.info(`[db] ${table} 补列 ${column}`);
  }
}

ensureColumn('sessions', 'system_prompt', "system_prompt TEXT NOT NULL DEFAULT ''");
ensureColumn('messages', 'thinking', 'thinking TEXT');
ensureColumn('messages', 'model', 'model TEXT');

/**
 * 预编译关键语句。
 * 目的：SQL 写错时在服务启动阶段就炸，而不是等用户发第一条消息才暴露。
 */
const STMT = {
  listMessages: db.prepare(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC'
  ),
  recentMessages: db.prepare(
    `SELECT * FROM (
       SELECT *, rowid AS _rid FROM messages WHERE session_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?
     ) ORDER BY created_at ASC, _rid ASC`
  ),
};

const now = () => Date.now();

/* ---------------- sessions ---------------- */

export function createSession({ title = '新对话', model, systemPrompt = '' } = {}) {
  const id = randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO sessions (id, title, model, system_prompt, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`
  ).run(id, title, model || config.ollama.defaultModel, systemPrompt || '', t, t);
  return getSession(id);
}

export function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

export function listSessions() {
  return db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM sessions s ORDER BY s.updated_at DESC`
    )
    .all();
}

export function touchSession(id) {
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now(), id);
}

export function renameSession(id, title) {
  db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), id);
  return getSession(id);
}

export function updateSessionModel(id, model) {
  db.prepare('UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?').run(model, now(), id);
  return getSession(id);
}

/** 空串 = 恢复服务端默认提示词 */
export function updateSessionPrompt(id, systemPrompt) {
  db.prepare('UPDATE sessions SET system_prompt = ?, updated_at = ? WHERE id = ?').run(
    systemPrompt || '',
    now(),
    id
  );
  return getSession(id);
}

export function deleteSession(id) {
  db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  })();
}

/* ---------------- messages ---------------- */

export function addMessage({ sessionId, role, content = '', thinking = '', model = null }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, thinking, model, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, sessionId, role, content, thinking || null, model, now());
  touchSession(sessionId);
  return id;
}

export function updateMessage(id, { content, thinking, model }) {
  if (content !== undefined) db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
  if (thinking !== undefined) db.prepare('UPDATE messages SET thinking = ? WHERE id = ?').run(thinking, id);
  if (model !== undefined) db.prepare('UPDATE messages SET model = ? WHERE id = ?').run(model, id);
}

export function listMessages(sessionId) {
  return STMT.listMessages.all(sessionId);
}

export function listRecentMessages(sessionId, limit = 50) {
  // 派生表里引用不到隐式 rowid，必须显式 SELECT 出来再排序
  return STMT.recentMessages.all(sessionId, limit);
}

export function stats() {
  return {
    sessions: db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
    messages: db.prepare('SELECT COUNT(*) c FROM messages').get().c,
  };
}

export { db };
