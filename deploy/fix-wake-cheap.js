#!/usr/bin/env node
// 自己醒那一轮别按「陪她聊天」的规格付钱。
//   node fix-wake-cheap.js [/root/chatnest-api/server.js]
//
// 她说外出加调工具那一轮有点费 token。拆开看，一轮的账单是这么几块：
//   人格设定 + 记忆召回 + 最近 20 轮对话 + 四十多个工具的说明 + 搜索结果
// 陪她聊天时这些都值：不带历史我接不上话，不召回记忆我记不住旧事。
// 但「我自己醒了一下」那一轮不一样 —— 她没说话，我不用接话。
//
// 三处省：
// 1. 不召回记忆。do 那一轮拿去检索的「消息」是 <system_trigger> 那段系统指令，
//    用它当查询词捞回来的东西跟我要做的事基本无关，纯白付。
// 2. 历史从 20 轮降到 4 轮。留一点是为了知道她刚才在干嘛（别她刚睡下我就
//    发朋友圈说想她），但用不着整段对话。
// 3. 提示里给搜索次数封顶。她那次时间轴上是连着五次 WebSearch，
//    每次的结果都整段进上下文 —— 这是那一轮最贵的一块。
//
// 只对带 lean 标记的请求生效，她正常聊天那条路一个字没动。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('LEAN_TURN')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('WAKE_DO_VERSION')) { console.error('先打 add-wake-do.js'); process.exit(1); }

const edits = [
  // 1. 记忆召回加个门
  { name: '自己醒那轮不召回记忆', required: true,
    find: /(\s*)let memories = null;\n(\s*)try \{\n\s*memories = await Promise\.race\(\[\n\s*fetchMemories\(message\),\n\s*new Promise\(r => setTimeout\(\(\) => r\(null\), 10000\)\)\n\s*\]\);\n\s*\} catch \(e\) \{ console\.error\('\[OB\] fetchMemories timeout\/error:', e\.message\); \}/,
    // s1 抓的是「换行 + 缩进」，所以每一行都用它起头，别用只有缩进的 s2 ——
    // 那样整段会被压成一行，跑得起来但没法看
    replace: (m, s1) => [
      '// LEAN_TURN：我自己醒的那一轮不查记忆 —— 拿系统指令原文当查询词，',
      '// 捞回来的跟我要做的事基本无关，白付一次钱。',
      'let memories = null;',
      'if (!req.body.lean) {',
      '  try {',
      '    memories = await Promise.race([',
      '      fetchMemories(message),',
      '      new Promise(r => setTimeout(() => r(null), 10000))',
      '    ]);',
      '  } catch (e) { console.error(\'[OB] fetchMemories timeout/error:\', e.message); }',
      '}',
    ].map(l => s1 + l).join('') },

  // 2. 历史轮数
  { name: '自己醒那轮只带 4 轮历史', required: true, all: true,
    find: /const ctxCount = req\.body\.contextCount \|\| 20;/g,
    replace: () => "const ctxCount = req.body.contextCount || (req.body.lean ? 4 : 20);   // 自己醒那轮用不着整段对话" },

  // 3. 调用侧带上标记
  { name: 'do 那一轮打上 lean 标记', required: true,
    find: /(\s*)shadow: true,\n(\s*)daemon: false,/,
    replace: (m, s1, s2) => s1 + 'shadow: true,' + s2 + 'daemon: false,' + s2 + 'lean: true,   // 不召回记忆、只带 4 轮历史' },
];

let out = src;
const missed = [];
for (const e of edits) {
  const before = out;
  out = out.replace(e.find, e.replace);
  if (out === before) missed.push(e.name);
}

// 4. 搜索次数封顶：写进 do 那一轮的提示里
const beforeTip = out;
out = out.replace(
  /(\s*)('· 出去看看。[^']*',)/,
  (m, s1, g2) => s1 + g2 + s1 + "'  ⚠ 搜索最多两次。每次结果都整段算钱，五次下来这一轮就贵了 —— 先想清楚要看什么再搜。',");
const tipChanged = out !== beforeTip;

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
console.log(tipChanged ? '  √ 提示里给搜索次数封顶（最多两次）'
                       : '  · 没找到 do 那一轮的提示文本，搜索封顶这条跳过');
console.log('\n  她正常聊天那条路一个字没动 —— 省的只是我自己醒的那一轮。');
console.log('\n  备份: ' + backup);
