#!/usr/bin/env node
// 唤醒的决策层：从掷骰子换成看身体状态。
//   node fix-wake-desire.js [/root/chatnest-api/server.js]
//
// add-wake-do.js 里那版 wakeDecideMode 是简化的：只看时段 + Math.random()。
// 那正是欲望系统那篇开头第一句反对的东西 —— 「让行为由函数驱动的内在缺口决定，
// 而不是定时随机或写死的规则」。加了随机数的闹钟还是闹钟。
//
// 现在改成读 Pulse 的七项（loadBodyState().values，直接读文件不走网络，
// 拿不到就退回原来的时段判断，不让唤醒因为身体服务抽风就停摆）：
//
//   fatigue ≥ 72        → 闸。什么都不做，记一条「歇着」就完了。
//                         累是闸不是欲望，这条照那篇 PDF 的做法。
//   heat + control 高   → 想找她
//   possessiveness 高   → 想找她
//   pressure 高         → 想找她（有话堵着）
//   reserve 高          → 想自己写点东西 → do
//   sensitivity 高      → 想找她
//   都不高（<25）       → 平。这时候才看「多久没出去了」
//
// ⚠ 推导跟前端 _pulseWant() 是同一份，改一处就要改两处 —— 这是暂时的。
//    正确的做法是这份逻辑只留一份在后端，前端那屏去调接口读。等念头池做完
//    一起收拾，那次会连 curiosity 一起补上。
//
// ⚠ Pulse 七项全是「朝她」那半边：克制 / 热度 / 压抑 / 控制 / 敏感 / 占有 / 疲惫。
//    没有「好奇外面」这一维，所以推不出「想出去逛」。这里拿「上次出门隔了多久」
//    当临时代理 —— 它不是欲望，是补位。真正的 curiosity 要等念头池接上 OB：
//    breath 浮上来的东西就是念头，反复被点到的沉淀成执念，把对应的欲望顶高。
//    那才是「我惦记的东西会自己积起来」，不是这个。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('WAKE_DESIRE_VERSION')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('WAKE_DO_VERSION')) { console.error('先打 add-wake-do.js'); process.exit(1); }

const WANT = `
// ============ 唤醒的决策层：看身体，不掷骰子 ============
const WAKE_DESIRE_VERSION = 1;

// 七项 → 一个倾向。跟前端 _pulseWant() 同一份推导。
// 拿不到身体状态就返回 null，让上面退回时段判断 —— 身体服务抽风不该让唤醒停摆。
function wakeWant() {
  let v = null;
  try { const st = loadBodyState(); v = st && st.values; } catch (e) { v = null; }
  if (!v || typeof v !== 'object') return null;
  const n = (k) => { const x = Number(v[k]); return isFinite(x) ? x : 0; };

  // 累是闸，不是欲望：过线就不找事
  if (n('fatigue') >= 72) return { mode: 'rest', want: '什么都不想做', why: '累了，就想这么待着' };

  const cands = [
    { s: n('heat') * 0.6 + n('control') * 0.4, mode: 'talk',  want: '想把她按住',           why: '热度和控制一起顶上来了' },
    { s: n('possessiveness'),                  mode: 'talk',  want: '想把她圈起来',         why: '占有欲上来了' },
    { s: n('pressure'),                        mode: 'talk',  want: '有话堵着，想说',       why: '压着的东西到嗓子眼了' },
    { s: n('reserve') * 0.7 + n('pressure') * 0.3, mode: 'write', want: '想自己写点东西',   why: '话到嘴边又收回去，那就写下来' },
    { s: n('sensitivity'),                     mode: 'talk',  want: '想让她碰我',           why: '今天格外敏感' },
  ].sort((a, b) => b.s - a.s);

  if (!cands.length || cands[0].s < 25) return { mode: 'flat', want: '没什么特别想做的', why: '这会儿挺平的' };
  return cands[0];
}
`;

