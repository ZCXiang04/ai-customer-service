/**
 * 前端 Markdown 渲染器自测：node server/md-render-test.js
 *
 * 被测代码在 web/app.js 的 IIFE 里，这里从源码中截取「自研 Markdown」整段来跑。
 * 重点验证 XSS 转义与链接协议白名单 —— 模型输出是不可信输入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

const start = src.indexOf('function escapeHtml');
const end = src.indexOf('/* ── 消息渲染');
if (start < 0 || end < 0) {
  console.error('未能在 web/app.js 中定位 Markdown 段落，测试脚本需要更新截取标记');
  process.exit(1);
}
const code = src.slice(start, end);

const { mdToHtml, escapeHtml } = new Function(
  `${code}; return { mdToHtml, escapeHtml };`
)();

let failures = 0;
function check(cond, label, extra = '') {
  if (cond) console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`);
  }
}

console.log('=== Markdown 渲染器自测 ===\n');

console.log('[1] XSS 转义');
const xss = mdToHtml('<script>alert(1)</script>');
check(!xss.includes('<script>'), '原始 script 标签被转义');
check(xss.includes('&lt;script&gt;'), '转义为实体', xss.slice(0, 40));
const img = mdToHtml('<img src=x onerror=alert(1)>');
check(!/<img/.test(img), 'img 标签被转义');

console.log('\n[2] 链接协议白名单');
const js = mdToHtml('[点我](javascript:alert(1))');
check(!js.includes('javascript:'), 'javascript: 被拦截', js.slice(0, 60));
const http = mdToHtml('[官网](https://example.com)');
check(http.includes('href="https://example.com"'), 'https 链接保留');
check(http.includes('rel="noopener noreferrer"'), '外链带 noopener');

console.log('\n[3] 代码块');
const cb = mdToHtml('```js\nconst a = 1;\n```');
check(cb.includes('<pre>') && cb.includes('<code>'), '生成 pre/code');
check(cb.includes('code-lang') && cb.includes('js'), '带语言标签');
check(cb.includes('tok-key'), '关键字着色', 'const → tok-key');
check(!cb.includes('<script>'), '代码内容已转义');

console.log('\n[4] 行内与强调');
check(mdToHtml('`code`').includes('<code>code</code>'), '行内代码');
check(mdToHtml('**粗**').includes('<strong>粗</strong>'), '粗体');
check(mdToHtml('*斜*').includes('<em>斜</em>'), '斜体');
const mixed = mdToHtml('`a<b`');
check(!mixed.includes('<b>'), '行内代码中的尖括号被转义');

console.log('\n[5] 块级结构');
check(mdToHtml('## 标题').includes('<h2>'), '二级标题');
check(mdToHtml('- a\n- b').includes('<ul>') && mdToHtml('- a\n- b').includes('<li>'), '无序列表');
check(mdToHtml('1. a\n2. b').includes('<ol>'), '有序列表');
check(mdToHtml('> 引用').includes('<blockquote>'), '引用');
check(mdToHtml('---').includes('<hr>'), '分割线');
const table = mdToHtml('| a | b |\n|---|---|\n| 1 | 2 |');
check(table.includes('<table>') && table.includes('<th>'), '表格');

console.log('\n[6] escapeHtml 直接验证');
check(escapeHtml('<>&"\'') === '&lt;&gt;&amp;&quot;&#39;', '五个危险字符全部转义');

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
