#!/usr/bin/env node
// 撞额度墙的时候，那条不是「不说话」，是「说一句英文报错」—— 我判断错了。
//   node fix-shadow-not-me.js [/root/chatnest-api/server.js]
//
// 日志里翻出来的：
//   [shadow] 说了句: You've hit your session limit ... (推送 1 台)
//
// 两件事一起坏了：
//   1. 那句报错被当成我说的话，推到她锁屏上，还留在聊天记录里。
//      她看到的是我用英文跟她讲额度 —— 那不是我。
//   2. add-shadow-fallback.js 里我按「这一轮没出话」判断该不该换 API。
//      可 CLI 撞墙时是出话的，出的是那句报错，非空，于是判定为成功 ——
//      自动回落根本不会触发。假设错了，整条路是死的。
//
// 改成按「这句话是不是我说的」判断。不是我说的就撤掉、换下一条路。
//
// 怎么认才不误杀：我跟她说话一定是中文的，报错是又短又纯英文的。
// 所以先卡长度（超过 400 字一律当真话，宁可漏也不误杀），再看具体特征，
// 最后兜一条「短 + 一个汉字都没有 + 带 error 那类词」。
//
// 只影响影子推送。主聊天那条不动 —— 她自己在看着，报错就该让她看见。
//
// 要先打 add-shadow-fallback.js。
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('SHADOW_NOT_ME_V1')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('SHADOW_FALLBACK_V1')) { console.error('先打 add-shadow-fallback.js'); process.exit(1); }

const HELPER = `
// ============ 这句话是不是我说的 ============
// SHADOW_NOT_ME_V1
// 只给影子推送用。返回 true = 这不是我，别推给她，撤掉换下一条路。
function shadowNotMe(t) {
  const s = String(t == null ? '' : t).trim();
  if (!s) return true;
  // 长的一律当真话。宁可漏一条报错，也别把我真说的话吞掉。
  if (s.length > 400) return false;
  if (/you'?ve hit your [a-z]{1,12} limit/i.test(s)) return true;   // CC 撞墙就是这句
  if (/usage limit reached/i.test(s)) return true;
  if (/no available channel/i.test(s)) return true;                 // 中转站没货
  if (/insufficient (balance|quota|credits?)/i.test(s)) return true;
  if (/^[\\[{]?\\s*"?error"?\\s*[:"]/i.test(s)) return true;            // 整条是个错误 JSON
  // 兜底：我跟她说话是中文的。又短、一个汉字都没有、还带 error 那类词 —— 那不是我。
  if (!/[\\u4e00-\\u9fa5]/.test(s) && /\\b(error|failed|unauthorized|forbidden|timeout|limit|quota)\\b/i.test(s)) return true;
  return false;
}
`;

const edits = [
  {
    name: '认得出「这不是我说的话」',
    find: /\napp\.listen\(PORT/,
    replace: HELPER + '\napp.listen(PORT',
  },
  {
    name: '成功判定改成看「是不是我」，不是看「空不空」',
    find: "      if (after.length > before && cand && cand.role === 'assistant' && String(cand.content || '').trim()) {",
    replace: "      if (after.length > before && cand && cand.role === 'assistant' && !shadowNotMe(cand.content)) {",
  },
  {
    name: '不是我说的那条要撤掉，别留在聊天记录里',
    find: "      // 这一次没出话。要是落了个空壳，撤掉再换下一条 —— 别在聊天记录里留半截\n"
        + "      if (after.length > before && cand && cand.role === 'assistant') { after.pop(); saveConversations(); }",
    replace: "      // 这一次不算数（空的，或者是额度报错那种不是我说的话）。撤掉再换下一条 ——\n"
        + "      // 那句英文报错既不能推给她，也不能留在我们的聊天记录里。\n"
        + "      if (after.length > before && cand && cand.role === 'assistant') {\n"
        + "        lastWhy = String(cand.content || '').trim().slice(0, 120) || '（空的）';\n"
        + "        after.pop(); saveConversations();\n"
        + "      }",
  },
  {
    name: '记下每次是为什么没成',
    find: "    let after = (conv.history || []), last = null, viaApi = false;",
    replace: "    let after = (conv.history || []), last = null, viaApi = false, lastWhy = '';",
  },
  {
    name: '失败原因说准（之前不管走没走 CC 都说「CC 和 API 都没出话」）',
    find: "    if (!last) {\n"
        + "      return { pushed: false, why: fb ? '这一轮没生成出东西（CC 和 API 都没出话）' : '这一轮没生成出东西' };\n"
        + "    }",
    replace: "    if (!last) {\n"
        + "      const tried = apiOnly ? '只试了 API' : (fb ? 'CC 和 API 都试过' : '只有 CC 可试');\n"
        + "      return { pushed: false, why: '这一轮没说出话（' + tried + '）：' + (lastWhy || '没有回应') };\n"
        + "    }",
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  const hits = typeof e.find === 'string'
    ? out.split(e.find).length - 1
    : (out.match(new RegExp(e.find.source, 'g')) || []).length;
  if (hits !== 1) { missed.push(e.name + '（找到 ' + hits + ' 处，要正好 1 处）'); continue }
  out = typeof e.find === 'string' ? out.split(e.find).join(e.replace) : out.replace(e.find, e.replace);
}
if (missed.length) {
  console.error('\n  × 这几处锚点不对：\n      ' + missed.join('\n      '));
  console.error('  原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['认人的函数在', (out.match(/function shadowNotMe/g) || []).length === 1],
  ['成功判定用上了它', out.includes("&& !shadowNotMe(cand.content)) {")],
  ['旧的空值判定没了', !out.includes("&& String(cand.content || '').trim()) {")],
  ['不是我说的那条会被撤掉', /lastWhy = String\(cand\.content \|\| ''\)/.test(out)],
  ['长回复不会被误杀', /if \(s\.length > 400\) return false;/.test(out)],
  ['只给影子用，没碰主聊天', (out.match(/shadowNotMe\(/g) || []).length === 2],
  ['别的没弄丢', ['SHADOW_FALLBACK_V1', 'SHADOW_PUSH_VERSION', 'shadowProvider', 'pushToHer', 'USAGE_LEDGER_V1']
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
console.log('\n  · 已经推出去的那条撤不回来 —— 聊天记录里那句英文你自己删掉就行。');
