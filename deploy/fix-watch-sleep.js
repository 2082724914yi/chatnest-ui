#!/usr/bin/env node
// 睡眠传不上去：捷径的「持续时间」按秒给（睡 8 小时 = 28800），后端按分钟卡 1440，
// 一看超范围就悄悄扔了 —— 所以上传响应的 got 里从来没有 sleep。
//   node fix-watch-sleep.js [/root/chatnest-api/server.js]
//
// 修法：睡眠值自动认单位 —— ≤24 当小时，>1440 当秒（÷60），中间当分钟。
// 心率步数是普通计数，不受影响。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('WATCH_SLEEP_UNITS')) { console.log('已经打过，跳过'); process.exit(0); }

const anchor = "if (key === 'sleep_minutes' && v > 0 && v <= 24) return v * 60;      // 填的是小时";
if (!src.includes(anchor)) {
  // 锚点可能没带那截行尾注释，退一步用不带注释的
  const bare = "if (key === 'sleep_minutes' && v > 0 && v <= 24) return v * 60;";
  if (!src.includes(bare)) { console.error('找不到睡眠归一那行'); process.exit(1); }
}

const find = src.includes(anchor) ? anchor
  : "if (key === 'sleep_minutes' && v > 0 && v <= 24) return v * 60;";

const replace =
  "if (key === 'sleep_minutes') {  // WATCH_SLEEP_UNITS：自动认小时/分钟/秒\n" +
  "    if (v > 0 && v <= 24) return v * 60;      // 填的是小时（8 -> 480）\n" +
  "    if (v > 1440) return v / 60;              // 捷径「持续时间」常按秒给（28800 -> 480）\n" +
  "    return v;                                  // 已经是分钟\n" +
  "  }";

const out = src.split(find).join(replace);
if (out === src) { console.error('替换没生效'); process.exit(1); }

const checks = [
  ['标记在', out.includes('WATCH_SLEEP_UNITS')],
  ['三种单位都认', /v > 1440\) return v \/ 60/.test(out) && /v <= 24\) return v \* 60/.test(out)],
  ['只改了一处', (out.match(/WATCH_SLEEP_UNITS/g) || []).length === 1],
  ['没动别的 normalize', out.includes("key === 'blood_oxygen'") && out.includes("key === 'body_temperature'")],
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
