#!/usr/bin/env node
// 睡眠再宽容一点：捷径那头给什么形状都尽量收下。
//   node fix-watch-sleep2.js [/root/chatnest-api/server.js]
//
// iOS 的睡眠不是一个数，是**一晚上一堆片段**（核心/深度/REM/清醒各一条）。
// 捷径里「持续时间」拿到的可能是：
//   "6 小时 14 分钟"（本地化文本）  "6:14"  "22440"（秒）  "374"（分钟）
//   "1800, 2400, 900"（多个片段，她把列表组合成文本）
// 原来只抠第一个数字，前四种能凑合，最后一种会只算第一段 —— 都不对。
//
// 改成专门的睡眠解析：先认「时:分」和「几小时几分钟」，
// 认不出就把所有数字当片段求和，再交给单位判断（小时/分钟/秒）。
//
// 依赖 fix-watch-sleep.js（WATCH_SLEEP_UNITS）先打上。
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('WATCH_SLEEP_PARSE')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('WATCH_SLEEP_UNITS')) { console.error('要先打 fix-watch-sleep.js'); process.exit(1); }

// 1) 插入睡眠专用解析函数（挂在 watchNormalize 前面）
const fnAnchor = 'function watchNormalize(key, v) {';
if (!src.includes(fnAnchor)) { console.error('找不到 watchNormalize'); process.exit(1); }

const PARSER =
  '// WATCH_SLEEP_PARSE：睡眠是一晚上一堆片段，形状五花八门，专门认一遍\n' +
  'function watchParseSleep(raw) {\n' +
  '  const s = String(raw == null ? \'\' : raw).replace(/,(?=\\d{3}\\b)/g, \'\').trim();\n' +
  '  if (!s) return null;\n' +
  '  // "6:14" / "6:14:30" -> 分钟\n' +
  '  let m = s.match(/^(\\d{1,2}):([0-5]\\d)(?::([0-5]\\d))?$/);\n' +
  '  if (m) return Number(m[1]) * 60 + Number(m[2]);\n' +
  '  // "6 小时 14 分钟" / "6h14m" / "6 hr 14 min"\n' +
  '  if (/小时|hour|hrs?\\b|(?<=\\d)\\s*h\\b/i.test(s)) {\n' +
  '    const h = s.match(/(\\d+(?:\\.\\d+)?)\\s*(?:小时|hours?|hrs?|h)/i);\n' +
  // 别用 \\b 收尾：中文「分钟」后面是非单词字符，压根构不成词边界，14 分钟会被漏掉
  '    const mi = s.match(/(\\d+(?:\\.\\d+)?)\\s*(?:分钟|minutes?|mins?|分|m(?![a-z]))/i);\n' +
  '    if (h) return Number(h[1]) * 60 + (mi ? Number(mi[1]) : 0);\n' +
  '  }\n' +
  '  // 剩下的：可能是一个数，也可能是一串片段（她把列表组合成了文本）——全加起来\n' +
  '  const nums = (s.match(/\\d+(?:\\.\\d+)?/g) || []).map(Number).filter(n => Number.isFinite(n) && n >= 0);\n' +
  '  if (!nums.length) return null;\n' +
  '  return nums.reduce((a, b) => a + b, 0);\n' +
  '}\n' +
  fnAnchor;

let out = src.replace(fnAnchor, PARSER);

// 2) watchSanitize 里 sleep 走这条专用解析，别再只抠第一个数字
const pickAnchor =
  "    const s = String(m.value === undefined ? m : m.value).replace(/,/g, '');\n" +
  "    const hit = s.match(/-?\\d+(?:\\.\\d+)?/);\n" +
  "    if (!hit) continue;\n" +
  "    const v = watchNormalize(k, Number(hit[0]));";
if (!out.includes(pickAnchor)) { console.error('找不到 watchSanitize 取数那段'); process.exit(1); }

const pickNew =
  "    const _rawv = (m.value === undefined ? m : m.value);\n" +
  "    let v;\n" +
  "    if (k === 'sleep_minutes') {\n" +
  "      const parsed = watchParseSleep(_rawv);\n" +
  "      if (parsed === null) continue;\n" +
  "      v = watchNormalize(k, parsed);\n" +
  "    } else {\n" +
  "      const s = String(_rawv).replace(/,/g, '');\n" +
  "      const hit = s.match(/-?\\d+(?:\\.\\d+)?/);\n" +
  "      if (!hit) continue;\n" +
  "      v = watchNormalize(k, Number(hit[0]));\n" +
  "    }";
out = out.replace(pickAnchor, pickNew);

const checks = [
  ['解析函数在', /function watchParseSleep\(/.test(out)],
  ['sanitize 走了专用解析', /const parsed = watchParseSleep\(_rawv\)/.test(out)],
  ['别的指标还是老路', /const hit = s\.match\(\/-\?\\d\+/.test(out)],
  ['只插一次', (out.match(/WATCH_SLEEP_PARSE/g) || []).length === 1],
  ['单位判断还在', /WATCH_SLEEP_UNITS/.test(out)],
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
