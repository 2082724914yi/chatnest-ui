#!/usr/bin/env node
// 把朋友圈的用法说清楚：它不是 MCP 工具，别去工具列表里找。
//   node fix-moments-say.js [/root/chatnest-api/server.js]
//
// 上一版说明写的是「用法：加上这个标签」，可我现在手上的记忆工具都是真的 MCP
// 工具（ombre / latent），看到「用法」两个字就本能去 ToolSearch 里翻，翻不到
// moments 就卡住了，最后只把那坨 JSON 打在正文里 —— 她看到的就是这个。
//
// 说明里现在把话挑明：这不是工具调用，就是在正文末尾原样写一行标签，
// 后端会把它拦下来，她看不见。
//
// 顺便报一下 prompt 到底接上没有（MOMENTS_PROMPT_WIRED 在不在）。
//
// 重复执行安全：已经是这一版就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');

console.log('\n先报状态：');
console.log('  ' + (src.includes('MOMENTS_TOOL_PROMPT') ? '√' : '×') + ' 说明变量 MOMENTS_TOOL_PROMPT 存在');
const wired = src.includes('MOMENTS_PROMPT_WIRED');
console.log('  ' + (wired ? '√' : '×') + ' 说明已接进 prompt（MOMENTS_PROMPT_WIRED）');
if (!wired) {
  console.log('    ↑ 这条是 × 的话，说明先得跑 fix-moments-tool.js，不然我看不到说明。');
}
const leak = /open:\s*'<moments'/.test(src);
console.log('  ' + (leak ? '√' : '·') + ' 流式时会吞掉 <moments> 标签');

if (src.includes('MOMENTS_SAY_V2')) { console.log('\n说明已经是新版，跳过。'); process.exit(0); }

// 把 MOMENTS_TOOL_PROMPT = `...`; 整段换掉，不管里面原来写的是什么
const start = src.indexOf('const MOMENTS_TOOL_PROMPT = `');
if (start < 0) { console.error('\n找不到 MOMENTS_TOOL_PROMPT 的定义，先打 add-moments.js'); process.exit(1); }
const bodyStart = start + 'const MOMENTS_TOOL_PROMPT = `'.length;
let end = -1;
for (let i = bodyStart; i < src.length; i++) {
  if (src[i] === '`' && src[i - 1] !== '\\') { end = i; break; }
}
if (end < 0) { console.error('\nMOMENTS_TOOL_PROMPT 的反引号没闭合，不敢动'); process.exit(1); }
const tail = src.slice(end + 1, end + 3); // 应该是 ";
const NEW_BODY = `
关于发朋友圈 —— 先说清楚：这不是一个工具调用。你的工具列表里没有、也不会有
moments，不用去 ToolSearch 里找它。

你要做的只有一件事：在回复正文的最末尾，原样写出下面这一行。

<moments tool="post">{"text":"想说的话"}</moments>

后端会把这一行拦下来、发成朋友圈，然后从正文里剥掉，她看不见这行字。
所以：

- 别把 {"text": ...} 单独打在正文里 —— 那样只是聊天里多出一坨 JSON，发不出去
- 标签要完整闭合，<moments 开头，</moments> 结尾，写在一行里
- 里面是合法 JSON，用双引号；要换行就写 \\\\n，别真敲回车
- 一次只发一条
- 正文里不用重复朋友圈的内容，也不用念结果，自然提一句就好

想分享心情、日常、突然冒出来的念头，就发。不确定她想不想看，就别发。
`;
const out = src.slice(0, start) + 'const MOMENTS_TOOL_PROMPT = `' + NEW_BODY + '`; // MOMENTS_SAY_V2' +
            src.slice(end + 1 + (tail.startsWith('`;') ? 0 : 0)).replace(/^`?;?/, '');

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('\n  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);
console.log('\n  √ 说明已换成「这不是工具」的版本');
console.log('  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
