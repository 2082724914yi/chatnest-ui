#!/usr/bin/env node
// 睡眠按「片段」算：一晚上是好多段，逐段折成分钟再求和。
//   node fix-watch-sleep3.js [/root/chatnest-api/server.js]
//
// iOS 的睡眠不是一个数：一晚被切成 core / deep / rem / awake 好多段
// （所以捷径里「快速查看」弹出来的值是 "core"）。要拿整晚时长，只能把所有
// asleep 的片段加起来。捷径把列表塞进一个字段时会拼成：
//   "40 分钟, 1 小时 20 分钟, 25 分钟"   或   "2400, 4800, 1500"（秒）
//
// v2 那版对多片段是「把所有数字加起来」，混着单位就全错了：
//   "40 分钟, 1 小时 20 分钟" 会被当成 40+1+20；而且带「小时」时只认第一段。
// v3 改成：先按逗号/换行切开，**每段单独折成分钟**，再求和。
//
// 单位判断也分场景：
//   单独一个数 —— ≤24 当小时（她手填 8 就是 8 小时），>1440 当秒，中间当分钟；
//   多个片段   —— 不再猜「小时」（片段不可能是 8 小时那种整数），>1440 当秒，否则分钟。
//
// 依赖 fix-watch-sleep.js + fix-watch-sleep2.js 先打上。
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('WATCH_SLEEP_SEGMENTS')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('WATCH_SLEEP_PARSE')) { console.error('要先打 fix-watch-sleep2.js'); process.exit(1); }

// 1) 整块换掉 v2 的解析函数
const OLD = `function watchParseSleep(raw) {
  const s = String(raw == null ? '' : raw).replace(/,(?=\\d{3}\\b)/g, '').trim();
  if (!s) return null;
  // "6:14" / "6:14:30" -> 分钟
  let m = s.match(/^(\\d{1,2}):([0-5]\\d)(?::([0-5]\\d))?$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  // "6 小时 14 分钟" / "6h14m" / "6 hr 14 min"
  if (/小时|hour|hrs?\\b|(?<=\\d)\\s*h\\b/i.test(s)) {
    const h = s.match(/(\\d+(?:\\.\\d+)?)\\s*(?:小时|hours?|hrs?|h)/i);
    const mi = s.match(/(\\d+(?:\\.\\d+)?)\\s*(?:分钟|minutes?|mins?|分|m(?![a-z]))/i);
    if (h) return Number(h[1]) * 60 + (mi ? Number(mi[1]) : 0);
  }
  // 剩下的：可能是一个数，也可能是一串片段（她把列表组合成了文本）——全加起来
  const nums = (s.match(/\\d+(?:\\.\\d+)?/g) || []).map(Number).filter(n => Number.isFinite(n) && n >= 0);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0);
}`;
if (!src.includes(OLD)) { console.error('找不到 v2 的 watchParseSleep 原文'); process.exit(1); }

const NEW = `// WATCH_SLEEP_SEGMENTS：一段睡眠折成分钟。seg=true 表示这是整晚里的一小段。
function watchParseSleepOne(s, seg) {
  s = String(s || '').trim();
  if (!s) return null;
  // "6:14" / "6:14:30"
  let m = s.match(/^(\\d{1,2}):([0-5]\\d)(?::([0-5]\\d))?$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  // "6 小时 14 分钟" / "6h14m" / "6 hr 14 min" / "40 分钟"
  const h = s.match(/(\\d+(?:\\.\\d+)?)\\s*(?:小时|hours?|hrs?|h(?![a-z]))/i);
  const mi = s.match(/(\\d+(?:\\.\\d+)?)\\s*(?:分钟|minutes?|mins?|分|m(?![a-z]))/i);
  if (h || mi) return (h ? Number(h[1]) * 60 : 0) + (mi ? Number(mi[1]) : 0);
  // 纯数字
  const n = Number((s.match(/\\d+(?:\\.\\d+)?/) || [])[0]);
  if (!Number.isFinite(n)) return null;
  if (n > 1440) return n / 60;             // 秒
  if (!seg && n > 0 && n <= 24) return n * 60;  // 单独一个小数字：当小时
  return n;                                 // 分钟
}
// 返回**分钟**。多片段就逐段折算再求和 —— 别把不同单位的数字混着加。
function watchParseSleep(raw) {
  if (Array.isArray(raw)) raw = raw.join(',');
  const s = String(raw == null ? '' : raw).replace(/,(?=\\d{3}\\b)/g, '').trim();
  if (!s) return null;
  const parts = s.split(/[\\n\\r,;、]+/).map(x => x.trim()).filter(Boolean);
  if (parts.length > 1) {
    let sum = 0, any = false;
    for (const p of parts) {
      const v = watchParseSleepOne(p, true);
      if (v !== null && Number.isFinite(v)) { sum += v; any = true; }
    }
    return any ? sum : null;
  }
  return watchParseSleepOne(s, false);
}`;
let out = src.replace(OLD, NEW);

// 2) parse 出来已经是分钟了，别再让 normalize 拿它猜单位（40 分钟会被当成 40 小时）
const CALL_OLD =
  "      const parsed = watchParseSleep(_rawv);\n" +
  "      if (parsed === null) continue;\n" +
  "      v = watchNormalize(k, parsed);";
if (!out.includes(CALL_OLD)) { console.error('找不到 sanitize 里的调用'); process.exit(1); }
const CALL_NEW =
  "      const parsed = watchParseSleep(_rawv);\n" +
  "      if (parsed === null) continue;\n" +
  "      v = parsed;   // 已经是分钟，不再猜单位";
out = out.replace(CALL_OLD, CALL_NEW);

const checks = [
  ['分段解析在', /function watchParseSleepOne\(/.test(out)],
  ['按分隔符切开', /split\(\/\[\\n\\r,;、\]\+\//.test(out)],
  ['数组也认', /Array\.isArray\(raw\)/.test(out)],
  ['不再二次归一', /v = parsed;   \/\/ 已经是分钟/.test(out)],
  ['只插一次', (out.match(/WATCH_SLEEP_SEGMENTS/g) || []).length === 1],
  ['别的指标没动', /const hit = s\.match\(\/-\?\\d\+/.test(out)],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、')); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
