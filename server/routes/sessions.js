/**
 * 会话 CRUD
 * systemPrompt 空串 = 恢复服务端默认提示词
 */
import { Router } from 'express';
import { config } from '../config.js';
import {
  listSessions, getSession, createSession, renameSession,
  updateSessionModel, updateSessionPrompt, deleteSession, listMessages,
} from '../db.js';
import { AppError } from '../util.js';

const router = Router();

function shape(s) {
  if (!s) return null;
  return { ...s, systemPrompt: s.system_prompt || '', usingDefaultPrompt: !s.system_prompt };
}

router.get('/sessions', (_req, res) => {
  res.json({ sessions: listSessions().map(shape) });
});

router.get('/sessions/:id', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) throw new AppError('会话不存在', { status: 404, code: 'NOT_FOUND' });
  res.json({ session: shape(s), messages: listMessages(s.id) });
});

router.post('/sessions', (req, res) => {
  const { title, model, systemPrompt } = req.body || {};
  const s = createSession({
    title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 60) : '新对话',
    model: model || config.ollama.defaultModel,
    systemPrompt: typeof systemPrompt === 'string' ? systemPrompt : '',
  });
  res.status(201).json({ session: shape(s) });
});

router.patch('/sessions/:id', (req, res) => {
  const { title, model, systemPrompt } = req.body || {};
  let s = getSession(req.params.id);
  if (!s) throw new AppError('会话不存在', { status: 404, code: 'NOT_FOUND' });

  if (typeof title === 'string' && title.trim()) s = renameSession(s.id, title.trim().slice(0, 60));
  if (typeof model === 'string' && model.trim()) s = updateSessionModel(s.id, model.trim());
  if (typeof systemPrompt === 'string') s = updateSessionPrompt(s.id, systemPrompt);

  res.json({ session: shape(s) });
});

router.delete('/sessions/:id', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) throw new AppError('会话不存在', { status: 404, code: 'NOT_FOUND' });
  deleteSession(s.id);
  res.json({ ok: true });
});

export default router;
