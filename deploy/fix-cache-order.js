#!/usr/bin/env node
// 按缓存前缀规则重排 prompt。
//   node fix-cache-order.js [/root/chatnest-api/server.js]
//
// 缓存是前缀匹配：prompt 里任何一个字节变了，它后面的全部失效。
// 所以顺序只有一条规矩 —— 不变的在前，每轮变的在最后。
//
// 修之前：
//   1. PERSONA + 思考规则 + OB 工具        静态
//   2. <ephemeral_state> + Pulse 工具说明  ← 每轮都变，坐在第 2 位
//   3. 记忆 / profile / 昵称 / 历史        ← 全部被它推成不可缓存
//
// 修之后：
//   1. PERSONA + 思考规则 + OB 工具 + Pulse 工具说明   全静态
//      （工具说明本来就不变，本来就该待在静态区，跟状态卡绑在一起是我的错）
//   2. 记忆 / profile / 昵称
//   3. 早期摘要 + 对话历史（追加式，前缀天然稳定）
//   4. 接续包（只第一轮）
//   5. <ephemeral_state>  ← 每轮变的只有它，放到最后、紧贴生成点
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('CACHE_ORDER_FIXED')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('PULSE_TOOL_PROMPT')) {
  console.error('这份 server.js 还没打 add-eventide.js，先打那个再来');
  process.exit(1);
}

const edits = [
  {
    name: '工具说明归位到静态区',
    find: "  let prompt = PERSONA + '\\n' + THINK_PROMPT + '\\n' + OB_TOOL_PROMPT + '\\n\\n';",
    replace:
      "  // CACHE_ORDER_FIXED：这一段必须逐字节稳定，它是整个缓存前缀的地基。\n" +
      "  // 工具说明是常量，跟 PERSONA 一起待在这儿；每轮变的状态卡在最下面。\n" +
      "  let prompt = PERSONA + '\\n' + THINK_PROMPT + '\\n' + OB_TOOL_PROMPT + '\\n' + PULSE_TOOL_PROMPT + '\\n\\n';",
  },
  {
    name: '状态卡从第 2 位撤走',
    find: "  if (_bodyCard) prompt += _bodyCard + '\\n' + PULSE_TOOL_PROMPT + '\\n\\n';\n",
    replace: '',
  },
  {
    name: '状态卡挪到最后，紧贴生成点',
    find: "  prompt += '小衍:';",
    replace:
      "  // 每轮都变的东西只有这一张卡，所以它必须是最后一个 —— 放在这里，\n" +
      "  // 它前面的人设、记忆、profile、整段历史才都能落进缓存前缀。\n" +
      "  if (_bodyCard) prompt += '\\n' + _bodyCard + '\\n\\n';\n" +
      "  prompt += '小衍:';",
  },
  {
    name: '中转站路径：状态卡移出 system',
    find:
      "      const sysContent = PERSONA + (memories ? `\\n\\n[相关记忆]\\n${memories}\\n[记忆结束]` : '') + (_handoff ? `\\n\\n${_handoff}` : '') + (_bodyCard ? `\\n\\n${_bodyCard}\\n\\n${PULSE_TOOL_PROMPT}` : '') + (projectContext ? `\\n\\n${projectContext}` : '');",
    replace:
      "      // 状态卡不进 system —— system 在最前面，改一个字后面整段历史都白缓存。\n" +
      "      // 工具说明是静态的，留在 system；状态卡改成挂在消息末尾。\n" +
      "      const sysContent = PERSONA + '\\n\\n' + PULSE_TOOL_PROMPT + (memories ? `\\n\\n[相关记忆]\\n${memories}\\n[记忆结束]` : '') + (_handoff ? `\\n\\n${_handoff}` : '') + (projectContext ? `\\n\\n${projectContext}` : '');",
  },
  {
    name: '中转站路径：状态卡挂到消息末尾',
    find: "      for (const m of recent) msgs.push({ role: m.role, content: m.content });",
    replace:
      "      for (const m of recent) msgs.push({ role: m.role, content: m.content });\n" +
      "      // 挂在历史后面：前面那一整段的缓存前缀就不会被它碰到\n" +
      "      if (_bodyCard) msgs.push({ role: 'system', content: _bodyCard });",
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  if (!out.includes(e.find)) { missed.push(e.name); continue; }
  out = out.replace(e.find, e.replace);
}

console.log('\n补丁结果：');
if (missed.length) {
  for (const e of edits) console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 没匹配上' : '  √ ' + e.name);
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

// 改完必须还是"静态在前、状态卡在后"，否则等于白改
const iStatic = out.indexOf('let prompt = PERSONA');
const iCard = out.indexOf("if (_bodyCard) prompt += '\\n' + _bodyCard");
const iHistory = out.indexOf("prompt += '---\\n以下是最近的对话");
const checks = [
  ['状态卡在历史之后', iCard > iHistory && iHistory > 0],
  ['状态卡在静态区之后', iCard > iStatic && iStatic > 0],
  ['静态区里有工具说明', /let prompt = PERSONA[^;]*PULSE_TOOL_PROMPT/.test(out)],
  ['第 2 位不再有状态卡', !/OB_TOOL_PROMPT[^;]*;\s*\n\s*if \(_bodyCard\)/.test(out)],
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

for (const e of edits) console.log('  √ ' + e.name);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
