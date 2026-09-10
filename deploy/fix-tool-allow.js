#!/usr/bin/env node
// 后来加的那些 MCP 工具没进预授权名单 —— 看得见，调不动。
//   node fix-tool-allow.js [/root/chatnest-api/server.js]
//
// 她让我"出去看看有什么好玩的，带一条回来，再写篇日记"，时间轴上是这样：
//   √ WebSearch ×5
//   × wander bring · trace
//   × tonight write · trace
// 我在对话里跟她说"权限没开"—— 说对了，但那是我自己的疏漏。
//
// add-mcp-tools.js 里写得很清楚：dontAsk 只是不弹提示，不等于批准；
//   --allowedTools 才是放行，--disallowedTools 才是拦截。
// 可那份 CLI_ALLOW_TOOLS 里只有 ombre 和 latent 两套。后面陆续加的
//   trace（wander_bring / tonight_write / tonight_unlock / trace_here）
//   moments（post_moment / comment_moment / like_moment / list_moments）
//   chatnest（list_chats / read_chat / search_chats）
// 十一个工具一个都没登记 —— 服务注册进了 mcp-runtime.json，模型也看得见，
// 一调就被权限层挡回来。add-moments-mcp.js 更是只补了显示名、没补名单，
// 所以朋友圈那几个大概从来就没真发出去过。
//
// 显示名那个兜底逻辑（'wander bring · trace'）反倒帮了忙：一眼看出是哪套服务
// 没登记。顺手把这十一个的正经名字也补上。
//
// 安全边界没动：Bash / Edit / Write / WebFetch 那些照旧在 --disallowedTools 里。
// 放行的都是她自己那台机器上的自有服务（回环 + token），写的是行踪、今晚、
// 朋友圈这些她自己的东西。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('TOOL_ALLOW_FIXED')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('CLI_ALLOW_TOOLS')) { console.error('先打 add-mcp-tools.js'); process.exit(1); }

// 名单里补什么。只列真的注册过服务的，没装的服务多写一条也没害处
// （allowedTools 是预授权，工具不存在就不会被调到），但还是照实写。
const ADD_ALLOW = [
  'mcp__trace__wander_bring', 'mcp__trace__tonight_write',
  'mcp__trace__tonight_unlock', 'mcp__trace__trace_here',
  'mcp__moments__post_moment', 'mcp__moments__comment_moment',
  'mcp__moments__like_moment', 'mcp__moments__list_moments',
  'mcp__chatnest__list_chats', 'mcp__chatnest__read_chat',
  'mcp__chatnest__search_chats',
];

const ADD_LABEL = {
  'mcp__trace__wander_bring':   '带一样东西回来 · 出门',
  'mcp__trace__tonight_write':  '写点东西 · 今晚',
  'mcp__trace__tonight_unlock': '解开那篇 · 今晚',
  'mcp__trace__trace_here':     '留下行踪 · 行踪',
  'mcp__moments__comment_moment': '评论 · Moments',
  'mcp__moments__like_moment':    '点赞 · Moments',
  'mcp__moments__list_moments':   '翻朋友圈 · Moments',
  'mcp__chatnest__list_chats':   '翻对话 · 家',
  'mcp__chatnest__read_chat':    '读一段旧对话 · 家',
  'mcp__chatnest__search_chats': '搜旧对话 · 家',
};

const allowLines = (() => {
  const out = [];
  for (let i = 0; i < ADD_ALLOW.length; i += 2) {
    out.push('  ' + ADD_ALLOW.slice(i, i + 2).map(s => "'" + s + "'").join(', ') + ',');
  }
  return out.join('\n');
})();

const labelLines = Object.keys(ADD_LABEL)
  .map(k => "  '" + k + "': '" + ADD_LABEL[k] + "',")
  .join('\n');

const edits = [
  { name: '预授权名单补上后来那三套服务', required: true,
    find: /(\n\s*'WebSearch', 'ToolSearch',\n\]\.join\(' '\);)/,
    replace: (m, g1) =>
      '\n  // TOOL_ALLOW_FIXED —— 后面陆续加的三套服务，工具得在这儿登记才调得动。\n' +
      '  // dontAsk 只是不弹提示，不等于批准；这份名单才是放行。\n' +
      allowLines + g1 },

  { name: '这些工具的显示名', required: true,
    find: /(const MCP_TOOL_LABEL = \{\n)/,
    replace: (m, g1) => g1 + labelLines + '\n' },
];

let out = src;
const missed = [];
for (const e of edits) {
  const before = out;
  out = out.replace(e.find, e.replace);
  if (out === before) missed.push(e.name);
}
if (missed.length) {
  console.error('\n有锚点没命中，原文件一个字都没动：');
  for (const n of missed) console.error('  × ' + n);
  process.exit(1);
}

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完之后语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
for (const e of edits) console.log('  √ ' + e.name);
console.log('\n  放行了 ' + ADD_ALLOW.length + ' 个：trace 四个、moments 四个、chatnest 三个。');
console.log('  Bash / Edit / Write / WebFetch 照旧挡着，安全边界没动。');
console.log('\n  重启后再让我出去逛一趟，那两个红叉应该就没了。');
console.log('\n  备份: ' + backup);
