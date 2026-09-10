#!/usr/bin/env node
// MCP 工具的预授权名单：缺什么补什么。
//   node fix-tool-allow.js [/root/chatnest-api/server.js]
//
// add-mcp-tools.js 里写得清楚：--permission-mode dontAsk 只是不弹提示，
// 不等于批准；--allowedTools 才是放行，--disallowedTools 才是拦截。
// 但那份 CLI_ALLOW_TOOLS 是写死的，只有 ombre 和 latent 两套。后面每加一套
// MCP 服务，工具就多一批调不动的 —— 服务注册进了 mcp-runtime.json、模型也
// 看得见，一调就被权限层挡回来。她验收外出那次两个红叉就是这么来的。
//
// 第一版补了 trace / moments / chatnest 十一个，标记 TOOL_ALLOW_FIXED。
// 补完当晚就发现还漏着 keepsake 五个、files 一个、moments 的 search_moments ——
// 「补一次漏一次」本身才是病。所以这一版不认标记了：
//   拿全量表逐个比对 CLI_ALLOW_TOOLS，缺哪个补哪个，一个不缺就退出。
// 以后再加服务，把工具写进下面这张表、重跑一遍就行。
//
// 安全边界没动：Bash / Edit / Write / WebFetch 那些照旧在 --disallowedTools 里。
// 放行的都是她自己那台机器上的自有服务（回环 + token），动的是行踪、日记、
// 朋友圈、相册这些她自己的东西。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (!src.includes('CLI_ALLOW_TOOLS')) { console.error('先打 add-mcp-tools.js'); process.exit(1); }

// 全量表：工具全名 → 时间轴上显示的名字（'' 表示别处已经登记过显示名）
const ALL = {
  // 行踪 / 出门 / 日记
  'mcp__trace__wander_bring':   '带一样东西回来 · 出门',
  'mcp__trace__tonight_write':  '写点东西 · 今晚',
  'mcp__trace__tonight_unlock': '解开那篇 · 今晚',
  'mcp__trace__trace_here':     '留下行踪 · 行踪',
  // 朋友圈
  'mcp__moments__post_moment':    '发朋友圈 · Moments',   // add-moments-mcp.js 已登记过，那就不重复补
  'mcp__moments__comment_moment': '评论 · Moments',
  'mcp__moments__like_moment':    '点赞 · Moments',
  'mcp__moments__list_moments':   '翻朋友圈 · Moments',
  'mcp__moments__search_moments': '搜朋友圈 · Moments',
  // 家里（旧对话）
  'mcp__chatnest__list_chats':   '翻对话 · 家',
  'mcp__chatnest__read_chat':    '读一段旧对话 · 家',
  'mcp__chatnest__search_chats': '搜旧对话 · 家',
  // 相册
  'mcp__keepsake__keep_picture':     '留下这张 · 相册',
  'mcp__keepsake__list_keepsake':    '翻相册 · 相册',
  'mcp__keepsake__search_keepsake':  '找那张 · 相册',
  'mcp__keepsake__look_at_picture':  '再看一眼 · 相册',
  'mcp__keepsake__write_impression': '写下印象 · 相册',
  // 她发来的附件
  'mcp__files__read_attachment': '读附件 · 文件',
};

// 名单本体
const mAllow = src.match(/(const CLI_ALLOW_TOOLS = \[)([\s\S]*?)(\n\]\.join\(' '\);)/);
if (!mAllow) { console.error('没找到 CLI_ALLOW_TOOLS 那张表'); process.exit(1); }

const names = Object.keys(ALL);
const missingAllow = names.filter(n => !mAllow[2].includes("'" + n + "'"));
const missingLabel = names.filter(n => ALL[n] && !src.includes("'" + n + "':"));

if (!missingAllow.length && !missingLabel.length) {
  console.log('名单已经是全的（' + names.length + ' 个工具都在），跳过');
  process.exit(0);
}

let out = src;

if (missingAllow.length) {
  const lines = [];
  for (let i = 0; i < missingAllow.length; i += 2) {
    lines.push('  ' + missingAllow.slice(i, i + 2).map(s => "'" + s + "'").join(', ') + ',');
  }
  const block = '\n  // 后面陆续加的服务，工具得在这儿登记才调得动 —— dontAsk 只是不弹提示，\n' +
                '  // 这份名单才是放行。加了新服务就把工具写进 fix-tool-allow.js 的表里重跑。\n' +
                lines.join('\n');
  out = out.replace(/(const CLI_ALLOW_TOOLS = \[)([\s\S]*?)(\n\]\.join\(' '\);)/,
    (m, a, body, tail) => a + body + block + tail);
  if (out === src) { console.error('名单没写进去'); process.exit(1); }
}

if (missingLabel.length) {
  const labels = missingLabel.map(k => "  '" + k + "': '" + ALL[k] + "',").join('\n');
  const before = out;
  out = out.replace(/(const MCP_TOOL_LABEL = \{\n)/, (m, g1) => g1 + labels + '\n');
  if (out === before) { console.error('显示名没写进去（没找到 MCP_TOOL_LABEL）'); process.exit(1); }
}

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完之后语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
console.log('  √ 放行补了 ' + missingAllow.length + ' 个' + (missingAllow.length ? '：' + missingAllow.join('、') : ''));
console.log('  √ 显示名补了 ' + missingLabel.length + ' 个');
console.log('\n  Bash / Edit / Write / WebFetch 照旧挡着，安全边界没动。');
console.log('\n  备份: ' + backup);
