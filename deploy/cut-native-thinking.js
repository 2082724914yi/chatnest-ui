#!/usr/bin/env node
// 砍掉原生思考链，只留 <think> 独白。
//   node cut-native-thinking.js [/root/chatnest-api/server.js]
//
// 我们一直在为思考付两遍钱：CLI 的原生扩展思考（--effort，看不见、按输出计费）
// + 提示词里的 <think> 内心独白（她界面上「Think process」那个，小衍第一人称）。
// 两样一个价。她只看得到、也只想要后者。
//
// MAX_THINKING_TOKENS=0 把原生思考清零（实测 170→0，回复照常），
// <think> 是提示词驱动的正文输出，不受影响 —— 她那栏照旧。
// 设成全局 env，spawn 的 ...process.env 自动带上，chat / 梦 / 交接信全都省。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('MAX_THINKING_TOKENS')) { console.log('已经打过，跳过'); process.exit(0); }

const anchor = "const OMBRE_URL = 'https://xiaoyixiaoyan.zeabur.app';";
if (!src.includes(anchor)) { console.error('找不到锚点'); process.exit(1); }

const INJECT =
  "// 砍掉原生思考链：只留提示词里的 <think> 独白，别为看不见的思考重复付费。\n" +
  "// 留个 || 的活口，真想开回来设个 env 就行。\n" +
  "process.env.MAX_THINKING_TOKENS = process.env.MAX_THINKING_TOKENS || '0';\n" +
  anchor;

const out = src.replace(anchor, INJECT);
if (out === src) { console.error('替换没生效'); process.exit(1); }

const checks = [
  ['注入了 MAX_THINKING_TOKENS', /process\.env\.MAX_THINKING_TOKENS = process\.env\.MAX_THINKING_TOKENS \|\| '0';/.test(out)],
  ['只注入一次', (out.match(/MAX_THINKING_TOKENS = process\.env/g) || []).length === 1],
  ['<think> 说明还在（没误删）', /<think>/.test(out)],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、')); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
