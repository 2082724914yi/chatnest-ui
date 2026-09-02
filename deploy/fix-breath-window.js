#!/usr/bin/env node
/* 第十五个补丁：新窗浮现的记忆经常是空的、或者被砍掉一半。

   新开一个对话时后端会调 breath()，把 OB 按权重浮现出来的记忆塞进上下文
   （权重就是网页上那个权重，不是前端自己排的）。逻辑本身是对的，
   但有两个数卡得太死：

     · 只等 10 秒。OB 那边光 MCP 握手就要 6 秒上下，breath 再拉一遍桶，
       经常刚过 10 秒就被判超时 —— 于是"暂无相关记忆"，等于新窗什么都没想起来。
     · 只取前 3000 字。固化的核心准则本身就占了两三千字，
       后面按权重浮现的那些常常整段被截掉。

   放宽到 25 秒 / 6000 字。read 类调用本来就不烧钱，等一会儿值得。

   用法：curl -fsSL .../deploy/fix-breath-window.js | sudo node -
   安全：先备份，全部命中才写入，写入前语法校验，可重复执行。 */
const fs = require('fs');
const path = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(path)) { console.error('找不到文件:', path); process.exit(1); }
let s = fs.readFileSync(path, 'utf8');
const orig = s;
const log = [];
let failed = 0;

function edit(label, re, make) {
  const m = s.match(re);
  if (!m) { log.push(['×', label, '没匹配到']); failed++; return; }
  const all = s.match(new RegExp(re.source, re.flags.replace('g', '') + 'g'));
  if (all && all.length > 1) { log.push(['×', label, `匹配到 ${all.length} 处，不敢动`]); failed++; return; }
  s = s.replace(re, make(m));
  log.push(['√', label, '']);
}

if (!s.includes('isFirstTurn')) {
  console.error('这个 server.js 里没有 isFirstTurn，先跑 fix-recall.js。');
  process.exit(1);
}
if (s.includes('BREATH_TIMEOUT_MS')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

edit('浮现记忆放宽超时和长度',
  /      const raw = await Promise\.race\(\[job, new Promise\(r => setTimeout\(\(\) => r\(null\), 10000\)\)\]\);\n      if \(raw\) memories = raw\.length > 3000 \? raw\.slice\(0, 3000\) \+ '\.\.\.' : raw;/,
  () => `      // 10 秒太紧：光 MCP 握手就要 6 秒左右，breath 还要按权重拉一遍桶，
      // 经常刚过线就被判超时，新窗于是"什么都没想起来"。
      const BREATH_TIMEOUT_MS = 25000;
      // 3000 字也太少：固化的核心准则本身就占两三千字，
      // 后面按权重浮现的那几条常常整段被截没。
      const BREATH_MAX_CHARS = 6000;
      const raw = await Promise.race([job, new Promise(r => setTimeout(() => r(null), BREATH_TIMEOUT_MS))]);
      if (raw) memories = raw.length > BREATH_MAX_CHARS ? raw.slice(0, BREATH_MAX_CHARS) + '...' : raw;`);

// ---- 报告 ----
console.log('\n补丁结果：');
for (const [mark, label, note] of log) console.log(`  ${mark} ${label}${note ? '  — ' + note : ''}`);

if (failed) {
  console.error(`\n有 ${failed} 处没打上，原文件未改动。把上面的输出发回来。`);
  process.exit(1);
}
try {
  new (require('vm').Script)(s, { filename: 'patched' });
} catch (e) {
  console.error('\n补丁后语法有问题，原文件未改动：', e.message);
  process.exit(1);
}
const bak = path + '.bak-breath-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端。新开对话时按权重浮现的那几条记忆不会再因为超时或截断丢掉。');
