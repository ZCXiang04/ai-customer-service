/**
 * 调试工具：打印某个会话「真实送给模型」的上下文
 *   node server/inspect-context.js <sessionId> [当前提问]
 *
 * 排查上下文问题时别猜，直接看喂进去了什么。
 */
import { getSession, listRecentMessages } from './db.js';
import { buildContext, estimateTokens } from './context.js';
import { config } from './config.js';

const sessionId = process.argv[2];
const probe = process.argv[3] || '你现在能回忆起我告诉过你的信息吗？';

if (!sessionId) {
  const { listSessions } = await import('./db.js');
  const sessions = listSessions();
  console.log('未指定 sessionId。现有会话：');
  for (const s of sessions) console.log(`  ${s.id}  ${s.title}`);
  process.exit(0);
}

const session = getSession(sessionId);
if (!session) {
  console.error('会话不存在：', sessionId);
  process.exit(1);
}

const history = listRecentMessages(sessionId, config.context.maxMessages + 20);
const { messages, trimmed } = buildContext({
  history,
  systemPrompt: session.system_prompt || config.defaultSystemPrompt,
  currentMessage: probe,
  maxMessages: config.context.maxMessages,
  maxChars: config.context.maxChars,
});

console.log(`会话：${session.title} (${session.id})`);
console.log(`模型：${session.model}   提示词：${session.system_prompt ? '自定义' : '默认'}`);
console.log(`历史 ${history.length} 条，裁剪掉 ${trimmed} 条，最终 ${messages.length} 条`);
console.log(`字符预算 ${config.context.maxChars}（配置请求值 ${config.context.requestedChars}）`);
console.log('─'.repeat(70));

for (const [i, m] of messages.entries()) {
  const tokens = estimateTokens(m.content);
  console.log(`\n[${i}] ${m.role}  (~${tokens} tokens)`);
  console.log(String(m.content).slice(0, 1200));
}

console.log('\n' + '─'.repeat(70));
console.log(`合计约 ${estimateTokens(messages.map((m) => m.content).join(''))} tokens / num_ctx=${config.ollama.numCtx}`);
