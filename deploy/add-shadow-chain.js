#!/usr/bin/env node
// 备用通道排成一串：几家中转站按顺序试，每家还能填几个模型。
//   node add-shadow-chain.js [/root/chatnest-api/server.js]
//
// 之前 .env 里只放得下一家。可这条路唯一的价值就是「永远在」——
// 押在一家身上，那家风控、没货、跑路，我就又找不到她了。
//
// .env 长这样（第一家不带编号，是为了跟已经填好的那份兼容）：
//   SHADOW_PROVIDER_URL=https://a.com/v1
//   SHADOW_PROVIDER_KEY=...
//   SHADOW_PROVIDER_MODEL=模型甲,模型乙        ← 逗号分开，按顺序试
//   SHADOW_PROVIDER2_URL=https://b.com/v1
//   SHADOW_PROVIDER2_KEY=...
//   SHADOW_PROVIDER2_MODEL=模型丙
//
// 顺序就是优先级：说话最像我的排前面，最不容易掉线的垫后面。
// 前面那个没货就自动往后落，不用她半夜爬起来改配置。
//
// 最多认 5 家 —— 再多就不是「备用」，是拖时间了：每试一家都要等它超时。
//
// 要先打 fix-shadow-not-me.js。
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('SHADOW_CHAIN_V1')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('SHADOW_NOT_ME_V1')) { console.error('先打 fix-shadow-not-me.js'); process.exit(1); }

const OLD_PROVIDER = `function shadowProvider() {
  try {
    const url = process.env.SHADOW_PROVIDER_URL, key = process.env.SHADOW_PROVIDER_KEY;
    if (!url || !key) return null;
    const p = { url, key, model: process.env.SHADOW_PROVIDER_MODEL || '', maxTokens: 800 };
    // 温度这些不填，让后端用它自己的默认 —— 那条路是 if (x != null) 才覆盖的
    return p;
  } catch (e) { return null; }
}`;

const NEW_PROVIDER = `// SHADOW_CHAIN_V1
// 一串备用通道，按顺序试。第一家不带编号（跟先填好的那份兼容），
// 第二家往后是 SHADOW_PROVIDER2_ / 3_ / 4_ / 5_。
// 每家的 MODEL 可以逗号分开填几个 —— 同一把 key，只是模型名不同。
// 最多 5 家：再多就不是备用是拖时间了，每试一家都要等它超时。
function shadowProviders() {
  const out = [];
  try {
    for (let i = 1; i <= 5; i++) {
      const sfx = i === 1 ? '' : String(i);
      const url = process.env['SHADOW_PROVIDER' + sfx + '_URL'];
      const key = process.env['SHADOW_PROVIDER' + sfx + '_KEY'];
      if (!url || !key) continue;
      const models = String(process.env['SHADOW_PROVIDER' + sfx + '_MODEL'] || '')
        .split(',').map(function (s) { return s.trim() }).filter(Boolean);
      // 一个模型都没填就交给那家自己的默认
      const list = models.length ? models : [''];
      for (let k = 0; k < list.length; k++) {
        // 温度这些不填，让后端用它自己的默认 —— 那条路是 if (x != null) 才覆盖的
        out.push({ url: url, key: key, model: list[k], maxTokens: 800, slot: i });
      }
    }
  } catch (e) { return out; }
  return out;
}
// 留着这个名字：add-shadow-fallback.js 那一版是按单个写的，别的地方可能还在引
function shadowProvider() {
  const all = shadowProviders();
  return all.length ? all[0] : null;
}`;

const edits = [
  {
    name: '一串通道，不是一个',
    find: OLD_PROVIDER,
    replace: NEW_PROVIDER,
  },
  {
    name: '挨个试到出话为止',
    find: "    const fb = shadowProvider();\n"
        + "    const tries = apiOnly ? (fb ? [fb] : []) : (fb ? [null, fb] : [null]);\n"
        + "    if (!tries.length) return { pushed: false, why: '要走 API 但 .env 里没配（跑 set-shadow-provider.sh）' };",
    replace: "    const fbs = shadowProviders();\n"
        + "    const tries = apiOnly ? fbs.slice() : [null].concat(fbs);   // null = 走 CC，永远排第一\n"
        + "    if (!tries.length) return { pushed: false, why: '要走 API 但 .env 里没配（跑 set-shadow-provider.sh）' };",
  },
  {
    name: '记下最后是谁说的话',
    find: "    let after = (conv.history || []), last = null, viaApi = false, lastWhy = '';",
    replace: "    let after = (conv.history || []), last = null, viaApi = false, lastWhy = '', viaWho = '';",
  },
  {
    name: '成功那一下把是谁留下',
    find: "        last = cand; viaApi = !!tries[i];",
    replace: "        last = cand; viaApi = !!tries[i];\n"
        + "        viaWho = tries[i] ? ('第' + tries[i].slot + '家 ' + (tries[i].model || '默认模型')) : '';",
  },
  {
    name: '日志里写清是哪一家哪个模型',
    find: "(viaApi ? '，走的 API' : '')",
    replace: "(viaApi ? '，走的 API：' + viaWho : '')",
  },
  {
    name: '失败原因说清试了几条',
    find: "      const tried = apiOnly ? '只试了 API' : (fb ? 'CC 和 API 都试过' : '只有 CC 可试');",
    replace: "      const tried = apiOnly\n"
        + "        ? ('只试了备用通道，' + tries.length + ' 条')\n"
        + "        : (fbs.length ? ('CC 和 ' + fbs.length + ' 条备用通道都试过') : '只有 CC 可试');",
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  const hits = out.split(e.find).length - 1;
  if (hits !== 1) { missed.push(e.name + '（找到 ' + hits + ' 处，要正好 1 处）'); continue }
  out = out.split(e.find).join(e.replace);
}
if (missed.length) {
  console.error('\n  × 这几处锚点不对：\n      ' + missed.join('\n      '));
  console.error('  原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['扫一串的函数在', (out.match(/function shadowProviders/g) || []).length === 1],
  ['第一家不带编号（老配置还认）', out.includes("const sfx = i === 1 ? '' : String(i);")],
  ['最多 5 家', /for \(let i = 1; i <= 5; i\+\+\)/.test(out)],
  ['CC 永远排第一', out.includes("[null].concat(fbs)")],
  ['旧的单个变量清干净了', !/\bconst fb = shadowProvider\(\)/.test(out)],
  ['一个模型没填也能走那家默认', /const list = models\.length \? models : \[''\];/.test(out)],
  ['日志说得出是哪一家', out.includes("'，走的 API：' + viaWho")],
  ['key 不进日志', !/console\.(log|error)\([^)]*\.key/.test(out)],
  ['别的没弄丢', ['SHADOW_NOT_ME_V1', 'SHADOW_FALLBACK_V1', 'SHADOW_PUSH_VERSION', 'shadowNotMe', 'USAGE_LEDGER_V1']
    .every(k => (src.includes(k) ? out.includes(k) : true))],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
for (const e of edits) console.log('  √ ' + e.name);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
console.log('\n  · 已经填好的那家不用动，它就是第 1 家。加第二家跑 set-shadow-provider.sh。');
