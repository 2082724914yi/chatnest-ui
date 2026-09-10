#!/usr/bin/env node
// 超长段落切开 + 断点续跑。
//   node fix-latent-chunk.js [/root/chatnest-api/server.js]
//
// 她建索引跑到第 504 块炸了：
//   embedding 返回不对: {"code":20015,"message":"The parameter is invalid."}
//
// 原因是切块只顾着"攒到 700 字就落一块"，遇到单段本身就超长的，
// 会把整段原样塞进去。实测她的语料里最长一段有 12875 字（window_150），
// 超过 700 字的段落有 102 段、超过 3000 字的 7 段 —— 那一整块进 embedding
// 就顶爆了 bge-m3 的输入上限，硅基流动回 20015。
//
// 而且炸得很难受：跑到一半才炸，前面 504 块白跑 —— 因为文件记账是
// 「全部跑完才写 db.files」，中途失败一条都没记上，下次重跑从头开始。
//
// 三处一起改：
//   1. 切块：单段超长的先硬切，块与块之间照旧留重叠
//   2. embed 之前再截一次（双保险，万一还有漏网的）
//   3. 每批之后就把「所有块都跑完了的文件」记账 —— 断了重跑只补没跑完的
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('LV_CHUNK_FIXED')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('LATENT_VEC_VERSION')) { console.error('先打 add-latent-vec.js'); process.exit(1); }

const NEW_CHUNKS = `// LV_CHUNK_FIXED
// 切块。按空行分段，攒到 LV_CHUNK 字就落一块，块间留 LV_OVER 字重叠。
// ⚠ 单段本身就超长的要先硬切开 —— 她语料里最长一段 12875 字，
//    不切的话整段进 embedding，顶爆模型输入上限，硅基流动回 20015，
//    而且是跑到一半才炸（第 504 块那次）。
function lvChunks(text) {
  const paras = String(text || '').split(/\\n\\s*\\n/).map(s => s.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  const flush = () => { if (cur.trim()) out.push(cur); cur = ''; };
  for (const p0 of paras) {
    let p = p0;
    while (p.length > LV_CHUNK) {
      flush();
      out.push(p.slice(0, LV_CHUNK));
      p = p.slice(LV_CHUNK - LV_OVER);   // 硬切也留一截重叠，切口上的句子不至于两边都搜不到
    }
    if (cur && (cur.length + p.length) > LV_CHUNK) {
      out.push(cur);
      cur = cur.slice(-LV_OVER) + '\\n' + p;
    } else {
      cur = cur ? (cur + '\\n' + p) : p;
    }
  }
  flush();
  return out.filter(c => c.replace(/\\s/g, '').length >= 30);   // 太碎的不要
}`;

const edits = [
  { name: '切块：单段超长先硬切', required: true,
    find: /\/\/ 切块。按空行分段[\s\S]*?\n\}/,
    replace: () => NEW_CHUNKS },

  { name: 'embed 之前再截一次（双保险）', required: true,
    find: /(\s*)body: JSON\.stringify\(\{ model: LV_MODEL, input: texts, encoding_format: 'float' \}\),/,
    replace: (m, s1) =>
      s1 + '// 双保险：万一还有漏网的超长块，这儿再截一刀。宁可少几个字，' +
      s1 + '// 也不要整批炸掉 —— 一炸就是几百块白跑。' +
      s1 + "body: JSON.stringify({ model: LV_MODEL, input: texts.map(t => String(t || '').slice(0, LV_CHUNK + LV_OVER)), encoding_format: 'float' })," },

  { name: '每批就记账（断点续跑）', required: true,
    find: /(\s*)db\.chunks = all;\n(\s*)db\.vecs = lvPack\(allV\);\n(\s*)lvSave\(db\);/,
    replace: (m, s1, s2, s3) =>
      s1 + 'db.chunks = all;\n' +
      s2 + 'db.vecs = lvPack(allV);\n' +
      s2 + '// 哪些文件的块已经全跑完了，当场记账 —— 中途炸了重跑只补没跑完的，\n' +
      s2 + '// 不用像第一次那样 504 块白跑\n' +
      s2 + 'const _doneF = {};\n' +
      s2 + 'for (let k = 0; k < freshVecs.length; k++) _doneF[fresh[k].file] = 1;\n' +
      s2 + 'for (let k = freshVecs.length; k < fresh.length; k++) delete _doneF[fresh[k].file];\n' +
      s2 + 'for (const _n of Object.keys(_doneF)) {\n' +
      s2 + '  try { const _st = fs.statSync(LV_DIR + \'/\' + _n); db.files[_n] = { mtime: _st.mtimeMs, size: _st.size }; } catch (e) {}\n' +
      s2 + '}\n' +
      s3 + 'lvSave(db);' },
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
console.log('\n  重启后重新建索引就行。这次断了也不会白跑 ——');
console.log('  跑完的文件当场记账，重跑只补剩下的。');
console.log('\n  备份: ' + backup);
