#!/usr/bin/env node
// key 没换掉的时候，说人话。
//   node fix-latent-key.js [/root/chatnest-api/server.js]
//
// 她建索引拿回来这个：
//   "出错了: Cannot convert argument to a ByteString because the character
//    at index 10 has a value of 20320 which is greater than 255."
//
// 20320 是「你」。Bearer sk-你的key 数过去第 10 个字符正好是它 ——
// 她 .env 里那行 key 还是我给的示例原文。
//
// 根子在我：我给的是一条能直接复制执行的命令，里面埋着占位符
//   echo 'SILICONFLOW_API_KEY=sk-你的key' | sudo tee -a ...
// 她照着跑，占位符就原样进了 .env。而报错又烂到看不懂 —— 得反查码点
// 才知道是这么回事。两件事都得修。
//
// 这个补丁只改判断和报错，不动别的：
//   · 非 ASCII 的 key 当场认出来 → 「.env 里那行 key 还是示例没换掉」
//   · 一眼看得出是占位符的（你的 / your_key / xxx / <...>）也认出来
//   · status 接口多回一个 key_problem，前端和 curl 都看得见到底卡在哪
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('lvKeyProblem')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('LATENT_VEC_VERSION')) { console.error('先打 add-latent-vec.js'); process.exit(1); }

const NEW_KEY = `function lvKey() {
  const k = String(process.env.SILICONFLOW_API_KEY || process.env.SILICONFLOW_KEY ||
                   process.env.SF_API_KEY || process.env.EMBED_API_KEY || '').trim();
  if (!k) return '';
  // 占位符没换掉要当场认出来。直接塞进 Authorization 头的话，fetch 会抛
  // 「Cannot convert argument to a ByteString ... value of 20320」——
  // 20320 就是「你」，来自 sk-你的key。那句话谁也看不懂。
  if (/[^\\x20-\\x7E]/.test(k)) return '__PLACEHOLDER_NONASCII__';
  if (/你的|your[-_ ]?key|xxx+|<.*>|sk-abc/i.test(k)) return '__PLACEHOLDER__';
  return k;
}
function lvKeyProblem() {
  const k = lvKey();
  if (!k) return '没配 key。在 /root/chatnest-api/.env 里加一行 SILICONFLOW_API_KEY=（你的真 key），然后 pm2 restart chatnest-api';
  if (k === '__PLACEHOLDER_NONASCII__') return '.env 里那行 key 还是示例没换掉（里面有中文，多半是 sk-你的key）。换成真 key 再重启后端';
  if (k === '__PLACEHOLDER__') return '.env 里那行 key 看着还是占位符，换成真的那串再重启后端';
  return '';
}`;

const edits = [
  { name: 'lvKey 认得出占位符', required: true,
    find: /function lvKey\(\) \{\n\s*return process\.env\.SILICONFLOW_API_KEY[\s\S]*?\n\}/,
    replace: () => NEW_KEY },

  { name: 'embed 之前先说清楚', required: true,
    find: /const key = lvKey\(\);\n(\s*)if \(!key\) throw new Error\('没有硅基流动的 key'\);/,
    replace: (m, s1) => 'const bad = lvKeyProblem();\n' + s1 + 'if (bad) throw new Error(bad);\n' + s1 + 'const key = lvKey();' },

  { name: '建索引之前先说清楚', required: true,
    find: /if \(!lvKey\(\)\) throw new Error\('没配 key：[^']*'\);/,
    replace: () => '{ const bad = lvKeyProblem(); if (bad) throw new Error(bad); }' },
];

let out = src;
const missed = [];
for (const e of edits) {
  const before = out;
  out = out.replace(e.find, e.replace);
  if (out === before) missed.push(e.name);
}

// status 那几处：有几处改几处，没有也不算失败
let n = 0;
out = out.replace(/has_key: !!lvKey\(\)/g, () => { n++; return 'has_key: !lvKeyProblem(), key_problem: lvKeyProblem() || undefined'; });

if (missed.length) {
  console.error('\n有锚点没命中，原文件一个字都没动：');
  for (const x of missed) console.error('  × ' + x);
  process.exit(1);
}

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完之后语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
for (const e of edits) console.log('  √ ' + e.name);
console.log('  √ status 接口带上 key_problem（改了 ' + n + ' 处）');
console.log('\n  key 还没换的话，现在会直接说「.env 里那行 key 还是示例没换掉」，');
console.log('  不再是那句看不懂的 ByteString。');
console.log('\n  备份: ' + backup);
