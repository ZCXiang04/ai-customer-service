/**
 * 连续对话上下文组装
 *
 * 规则：
 *  1. 第一条永远是 system prompt（会话自定义优先）
 *  2. 取最近 N 条历史（默认 20），总字符超限就从最早的非 system 消息开始丢
 *  3. 出错 / 被中断的 assistant 消息不进上下文，避免污染后续生成
 *  4. 工具注入的数据（如天气）作为**独立 system 消息**插在历史之后、当前提问之前
 *     —— 放最后会被当前提问盖过，放最前会挤掉 system prompt
 */

const size = (m) => (m.content?.length || 0) + (m.thinking?.length || 0);

export function buildContext({
  history,
  systemPrompt,
  currentMessage,
  extraSystem = [],
  maxMessages = 20,
  maxChars = 8000,
}) {
  const cleaned = history.filter((m) => {
    if (m.role === 'system') return false;
    if (m.role === 'assistant' && (m.error || m.aborted)) return false;
    if (!m.content && !m.thinking) return false;
    return true;
  });

  let picked = cleaned.slice(-maxMessages);

  const total = (arr) => arr.reduce((sum, m) => sum + size(m), 0);
  while (picked.length > 1 && total(picked) > maxChars) picked = picked.slice(1);

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const m of picked) messages.push({ role: m.role, content: m.content });
  for (const s of extraSystem) {
    if (s && s.trim()) messages.push({ role: 'system', content: s });
  }
  if (currentMessage) messages.push({ role: 'user', content: currentMessage });

  return {
    messages,
    trimmed: cleaned.length - picked.length, // 被丢弃的历史条数
    droppedAll: picked.length === 0 && cleaned.length > 0,
  };
}

/** 估算 token 数（粗算，仅用于提示与统计） */
export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  // 中文按 1.4 字/token，英文按 4 字符/token
  const cjk = (s.match(/[一-龥]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk / 1.4 + rest / 4);
}
