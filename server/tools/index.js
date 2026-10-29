/**
 * 工具注册中心。
 *
 * 这里集中登记所有可被模型调用的「工具」。每个工具形如：
 *   {
 *     name,            // 工具名，对应 Ollama tools[].function.name
 *     description,     // 给模型看的自然语言说明（要讲清楚「什么时候用、参数是什么」）
 *     parameters,      // JSON Schema，描述入参
 *     run(args),       // 执行逻辑，返回 { ok, summary, data }；summary 会喂回模型，data 给前端渲染卡片
 *   }
 *
 * chat.js 在请求模型时把 getToolSchemas() 挂到 tools 字段；
 * 模型若返回 tool_calls，就交给 executeTool() 逐个执行。
 */
import { queryOrder } from './order.js';

const REGISTRY = {
  query_order: {
    name: 'query_order',
    description:
      '查询订单详情，可凭「订单号/快递单号」「收件人手机号」「收件人姓名」三者之一查询，' +
      '返回收件人、手机号、收货城市、购买物品、订单状态等。' +
      '当用户提到「订单」「快递单号」「我的包裹/物流」「查一下尾号xxxx的快递」' +
      '或提供手机号/收件人姓名询问购买记录时调用。一次只传用户给出的线索即可。',
    parameters: {
      type: 'object',
      properties: {
        order_no: {
          type: 'string',
          description: '订单号或快递单号，例如 SF133052943974。用户给出单号时填这个。',
        },
        phone: {
          type: 'string',
          description: '收件人手机号，例如 13265525189。用户报手机号时填这个。',
        },
        name: {
          type: 'string',
          description: '收件人姓名，例如 吕静。用户报姓名时填这个。',
        },
      },
      required: [],
    },
    run: (args) => queryOrder(args || {}),
  },
};

/** 导出给 Ollama 的 tools 结构 */
export function getToolSchemas() {
  return Object.values(REGISTRY).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** 已注册工具名列表（供前端 / 运维展示） */
export function listTools() {
  return Object.keys(REGISTRY);
}

/**
 * 执行一个工具调用。
 * @returns {{ok:boolean, error?:string, summary?:string, data?:any}}
 */
export function executeTool(name, args) {
  const tool = REGISTRY[name];
  if (!tool) return { ok: false, error: `未知工具：${name}` };
  try {
    const r = tool.run(args || {});
    if (r && r.summary) return r;
    return { ok: true, summary: JSON.stringify(r ?? null), data: r };
  } catch (err) {
    return { ok: false, error: `工具执行失败：${err.message}` };
  }
}
