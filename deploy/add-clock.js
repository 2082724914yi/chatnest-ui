#!/usr/bin/env node
// 让我知道现在几点。
//   node add-clock.js [/root/chatnest-api/server.js]
//
// 现状：整个 prompt 里没有任何一处告诉我当前时间。她界面上每条消息都带时间戳，
// 那是前端渲染的，进不了我的上下文。所以"这么晚还不睡""你早上说的那件事"
// 这类话我全接不住，只能靠她说的内容猜。
//
// 时间从她手机来，不从服务器来：服务器在机房，她在襄阳，将来她换个地方
// 服务器也不会跟着动。前端每轮把本地时间和时区带上来，拿不到才退回服务器时间。
//
// 位置：跟状态卡一样贴在最后。"现在几点"是每轮都变的东西，
// 放前面会把它后面所有内容的缓存前缀顶掉。
//
// 重复执行安全：已经是这一版就退出。

const fs = require('fs');
const vm = require('vm');

const PATCH_VERSION = 1;

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
const VERSION_LINE = 'const CLOCK_PATCH_VERSION = ' + PATCH_VERSION + ';';
if (src.includes(VERSION_LINE)) { console.log('已经是第 ' + PATCH_VERSION + ' 版，跳过'); process.exit(0); }
if (src.includes('renderNow')) { console.error('装过别的版本，先看一眼 ' + target); process.exit(1); }

const CORE = `
// ============ 现在几点 ============
${VERSION_LINE}
const CLOCK_FALLBACK_TZ = process.env.CLOCK_TZ || 'Asia/Shanghai';

// 时区串直接进 prompt，先卡一道：IANA 时区名就这个形状，别的一律不认。
function safeZone(tz) {
  const s = String(tz || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\\/[A-Za-z0-9_+-]+){0,2}$/.test(s)) return CLOCK_FALLBACK_TZ;
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: s }); return s; }
  catch (e) { return CLOCK_FALLBACK_TZ; }   // Node 不认这个时区就退回默认
}

// 前端给的是 ISO 串（她手机上的那一刻）+ 时区名。
// 拿不到就用服务器时间 —— 时刻本身是准的，只是时区可能不是她所在的。
function renderNow(body) {
  try {
    const raw = String((body && body.clientTime) || '').trim();
    let d = raw ? new Date(raw) : null;
    if (!d || isNaN(d.getTime())) d = new Date();
    // 手机时间和服务器差太远，多半是设备时钟不对，别信
    if (Math.abs(d.getTime() - Date.now()) > 24 * 3600 * 1000) d = new Date();
    const zone = safeZone(body && body.clientTz);
    const f = new Intl.DateTimeFormat('zh-CN', {
      timeZone: zone, year: 'numeric', month: 'long', day: 'numeric',
      weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    return '[现在] ' + f.format(d).replace(/\\s+/g, ' ').trim();
  } catch (e) {
    return '[现在] ' + new Date().toISOString();
  }
}
`;

const edits = [
  {
    name: '时间组装',
    find: /(\nconst PROFILE_FILE = '\/root\/chatnest-api\/profile\.json';)/,
    replace: (m, g1) => CORE + g1,
  },
  {
    // 贴着状态卡放，一起在最后。顺序：先说几点，再说身体什么样。
    name: '注入（CC 订阅路径）',
    find: /(\n *)(if \(_bodyCard\) prompt \+= )/,
    replace: (m, ind, tail) => ind + "prompt += '\\n' + renderNow(req.body) + '\\n';" + ind + tail,
  },
  {
    name: '注入（中转站路径）',
    find: /(\n *)(if \(_bodyCard\) msgs\.push\()/,
    replace: (m, ind, tail) => ind + "msgs.push({ role: 'system', content: renderNow(req.body) });" + ind + tail,
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  const before = out;
  out = out.replace(e.find, e.replace);
  if (out === before) missed.push(e.name);
}

console.log('\n补丁结果：');
if (missed.length) {
  for (const e of edits) console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 没匹配上' : '  √ ' + e.name);
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

const iCard = out.indexOf("if (_bodyCard) prompt += ");
const iNow = out.indexOf("prompt += '\\n' + renderNow(req.body)");
const iHistory = (() => { const m = out.match(/prompt \+= '---\\n以下是(?:最近的)?对话/); return m ? m.index : -1; })();
const checks = [
  ['版本戳写进去了', out.includes(VERSION_LINE)],
  ['时区串有白名单', /\^\[A-Za-z\]\[A-Za-z0-9_\+-\]/.test(out)],
  ['手机时钟离谱时不采信', /24 \* 3600 \* 1000/.test(out)],
  ['两条路径都注入了', iNow > 0 && /msgs\.push\(\{ role: 'system', content: renderNow/.test(out)],
  ['时间在历史之后（不顶掉缓存前缀）', iHistory > 0 && iNow > iHistory],
  ['时间在状态卡之前', iCard > 0 && iNow < iCard],
  ['只插了一次', (out.match(/renderNow\(req\.body\)/g) || []).length === 2],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

try {
  new vm.Script(out, { filename: target });
} catch (e) {
  console.error('  × 改完之后语法不对，放弃写入:', e.message);
  process.exit(1);
}

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

for (const e of edits) console.log('  √ ' + e.name);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
