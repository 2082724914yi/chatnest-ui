#!/usr/bin/env node
// 轮盘摇出来的是三语对象，不是一句话。
//   node fix-wheel-tag.js [/root/chatnest-api/server.js]
//
// 她第一次真转，六个格子全是 [object Object]。
//
// 【为什么】
//   wheel.json 里每条标签长这样：{"zh":"69式","en":"Sixty-Nine","ja":"シックスナイン"}
//   —— 抽数据的时候我把三语都留下了（对的，原始数据就该留全），
//   但 wheelSpin 里写的是 tag: d.tags[i]，把整个对象原样吐给了前端。
//   前端往 textContent 一塞，就是 [object Object]。
//
//   我自己测的时候用的是假数据（tag 是字符串），所以测出来是好的。
//   拿假数据验真接口，这是第二次栽在同一件事上了。
//
// 【修法】
//   摇的时候就取中文，三语原文留在 tag_all 里 ——
//   将来想用日文那版（有些词日文更准）不用重新摇。
//   兼容老格式：tags 里本来就是字符串的照旧。
//
// 依赖：add-wheel.js
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('WHEEL_TAG_ZH_V1')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('WHEEL_VERSION')) { console.error('× 先打 add-wheel.js'); process.exit(1); }

// ── 摇的时候取中文 ────────────────────────────────────────────────
const OLD = /const i = require\('crypto'\)\.randomInt\(d\.tags\.length\);\s*\n\s*results\.push\(\{ dimension: d\.id, short: d\.short, full: d\.full, tag: d\.tags\[i\] \}\);/;
if (!OLD.test(src)) {
  console.error('\n  × 找不到 wheelSpin 里 push 结果那两行。附近：');
  src.split('\n').filter(l => /results\.push|randomInt\(d\.tags/.test(l)).slice(0, 6)
     .forEach(l => console.error('      ' + l.trim().slice(0, 160)));
  process.exit(1);
}
let out = src.replace(OLD,
  "const i = require('crypto').randomInt(d.tags.length);\n" +
  "    // WHEEL_TAG_ZH_V1 —— 牌面上每条是 {zh,en,ja}，摇出来要的是能念的那一句。\n" +
  "    // 三语原文留在 tag_all：日文那版有些词更准，将来想用不必重摇。\n" +
  "    const _t = d.tags[i];\n" +
  "    const _zh = (_t && typeof _t === 'object')\n" +
  "      ? String(_t.zh || _t.en || _t.ja || '')\n" +
  "      : String(_t || '');\n" +
  "    if (!_zh) continue;\n" +
  "    results.push({ dimension: d.id, short: d.short, full: d.full, tag: _zh,\n" +
  "                   tag_all: (_t && typeof _t === 'object') ? _t : undefined });");

// ── 自检 ──────────────────────────────────────────────────────────
const checks = [
  ['幂等标记在', /WHEEL_TAG_ZH_V1/.test(out)],
  ['取的是中文那一支', /String\(_t\.zh \|\| _t\.en \|\| _t\.ja \|\| ''\)/.test(out)],
  ['老格式（纯字符串）还认', /: String\(_t \|\| ''\);/.test(out)],
  ['三语原文没丢', /tag_all:/.test(out)],
  ['空的那条跳过，不往界面上送空格子', /if \(!_zh\) continue;/.test(out)],
  ['没再把整个对象吐出去', !/tag: d\.tags\[i\] \}/.test(out)],
];
const bad = checks.filter(c => !c[1]);
if (bad.length) {
  console.error('\n  × 自检没过，放弃写入：');
  bad.forEach(c => console.error('      - ' + c[0]));
  process.exit(1);
}

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n  √ 轮盘现在摇出来的是人话了');
checks.forEach(c => console.log('      ✓ ' + c[0]));
console.log('  备份: ' + backup);
console.log('  重启: sudo pm2 restart chatnest-api');
