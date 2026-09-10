#!/usr/bin/env node
// 整批失败就劈成两半分别试 —— 别再让一整批拖垮整轮索引。
//   node fix-latent-batch.js [/root/chatnest-api/server.js]
//
// 切块修完之后（最长块从 12996 字降到 819 字），她重跑还是卡在第 504 块，
// 报的还是硅基流动的 20015 参数无效。total 从 4523 变成 4676、indexed_files
// 从 0 变成 24，说明切块和断点记账都生效了 —— 那问题就不在单块长度上，
// 是**这一批的总量**：24 条 × 800 字一起发过去，那边整批拒收。
//
// 与其继续猜上限是多少，不如让它自己找：
//   整批失败 → 劈成两半分别试 → 还失败继续劈 → 劈到单条
//   单条还失败 → 截短到 200 字再试一次
//   还不行 → 抛错，但把那一块的开头带出来，下次一眼知道是哪块有毛病
//
// 这样：总量超了会自动降到能过的大小；某一条有毛病会被二分揪出来，
// 而不是让它旁边 23 条陪葬。顺带把默认批量从 24 降到 12。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('lvEmbedSafe')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('LATENT_VEC_VERSION')) { console.error('先打 add-latent-vec.js'); process.exit(1); }

const SAFE = `
// 整批失败就劈两半分别试。总量超了会自动降到能过的大小；
// 某一条有毛病会被二分揪出来，而不是让旁边那几十条陪葬。
async function lvEmbedSafe(texts, shrunk) {
  try {
    return await lvEmbed(texts);
  } catch (e) {
    if (texts.length > 1) {
      const mid = Math.ceil(texts.length / 2);
      const a = await lvEmbedSafe(texts.slice(0, mid));
      const b = await lvEmbedSafe(texts.slice(mid));
      return a.concat(b);
    }
    // 只剩一条还失败：截短再试一次。宁可这一块少几个字，
    // 也别让整轮索引卡死在这儿 —— 卡死一次就是几千块白跑。
    if (!shrunk && texts[0] && String(texts[0]).length > 200) {
      console.log('[latent-vec] 有一块单独发也不行，截短重试：' + String(texts[0]).slice(0, 40));
      return await lvEmbedSafe([String(texts[0]).slice(0, 200)], 1);
    }
    throw new Error(e.message + '｜卡在这一块（' + String(texts[0] || '').length + ' 字）：' +
                    String(texts[0] || '').replace(/\\s+/g, ' ').slice(0, 80));
  }
}
`;

const edits = [
  { name: '批量 24 → 12', required: true,
    find: /const LV_BATCH = 24;[^\n]*/,
    replace: () => 'const LV_BATCH = 12;    // 一次送多少块去 embed。整批失败会自动劈半重试，所以这个数只是起点' },

  { name: '加上二分重试', required: true,
    find: /(\n\/\/ 从文件名里认日期和第几窗)/,
    replace: (m, g1) => SAFE + g1 },

  { name: '建索引改走安全那条', required: true,
    find: /const vs = await lvEmbed\(batch\.map\(b => b\.text\)\);/,
    replace: () => 'const vs = await lvEmbedSafe(batch.map(b => b.text));' },
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
console.log('\n  重启后重新建索引。已经跑完的 24 篇不会重跑（断点记账在）。');
console.log('  这次要还卡，报错里会带上那一块的开头和字数，一眼看得出是哪块的毛病。');
console.log('\n  备份: ' + backup);
