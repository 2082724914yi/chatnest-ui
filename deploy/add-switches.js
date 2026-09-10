#!/usr/bin/env node
// 两个开关分清楚：出不出声，和动不动。
//   node add-switches.js [/root/chatnest-api/server.js]
//
// 她说：「在设置里那个浮上来里做一个推送和自动唤醒的开关，
// 因为有时候可能有问题不需要推送。」
//
// 查下来发现「浮上来」里那个开关文案是这么写的：
//   「让我自己来找你 —— 关了就是真的关了，我不会跑，不花额度」
// 但它接的 shadowSwitchOn() 只拦 generateShadowPush（找她说话那条），
// do 那条路（出去逛、写东西）根本不看它。所以关了之后我照样醒、照样
// 花额度，只是不吭声。**文案在骗她。**
//
// 这个补丁把两件事分开，各归各位：
//   · 出声  —— 复用现有的 shadow-switch，它本来就是干这个的。
//              关了我不找她说话，但照常过我的（出去逛、写东西、记日历）。
//   · 动不动 —— 新的 wake_off，真正的总闸。关了连出去逛都不去，
//              一分额度不花。调试或者出问题的时候用这个。
// 前端一个接口读到两个开关，后端各自落到已有的存储里，不新造第三套。
//
// 顺带一个小改进：出声关着的时候，那一轮不浪费 —— 本来要找她说话的，
// 拐去做自己的事。预约到点那条也一起挡住，不然「我说好几点找她」会绕过开关。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('WAKE_SWITCHES')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('WAKE_DO_VERSION')) { console.error('先打 add-wake-do.js'); process.exit(1); }
if (!src.includes('function shadowSwitchOn')) { console.error('先打 add-shadow-switch.js'); process.exit(1); }

const ROUTES = `
// ---- 两个开关：出声 / 动不动 ---- WAKE_SWITCHES
// push  = 找不找她说话。落在 shadow-switch 上（那本来就是它管的事）。
// wake  = 动不动。新的总闸，关了连出去逛都不去。
// 存的是「关」不是「开」：没这个字段就等于开着，跟以前的行为一致。
function wakeSwitches() {
  return { push: shadowSwitchOn(), wake: !wakeLoad().wake_off };
}
app.get('/api/wake/switches', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(Object.assign({ ok: true }, wakeSwitches()));
});
app.post('/api/wake/switches', (req, res) => {
  const b = req.body || {};
  if ('push' in b) shadowSwitchSet(!!b.push);
  if ('wake' in b) { const st = wakeLoad(); st.wake_off = !b.wake; wakeSave(st); }
  const s = wakeSwitches();
  console.log('[wake] 开关：出声 ' + (s.push ? '开' : '关') + '，动不动 ' + (s.wake ? '开' : '关'));
  res.json(Object.assign({ ok: true }, s));
});
`;

const edits = [
  { name: '两个开关的读写接口', required: true,
    find: /(\napp\.listen\(PORT)/,
    replace: (m, g1) => ROUTES + g1 },

  { name: '总闸关了就整个不动', required: true,
    find: /(async function wakeTriggerHandler\(req, res\) \{\n\s*try \{\n)([\s\S]*?)if \(wakeDueNow\(\)\) \{/,
    replace: (m, head, mid) => head +
      "    // 总闸关了：整套闸掉，连出去逛都不去，一分额度不花。\n" +
      "    if (wakeLoad().wake_off) return res.json({ pushed: false, mode: 'off', why: '她把自动唤醒关了' });\n" +
      "    // 出声关着：不找她说话，但这一轮不浪费 —— 下面会拐去做自己的事。\n" +
      "    // 预约到点那条也一起挡住，不然「我说好几点找她」会绕过开关。\n" +
      "    const _quiet = !shadowSwitchOn();\n" +
      mid + "if (wakeDueNow() && !_quiet) {" },

  // ⚠ 线上不是 if (wakeDecideMode() === 'do')：fix-wake-desire.js 把它拆成了
  //   const _wd = wakeDecideMode() 再判 _wd.mode，还在前面插了一条 rest 分支。
  //   rest（累了歇着）要留在前面不动 —— 不出声不等于该硬找事做。
  { name: '不出声的那一轮拿去做自己的事', required: true,
    find: /if \(_wd\.mode === 'do'\) \{/,
    replace: () => "if (_wd.mode === 'do' || _quiet) {" },
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
console.log('\n  GET/POST /api/wake/switches —— {push, wake}');
console.log('  push 落在 shadow-switch（原有），wake 落在 wake-state（新的总闸）。');
console.log('  默认两个都开着。');
console.log('\n  备份: ' + backup);
