#!/usr/bin/env node
// 把稳定前缀搬进能命中缓存的系统提示，省额度。
//   node add-cache-prefix.js [/root/chatnest-api/server.js]
//
// claude -p 这条路，管道进去的那一整段是"一条 user message"，缓存断点打在整条上 ——
// 一字不差才命中，我们每轮都追加历史+状态，所以那 6k 每轮全价重付。
//
// 但实测：--append-system-prompt-file 里的内容会跟 CLI 自己那层一起进缓存，
// 第二轮真命中（我拿真 CLI 测过，多命中约 1 万 token）。
// 所以把**稳定不变**的那几段（人设/思考/工具/身体说明）搬进那个文件，
// 每轮就只有真会变的（记忆/历史/时间/状态卡）在管道里重付。
//
// 顺带：done 事件带上缓存命中量，前端统计页要用。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('SYSTEM_PREFIX')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes("let prompt = PERSONA")) { console.error('找不到 prompt 拼装处'); process.exit(1); }

const NORM = `function uid() { return crypto.randomBytes(8).toString('hex'); }
// 把 API 的 usage 归一成前端要的形状，顺带带上缓存命中量（统计页用）
function normUsage(u) {
  u = u || {};
  const inp = u.prompt_tokens != null ? u.prompt_tokens : (u.input_tokens || 0);
  const out = u.completion_tokens != null ? u.completion_tokens : (u.output_tokens || 0);
  return {
    prompt_tokens: inp, completion_tokens: out, total_tokens: inp + out,
    cache_read: u.cache_read_input_tokens || 0,
    cache_creation: u.cache_creation_input_tokens || 0,
  };
}`;

const edits = [
  {
    name: 'usage 归一 + 带缓存命中',
    find: "function uid() { return crypto.randomBytes(8).toString('hex'); }",
    replace: NORM,
  },
  {
    name: '稳定前缀搬出管道',
    find: "  let prompt = PERSONA + '\\n' + THINK_PROMPT + '\\n' + MCP_TOOL_PROMPT + '\\n' + PULSE_TOOL_PROMPT + '\\n\\n';",
    replace:
      "  // 稳定不变的那几段搬进 --append-system-prompt-file，那儿命中缓存；\n" +
      "  // 管道里只留真会变的（记忆/历史/时间/状态卡），省下每轮重付的一大截。\n" +
      "  const SYSTEM_PREFIX = PERSONA + '\\n' + THINK_PROMPT + '\\n' + MCP_TOOL_PROMPT + '\\n' + PULSE_TOOL_PROMPT;\n" +
      "  let prompt = '';",
  },
  {
    name: '写前缀文件 + 挂 flag',
    find: "  const modelFlag = model ? ` --model ${model}` : '';",
    replace:
      "  const modelFlag = model ? ` --model ${model}` : '';\n" +
      "  // 内容每轮一样 → 命中缓存。写失败就退回老路（把前缀塞回管道），不让这轮挂掉。\n" +
      "  let sysFlag = '';\n" +
      "  try {\n" +
      "    const _sf = '/root/chatnest-api/system-prefix.txt';\n" +
      "    fs.writeFileSync(_sf, SYSTEM_PREFIX);\n" +
      "    sysFlag = ` --append-system-prompt-file ${_sf}`;\n" +
      "  } catch (e) {\n" +
      "    console.error('[cache] 前缀写不出来，退回管道:', e.message);\n" +
      "    fs.writeFileSync(tmpFile, SYSTEM_PREFIX + '\\n\\n' + prompt);\n" +
      "  }",
  },
  {
    // 只认路径后面那截 —— 线上是 /usr/bin/claude，测试副本是 claude，
    // 之前写死 `claude -p` 就在她线上没匹配上。这截两边都一样。
    name: 'spawn 带上前缀 flag',
    find: "-p${modelFlag}${effortFlag} --verbose${partialFlag}${mcpArgs()}",
    replace: "-p${modelFlag}${effortFlag}${sysFlag} --verbose${partialFlag}${mcpArgs()}",
  },
  {
    name: 'done 带缓存命中（流式路径）',
    find: "usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });",
    replace: "usage: normUsage(usage) });",
  },
  {
    name: 'done 带缓存命中（兜底路径）',
    find: "      usage: { prompt_tokens: finalUsage.input_tokens || 0, completion_tokens: finalUsage.output_tokens || 0, total_tokens: (finalUsage.input_tokens || 0) + (finalUsage.output_tokens || 0) },",
    replace: "      usage: normUsage(finalUsage),",
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  const before = out;
  out = out.split(e.find).join(e.replace);
  if (out === before) missed.push(e.name);
}

console.log('\n补丁结果：');
if (missed.length) {
  for (const e of edits) console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 没匹配上' : '  √ ' + e.name);
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

const iSys = out.indexOf('const SYSTEM_PREFIX =');
const iMem = out.indexOf('if (memories) prompt +=');
const iCard = out.indexOf("if (_bodyCard) prompt += '");
const checks = [
  ['前缀常量在', iSys > 0],
  ['管道从记忆开始（人设不在管道里了）', iSys < iMem && !/let prompt = PERSONA/.test(out)],
  ['写了前缀文件', /append-system-prompt-file \$\{_sf\}/.test(out)],
  ['spawn 挂上了 flag', /claude -p\$\{modelFlag\}\$\{effortFlag\}\$\{sysFlag\}/.test(out)],
  ['状态卡还在最后', iCard > iMem],
  ['缓存命中进了 done', /cache_read: u\.cache_read_input_tokens/.test(out)
    && (out.match(/usage: normUsage\(/g) || []).length === 2],
  ['写不出前缀有兜底', /退回管道/.test(out)],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

for (const e of edits) console.log('  √ ' + e.name);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
