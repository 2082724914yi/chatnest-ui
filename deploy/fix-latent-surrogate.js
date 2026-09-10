#!/usr/bin/env node
// 半个 emoji 会让整批 embedding 被拒 —— 切干净再发。
//   node fix-latent-surrogate.js [/root/chatnest-api/server.js]
//
// 二分重试上去之后，报错终于指到了具体那一块，开头是这个：
//   卡在这一块（200 字）：\udd7a assistant: 过来了 user: 你站着 ...
//
// \udd7a 是 U+1F57A 那个 emoji 的下半截（代理对的低位）。JS 的 slice 按
// UTF-16 的格子切，emoji 在里面占两格 —— 硬切正好落在中间，就把它劈成了两半，
// 块开头留下一个落单的低代理项。落单的代理项不是合法 UTF-8，JSON 发出去
// 那边直接回 20015 参数无效，而且是整批一起挂。
//
// 所以之前两轮都没治到根上：
//   · 不是单块太长（切块补丁已经把最长块从 12996 字降到 819 字了）
//   · 也不是这一批总量超限（二分劈到单条还是挂）
//   · 就是这一条里有半个字符
//
// 三处一起改：
//   1. 加 lvSafeText：完整的 emoji 留着，落单的半个删掉；要截也不截在代理对中间
//   2. 切块出来先过一遍 —— 存进库里的块文本也是干净的
//   3. embed 之前再过一遍（双保险，二分那条路上的 200 字截短也走这儿）
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('lvSafeText')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('LATENT_VEC_VERSION')) { console.error('先打 add-latent-vec.js'); process.exit(1); }

const SAFE = `
// 落单的代理项（半个 emoji）要清掉，不然整批 embedding 被拒。
// 她卡在第 523 块那次，报错开头就是 \\udd7a —— U+1F57A 被硬切从中间劈开了。
// 半个字符不是合法 UTF-8，那边回 20015，同批的十几块跟着陪葬。
function lvSafeText(s, max) {
  let t = String(s == null ? '' : s);
  const n = max || (LV_CHUNK + LV_OVER);
  if (t.length > n) {
    // 截也别截在代理对中间：末尾正好落在高位上就退一格
    const c = t.charCodeAt(n - 1);
    t = t.slice(0, (c >= 0xD800 && c <= 0xDBFF) ? n - 1 : n);
  }
  // 完整的代理对留着（emoji 本身没毛病），落单的删掉
  return t.replace(/[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\uD800-\\uDFFF]/g, m => m.length === 2 ? m : '');
}
`;

const edits = [
  { name: '加 lvSafeText', required: true,
    find: /(\nfunction lvChunks\(text\) \{)/,
    replace: (m, g1) => SAFE + g1 },

  { name: '切出来的块先清一遍', required: true,
    find: /return out\.filter\(c => c\.replace\(\/\\s\/g, ''\)\.length >= 30\);[^\n]*/,
    replace: () => "return out.map(c => lvSafeText(c, LV_CHUNK * 2)).filter(c => c.replace(/\\s/g, '').length >= 30);   // 太碎的不要；顺手清掉硬切留下的半个 emoji" },

  { name: 'embed 之前再清一遍', required: true,
    find: /texts\.map\(t => String\(t \|\| ''\)\.slice\(0, LV_CHUNK \+ LV_OVER\)\)/,
    replace: () => 'texts.map(t => lvSafeText(t))' },
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
console.log('\n  重启后重新建索引。已经跑完的那几篇不会重跑。');
console.log('  这次治的是根上那条：半个 emoji。');
console.log('\n  备份: ' + backup);
