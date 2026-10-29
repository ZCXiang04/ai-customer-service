/**
 * 订单查询的确定性意图识别（旁路，独立于模型调用）。
 *
 * 为什么需要它：模型对「凭手机号/姓名查订单」的 tool calling 触发不稳定，
 * 有时会反问用户要更多信息。为保证该能力稳定可用，这里用规则先把
 * 「手机号 / 已知收件人姓名」识别出来，由服务端直接查询并注入结果，
 * 与 weather.js 的规则旁路同一思路。
 *
 * 优先级：手机号 > 姓名（手机号更精确、且能区分重名）。
 */
import { extractPhone, matchNameInText } from './tools/order.js';

export function detectOrderIntent(text) {
  const phone = extractPhone(text);
  if (phone) return { hit: true, phone, name: null };

  const name = matchNameInText(text);
  if (name) return { hit: true, phone: null, name };

  return { hit: false };
}