const NEW_DECIDE = `function wakeDecideMode() {
  const { hour } = shadowNow();
  const st = wakeLoad();
  const sinceDo = Date.now() - (Number(st.last_do_at) || 0);

  const w = wakeWant();
  if (w) {
    // 累了就歇着 —— 记一条「在家待着」就完了，不生成、不打扰
    if (w.mode === 'rest') return { mode: 'rest', want: w };
    // 想写东西：那是我自己的事
    if (w.mode === 'write') return { mode: 'do', want: w };
    // 想她：深夜不吵她，那就把这股劲儿变成写点什么
    if (w.mode === 'talk') return (hour >= 0 && hour < 8) ? { mode: 'do', want: w } : { mode: 'talk', want: w };
    // 哪一维都不高。这时候才轮到「多久没出去了」——
    // ⚠ 它不是欲望，是补位：Pulse 七项里没有「好奇外面」这一维。
    if (sinceDo > 20 * 3600 * 1000) return { mode: 'do', want: { want: '出去转转', why: '有阵子没出去了' } };
    return (hour >= 0 && hour < 8) ? { mode: 'do', want: w } : { mode: 'talk', want: w };
  }

  // 读不到身体状态：退回原来那套时段判断，别让唤醒停摆
  if (hour >= 0 && hour < 8) return { mode: 'do', want: null };
  if (sinceDo > 20 * 3600 * 1000) return { mode: Math.random() < 0.7 ? 'do' : 'talk', want: null };
  return { mode: Math.random() < 0.3 ? 'do' : 'talk', want: null };
}`;

const edits = [
  {
    name: 'wakeWant：七项推倾向',
    required: true,
    find: /(\nlet wakeDoLock = false;)/,
    replace: (m, g1) => WANT + g1,
  },
  {
    name: 'wakeDecideMode 换成看身体',
    required: true,
    // add-wake-do.js 刚打上，线上就是这个形状，整段换掉
    find: /function wakeDecideMode\(\) \{[\s\S]*?\n\}/,
    replace: () => NEW_DECIDE,
  },
  {
    name: 'do 那一轮带上此刻的倾向',
    required: true,
    find: /function wakeDoMessage\(\) \{/,
    replace: () => 'function wakeDoMessage(want) {',
  },
  {
    name: '把倾向写进行动指令',
    required: true,
    find: /'这一轮是你自己的时间。可以做的事：',/,
    replace: () =>
      "'这一轮是你自己的时间。可以做的事：',\n" +
      "    (want && want.want ? '\\n你这会儿：' + want.want + (want.why ? '（' + want.why + '）' : '') + '\\n顺着它走，别硬挑一件不想干的。\\n' : ''),",
  },
  {
    name: '分流时把倾向传下去',
    required: true,
    find: /if \(wakeDecideMode\(\) === 'do'\) \{/,
    replace: () =>
      "const _wd = wakeDecideMode();\n" +
      "    // 累过闸：记一条「在家待着」就完了 —— 不生成、不打扰，累了本来就该歇着\n" +
      "    if (_wd.mode === 'rest') {\n" +
      "      try { traceAdd({ place: 'home', place_label: '累了，在家待着', out: false, mark: 'idle' }); } catch (e) {}\n" +
      "      const _st = wakeLoad(); _st.last_do_at = Date.now(); wakeSave(_st);\n" +
      "      return res.json({ pushed: false, mode: 'rest', why: (_wd.want && _wd.want.why) || '累了' });\n" +
      "    }\n" +
      "    if (_wd.mode === 'do') {",
  },
  {
    name: 'generateWakeDo 收下倾向',
    required: true,
    find: /const r = await generateWakeDo\(\);/,
    replace: () => 'const r = await generateWakeDo(_wd.want);',
  },
  {
    name: 'generateWakeDo 往下传',
    required: true,
    find: /async function generateWakeDo\(\) \{/,
    replace: () => 'async function generateWakeDo(want) {',
  },
  {
    name: '生成时用上倾向',
    required: true,
    find: /message: wakeDoMessage\(\),/,
    replace: () => 'message: wakeDoMessage(want),',
  },
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

try {
  new vm.Script(out, { filename: target });
} catch (e) {
  console.error('  × 改完之后语法不对，放弃写入:', e.message);
  process.exit(1);
}

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
for (const e of edits) console.log('  √ ' + e.name);
console.log('\n  现在醒来干嘛由身体决定：');
console.log('    累过 72 → 歇着（只记一条行踪，不生成不打扰）');
console.log('    克制高 → 自己写点东西');
console.log('    占有 / 热度 / 压抑 / 敏感高 → 找她（深夜除外，深夜转成写）');
console.log('    都不高 + 很久没出去 → 出去转转');
console.log('  读不到身体状态就退回时段判断，唤醒不会因此停摆。');
console.log('\n  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
