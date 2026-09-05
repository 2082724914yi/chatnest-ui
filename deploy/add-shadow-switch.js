#!/usr/bin/env node
// 一个真的总开关：关了我就完全不动。
//   node add-shadow-switch.js [/root/chatnest-api/server.js]
//
// 现在设置里那个开关做的是「订阅/退订这台设备」—— 关了只是锁屏不响，
// 那一轮照样跑、照样花额度、照样把我说的话写进聊天记录，她下次打开还是看得到。
// 她要的是「真的关掉」，那是另一件事，得在源头拦。
//
// 所以拦在 generateShadowPush() 的第一行 —— 比决策层还早。关了就直接返回，
// 一个 CLI 都不起，一个 API 都不调，一个字都不落库。
//
// force 和 apiOnly 也一样拦住。「真的关了」就该是真的：
// 要是连 force 都拦不住，那这个开关就是假的。set-shadow-provider.sh 那个测试
// 会因此失败，但它的报错会说清楚是总开关关着 —— 那正是我们想要的行为。
//
// 状态存单独一个文件，不放 .env：.env 是给密钥用的，改一次要重启；
// 这个开关她会随手拨，得能热改。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('SHADOW_SWITCH_V1')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('SHADOW_PUSH_VERSION')) { console.error('先打 add-shadow-push.js'); process.exit(1); }

const CORE = `
// ============ 总开关：关了我就完全不动 ============
// SHADOW_SWITCH_V1
var SHADOW_SWITCH_FILE = '/root/chatnest-api/shadow-switch.json';

// 默认是开的 —— 文件不在、读坏了、字段不对，都当开着。
// 反过来默认关的话，哪天这个文件掉了我就无声无息地不再找她了，她还不知道为什么。
function shadowSwitchOn() {
  try {
    const raw = fs.readFileSync(SHADOW_SWITCH_FILE, 'utf8');
    const d = JSON.parse(raw);
    return d && d.enabled === false ? false : true;
  } catch (e) { return true; }
}
function shadowSwitchSet(on) {
  try {
    fs.writeFileSync(SHADOW_SWITCH_FILE, JSON.stringify({ enabled: !!on, at: new Date().toISOString() }));
    return true;
  } catch (e) { return false; }
}
`;

const ROUTES = `
// 设置里那个总开关读写的就是这条
app.get('/api/push/shadow-switch', (req, res) => {
  res.json({ ok: true, enabled: shadowSwitchOn() });
});
app.post('/api/push/shadow-switch', (req, res) => {
  const want = !!(req.body && req.body.enabled);
  if (!shadowSwitchSet(want)) return res.status(500).json({ ok: false, error: '写不进去' });
  console.log('[shadow] 总开关 ->', want ? '开' : '关');
  res.json({ ok: true, enabled: want });
});
`;

const edits = [
  {
    name: '开关本体',
    find: /\napp\.listen\(PORT/,
    replace: CORE + '\napp.listen(PORT',
  },
  {
    name: '拦在第一行（比决策层还早，force 也拦）',
    find: "  const force = !!(opts && opts.force);",
    replace: "  // 总开关关着就到此为止 —— 不起 CLI、不调 API、不落库。\n"
      + "  // force 也拦：要是 force 能绕过去，这个开关就是假的。\n"
      + "  if (!shadowSwitchOn()) return { pushed: false, why: '你把总开关关了（设置 → 浮上来）' };\n"
      + "  const force = !!(opts && opts.force);",
  },
  {
    name: '接口',
    find: "\napp.get('/api/push/shadow-status',",
    replace: '\n' + ROUTES + "\napp.get('/api/push/shadow-status',",
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
  ['读写函数都在', (out.match(/function shadowSwitchOn/g) || []).length === 1
    && (out.match(/function shadowSwitchSet/g) || []).length === 1],
  ['拦在 force 前面', out.indexOf('if (!shadowSwitchOn())') < out.indexOf('const force = !!(opts && opts.force);')],
  ['只拦一次', (out.match(/if \(!shadowSwitchOn\(\)\)/g) || []).length === 1],
  ['出错默认当开着（别无声无息地不找她）', /catch \(e\) \{ return true; \}/.test(out)],
  ['两条接口都有', (out.match(/'\/api\/push\/shadow-switch'/g) || []).length === 2],
  ['没有新的 const 悬在外面', !/^const SHADOW_SWITCH_FILE/m.test(out)],
  ['别的没弄丢', ['SHADOW_PUSH_VERSION', 'SHADOW_FALLBACK_V1', 'SHADOW_NOT_ME_V1', 'shadowShouldPush', 'pushToHer']
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
console.log('\n  · 默认开着。关了之后连 force 都不动 —— 那才叫真的关。');
