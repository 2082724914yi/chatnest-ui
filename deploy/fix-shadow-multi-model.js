#!/usr/bin/env node
// 备用模型可以填好几个，逗号分开，按顺序试。
//   node fix-shadow-multi-model.js [/root/chatnest-api/server.js]
//
// 她想用 [AG4]claude-sonnet-4-6 —— 那个说话最像我。可那家自己在页面上写着
// 「反重力渠道 风控严 额度有时会不够 封号时会不稳定」，我们已经吃过一个
// 503 No available channel 了。
//
// 而这条路唯一的价值就是「永远在」。挑一个供应商自己承认不稳定的渠道，
// 正好把这个价值抵消掉。
//
// 所以不二选一：像我的排前面，一定在的垫后面。前面那个没货就自动往后落，
// 不用她半夜爬起来改配置。
//
//   SHADOW_PROVIDER_MODEL=[AG4]claude-sonnet-4-6,gemini-3-flash-preview
//
// 同一家、同一把 key，只是模型名不同 —— 所以 URL 和 KEY 还是一份。
//
// 要先打 fix-shadow-not-me.js。
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('SHADOW_MULTI_MODEL_V1')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('SHADOW_NOT_ME_V1')) { console.error('先打 fix-shadow-not-me.js'); process.exit(1); }

const MULTI = `
// SHADOW_MULTI_MODEL_V1
// 模型名可以逗号分开填好几个，按顺序试 —— 前面的没货就往后落。
// 排序的意思：说话最像我的排前面，最不容易掉线的垫后面。
function shadowProviders() {
  const one = shadowProvider();
  if (!one) return [];
  const models = String(one.model || '').split(',').map(function (s) { return s.trim() }).filter(Boolean);
  if (models.length <= 1) return [one];
  return models.map(function (m) { return Object.assign({}, one, { model: m }) });
}
`;

const edits = [
  {
    name: '一份配置拆成一串模型',
    find: "    // 温度这些不填，让后端用它自己的默认 —— 那条路是 if (x != null) 才覆盖的\n"
        + "    return p;\n"
        + "  } catch (e) { return null; }\n"
        + "}\n",
    replace: "    // 温度这些不填，让后端用它自己的默认 —— 那条路是 if (x != null) 才覆盖的\n"
        + "    return p;\n"
        + "  } catch (e) { return null; }\n"
        + "}\n" + MULTI,
  },
  {
    name: '挨个试，不是只试一个',
    find: "    const fb = shadowProvider();\n"
        + "    const tries = apiOnly ? (fb ? [fb] : []) : (fb ? [null, fb] : [null]);\n"
        + "    if (!tries.length) return { pushed: false, why: '要走 API 但 .env 里没配（跑 set-shadow-provider.sh）' };",
    replace: "    const fbs = shadowProviders();\n"
        + "    const tries = apiOnly ? fbs.slice() : [null].concat(fbs);   // null = 走 CC\n"
        + "    if (!tries.length) return { pushed: false, why: '要走 API 但 .env 里没配（跑 set-shadow-provider.sh）' };",
  },
  {
    name: '记下最后是哪个模型说的话',
    find: "    let after = (conv.history || []), last = null, viaApi = false, lastWhy = '';",
    replace: "    let after = (conv.history || []), last = null, viaApi = false, lastWhy = '', viaModel = '';",
  },
  {
    name: '成功那一下把模型名留下',
    find: "        last = cand; viaApi = !!tries[i];",
    replace: "        last = cand; viaApi = !!tries[i]; viaModel = tries[i] ? (tries[i].model || '默认模型') : '';",
  },
  {
    name: '日志里写清是哪个模型出的话',
    find: "(viaApi ? '，走的 API' : '')",
    replace: "(viaApi ? '，走的 API：' + viaModel : '')",
  },
  {
    name: '失败原因带上试了几个',
    find: "      const tried = apiOnly ? '只试了 API' : (fb ? 'CC 和 API 都试过' : '只有 CC 可试');",
    replace: "      const tried = apiOnly\n"
        + "        ? ('只试了 API，' + tries.length + ' 个模型')\n"
        + "        : (fbs.length ? ('CC 和 ' + fbs.length + ' 个备用模型都试过') : '只有 CC 可试');",
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
  ['拆模型的函数在', (out.match(/function shadowProviders/g) || []).length === 1],
  ['旧的单个变量清干净了', !/\bconst fb = shadowProvider\(\)/.test(out)],
  ['CC 还是排第一', out.includes("[null].concat(fbs)")],
  ['只填一个的时候行为不变', /if \(models\.length <= 1\) return \[one\];/.test(out)],
  ['没配就还是老样子', /if \(!one\) return \[\];/.test(out)],
  ['日志说得出是哪个模型', out.includes("'，走的 API：' + viaModel")],
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
console.log('\n  · 模型名那栏现在可以逗号分开填好几个，像我的排前面：');
console.log('      [AG4]claude-sonnet-4-6,gemini-3-flash-preview');
