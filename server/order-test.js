/**
 * 订单工具单元测试：纯本地、不消耗 Ollama、不消耗任何外部配额。
 * 覆盖：数据加载（CSV / XLSX 自动识别）、按快递单号、顺序id、部分单号、
 *       手机号、姓名查询、未找到、空输入、注册中心、executeTool。
 *
 * 运行：npm run test:order
 */
import assert from 'node:assert';
import { queryOrder, queryOrderByNo, orderStats, loadOrders } from './tools/order.js';
import { getToolSchemas, listTools, executeTool } from './tools/index.js';

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${extra ? ' → ' + extra : ''}`);
  }
}

console.log('[order] 加载订单数据');
loadOrders();
const stats = orderStats();
check('数据已加载且不少于 100 条', stats.loaded >= 100, `loaded=${stats.loaded}`);

console.log('[order] 按快递单号查询（精确）');
const r1 = queryOrder({ orderNo: 'SF133052943974' });
check('命中订单', r1.ok && !r1.notFound, JSON.stringify(r1.data));
check('收件人为吕静', r1.data.orders[0]?.name === '吕静', r1.data.orders[0]?.name);
check('物品为茶叶礼盒', r1.data.orders[0]?.item === '茶叶礼盒');
check('城市为哈尔滨', r1.data.orders[0]?.city === '哈尔滨');
check('订单状态为待收货', r1.data.orders[0]?.status === '待收货', r1.data.orders[0]?.status);
check('手机号完整（模型上下文用）', /^\d{11}$/.test(r1.data.orders[0]?.phone), r1.data.orders[0]?.phone);

console.log('[order] 大小写 / 空格容错');
const r1b = queryOrder({ orderNo: ' sf133052943974 ' });
check('小写+空格仍命中', r1b.ok && r1b.data.orders[0]?.orderNo === 'SF133052943974');

console.log('[order] 按顺序 id 查询');
const r2 = queryOrder({ orderNo: '1' });
check('顺序id=1 命中吕静', r2.ok && r2.data.orders[0]?.name === '吕静');

console.log('[order] 部分单号兜底（后 8 位）');
const tail = 'SF133052943974'.slice(-8); // 33052943
const r3 = queryOrder({ orderNo: tail });
check('后 8 位能匹配到同一单', r3.ok && r3.data.orders[0]?.orderNo === 'SF133052943974', r3.data.orders[0]?.orderNo);

console.log('[order] 按手机号查询');
const r4 = queryOrder({ phone: '13265525189' });
check('手机号命中吕静', r4.ok && r4.data.orders[0]?.name === '吕静');
check('手机号对应的单号为 SF133052943974', r4.data.orders[0]?.orderNo === 'SF133052943974');
const r4b = queryOrder({ phone: '132 6552 5189' });
check('手机号带空格仍能命中', r4b.ok && r4b.data.orders.length >= 1);

console.log('[order] 按姓名查询');
const r5 = queryOrder({ name: '董梦强' });
check('姓名命中且单号正确', r5.ok && r5.data.orders[0]?.orderNo === 'YD404883240898', r5.data.orders[0]?.orderNo);
check('姓名命中物品为羽绒服', r5.data.orders[0]?.item === '羽绒服');

console.log('[order] 未找到');
const nf1 = queryOrder({ orderNo: 'ZZ999999999999' });
check('不存在的单号返回 notFound', nf1.ok && nf1.notFound && nf1.data.count === 0);
const nf2 = queryOrder({ phone: '00000000000' });
check('不存在的手机号返回 notFound', nf2.ok && nf2.notFound && nf2.data.count === 0);
const nf3 = queryOrder({ name: '不存在的用户xyz' });
check('不存在的姓名返回 notFound', nf3.ok && nf3.notFound && nf3.data.count === 0);

console.log('[order] 空输入');
const e1 = queryOrder({});
check('无查询条件返回 notFound', e1.ok && e1.notFound && e1.data.count === 0);

console.log('[order] 向后兼容 queryOrderByNo');
const c1 = queryOrderByNo('SF133052943974');
check('queryOrderByNo 仍可查到', c1.ok && c1.data.orders[0]?.name === '吕静');

console.log('[intent] 确定性订单意图识别（旁路保底）');
import { extractPhone, matchNameInText } from './tools/order.js';
import { detectOrderIntent } from './intent-order.js';
check('extractPhone 从句子中提出手机号', extractPhone('帮我查手机号 13265525189 的订单') === '13265525189');
check('extractPhone 容忍连字符', extractPhone('请查 130-2323-9216') === '13023239216');
check('extractPhone 对订单号不误判', extractPhone('订单 SF133052943974') === null);
check('matchNameInText 命中已知姓名', matchNameInText('查客户董梦强的订单') === '董梦强');
check('detectOrderIntent 手机号命中', (() => { const r = detectOrderIntent('手机号13265525189的订单'); return r.hit && r.phone === '13265525189' && !r.name; })());
check('detectOrderIntent 姓名命中', (() => { const r = detectOrderIntent('董梦强买的东西到哪了'); return r.hit && r.name === '董梦强'; })());
check('detectOrderIntent 无关文本不命中', detectOrderIntent('上海今天天气怎么样').hit === false);

console.log('[tools] 注册中心');
const schemas = getToolSchemas();
check('至少注册 1 个工具', schemas.length >= 1);
check('query_order 在工具清单中', listTools().includes('query_order'));
check('schema 含 order_no / phone / name 三个可选参数',
  schemas[0].function?.parameters?.properties?.order_no &&
  schemas[0].function?.parameters?.properties?.phone &&
  schemas[0].function?.parameters?.properties?.name);
check('schema 三个参数均非必填（至少给其一即可）',
  Array.isArray(schemas[0].function?.parameters?.required) &&
  schemas[0].function.parameters.required.length === 0);

console.log('[tools] executeTool 执行');
const ex = executeTool('query_order', { order_no: 'SF133052943974' });
check('executeTool 返回 ok', ex.ok === true);
check('executeTool 返回 data.orders', ex.data && ex.data.orders[0]?.orderNo === 'SF133052943974');
const exPhone = executeTool('query_order', { phone: '13265525189' });
check('executeTool 支持手机号', exPhone.ok && exPhone.data.orders[0]?.name === '吕静');
const exName = executeTool('query_order', { name: '董梦强' });
check('executeTool 支持姓名', exName.ok && exName.data.orders[0]?.orderNo === 'YD404883240898');
const exBad = executeTool('no_such_tool', {});
check('未知工具返回 ok=false', exBad.ok === false);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
