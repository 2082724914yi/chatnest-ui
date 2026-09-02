#!/usr/bin/env node
/* 热修：feedText 里引用了线上不存在的 cotState，导致每次流到 <think> 就抛
   ReferenceError，进程崩溃、pm2 重启，于是 done 事件发不出去、对话存不下来、
   前端每次都当新会话开、每条消息都触发 breath。四个症状同一个原因。

   cotState 只用来统计思考字数（COT Guard），有没有都不影响功能，
   所以加一层存在性判断即可。

   用法：curl -fsSL .../deploy/hotfix-cotstate.js | sudo node -
   安全：先备份，写入前语法校验，可重复执行。 */
const fs = require('fs');
const path = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(path)) { console.error('找不到文件:', path); process.exit(1); }
let s = fs.readFileSync(path, 'utf8');
const orig = s;

// 先判这个：修完之后保护函数内部仍然含有 cotState.addThinking，
// 若先判后者会误认为还没修，再跑一次就会把保护函数自己也替换掉。
if (s.includes('_cotSafe')) { console.log('已经修过了，无需重复执行。'); process.exit(0); }
if (!s.includes('cotState.addThinking')) {
  console.log('这个 server.js 里没有出问题的那行，无需修补。');
  process.exit(0);
}

// 统计用的调用，缺了不影响功能；用 typeof 判断，避免直接引用未声明变量报 ReferenceError
const before = (s.match(/cotState\.addThinking\(/g) || []).length;
s = s.replace(/(\s*)cotState\.addThinking\(([^)]*)\);/g,
  '$1_cotSafe($2);   // 线上可能没有 cotState，见 hotfix-cotstate');

// 插入这个小助手（放在 feedText 之前）
if (!s.includes('function _cotSafe')) {
  s = s.replace(/(\n\s*)function feedText\(chunk\) \{/,
    `$1// COT Guard 是可选的：这份 server.js 里不一定有 cotState，
$1// 直接引用未声明的变量会抛 ReferenceError 并让整个进程崩掉。
$1function _cotSafe(t) {
$1  try { if (typeof cotState !== 'undefined' && cotState && t) cotState.addThinking(t); } catch (_) {}
$1}
$1function feedText(chunk) {`);
}

console.log(`\n  修正了 ${before} 处 cotState 调用`);
if (!s.includes('function _cotSafe')) {
  console.error('  × 没能插入保护函数，原文件未改动');
  process.exit(1);
}
console.log('  √ 已插入存在性保护');

try {
  new (require('vm').Script)(s, { filename: 'patched' });
} catch (e) {
  console.error('\n补丁后语法有问题，原文件未改动：', e.message);
  process.exit(1);
}
const bak = path + '.bak-cot-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n修好了。备份：${bak}`);
console.log('接着重启：pm2 restart chatnest-api（或 pm2 restart all）');
