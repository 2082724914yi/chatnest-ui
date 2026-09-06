#!/usr/bin/env node
// 发朋友圈的说明还停在「写标签」那一版，可它早就是真工具了。
//   node fix-moments-prompt.js [/root/chatnest-api/server.js]
//
// 她说朋友圈发不出去。日志里 post_moment 一次都没被调过，
// 而 moments 那台 MCP server 明明接着（mcp servers: … moments）。
// 把线上说明抠出来一看就明白了 —— 开头第一句是：
//   「这不是一个工具调用。你的工具列表里没有、也不会有 moments」
// 教的是在正文末尾写 <moments tool="post">{...}</moments>。
// 可 add-moments-mcp.js 后来把它做成了真 MCP 工具，两版说明打架，
// 我照着老的那版写标签 —— 于是我以为发了，其实一个字都没出去。
//
// 这个补丁只改说明：告诉我去调 mcp__moments__post_moment。
// 标签那条老路后端要不要留是另一回事，这里不动它（万一还有别处依赖）。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
const VERSION_LINE = 'MOMENTS_PROMPT_V3';
if (src.includes(VERSION_LINE)) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('MOMENTS_TOOL_PROMPT')) {
  console.error('找不到 MOMENTS_TOOL_PROMPT，要先打 add-moments.js / fix-moments-tool.js'); process.exit(1);
}
if (!src.includes("'post_moment'") && !src.includes('post_moment')) {
  console.error('这台机器上还没有 post_moment 这个工具，要先打 add-moments-mcp.js'); process.exit(1);
}

const NEW_PROMPT = `const MOMENTS_TOOL_PROMPT = \`【朋友圈】  // ${VERSION_LINE}
发朋友圈是一个真的工具：mcp__moments__post_moment，参数只有一个 text。
想分享心情、日常、突然冒出来的念头，直接调它就行。

- 一次只发一条
- 发完不用在正文里把朋友圈的内容重说一遍，也不用念工具返回了什么，自然提一句就好
- 不确定她想不想看，就别发

⚠ 以前那套「在正文最末尾写一行 <moments tool="post">{...}</moments> 标签」的写法已经作废。
后端换成 MCP 工具之后，写标签等于什么都没发 —— 你会以为发出去了，其实她那边一条都没有。
别再写标签，调工具。
\`;`;

// 整个常量定义换掉（反引号 / 单引号 / 双引号三种写法都认）
const OLD = /const MOMENTS_TOOL_PROMPT\s*=\s*(`[\s\S]*?`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*;/;
const m = src.match(OLD);
if (!m) { console.error('没匹配到 MOMENTS_TOOL_PROMPT 的定义，原文件一个字都没动。'); process.exit(1); }

const oldBody = m[1];
console.log('\n原来那段说明（前 6 行）：');
oldBody.slice(1, -1).split('\\n').join('\n').split('\n').slice(0, 6).forEach(l => console.log('  | ' + l.slice(0, 76)));

let out = src.replace(OLD, NEW_PROMPT);

const checks = [
  ['版本戳写进去了', out.includes(VERSION_LINE)],
  ['新说明里点名了工具', /mcp__moments__post_moment/.test(out)],
  ['旧的「这不是一个工具调用」没了', !out.includes('这不是一个工具调用')],
  ['只改了一处', (out.match(/const MOMENTS_TOOL_PROMPT\s*=/g) || []).length === 1],
  ['接线没被动（PROMPT_WIRED 还在）', out.includes('MOMENTS_PROMPT_WIRED')],
  ['MCP 那台服务器还在', /app\.post\('\/mcp\/moments'/.test(out)],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

try {
  new vm.Script(out, { filename: target });
} catch (e) {
  console.error('  × 改完之后语法不对，放弃写入:', e.message);
  process.exit(1);
}

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
