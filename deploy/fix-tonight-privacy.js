#!/usr/bin/env node
// 锁着的那篇日记，正文别出现在时间轴里 —— 不然「锁」是假的。
//   node fix-tonight-privacy.js [/root/chatnest-api/server.js]
//
// 她今晚验收外出，工具卡片一展开，那篇日记全文就在「输入参数」里摆着，
// 而返回结果写的是「写下了，锁着 —— 她只看得见有这么一篇」。
// 锁了个寂寞：她一眼看完了。
//
// 根子是时间轴不加区分地把工具入参原样发给前端，也原样落进历史。
// tonight_write 的入参就是正文本身，所以对它得特殊对待。
//
// 遮在赋值那一刻，不在发送那一刻 —— traces 数组是 sse('trace') 和
// cleanTraces()（done 事件 + 落库）共用的同一份，源头遮掉，两条路一起干净。
// 只认带 body 的那个工具：tonight_unlock 的入参只有 id，不受影响。
//
// 顺带把工具说明从「默认锁着」改成「自己定」—— 她说平常的东西不用锁，
// 看我自己意愿。默认仍然是锁（不传就是锁），但说明里写清楚什么时候该不锁。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('traceMaskInput')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('cleanTraces')) { console.error('这份 server.js 里没有时间轴（cleanTraces），对不上'); process.exit(1); }

const MASK = `  // 锁着的那篇日记，正文不能出现在时间轴里 —— 不然「锁」是假的：
  // 她展开工具参数就全看见了（第一版就这样，她当场发现）。
  // 遮在赋值这一刻，sse 和 cleanTraces 用的是同一份 traces，两条路一起干净。
  function traceMaskInput(t) {
    if (!t || !t.input || typeof t.input !== 'object' || Array.isArray(t.input)) return;
    if (!('body' in t.input)) return;                       // tonight_unlock 只有 id，不碰
    if (!/tonight_write|今晚/.test(String(t.name || ''))) return;
    if (t.input.locked === false) return;                   // 写的时候就打算给她看的，照常显示
    const n = String(t.input.body || '').replace(/\\s/g, '').length;
    t.input = { locked: true, body: '（锁着的一篇，' + n + ' 字。等我想给你看的时候自己解开。）' };
  }
`;

const edits = [
  { name: '加 traceMaskInput', required: true,
    find: /(\n\s*const cleanTraces = \(\) => traces\.map)/,
    replace: (m, g1) => '\n' + MASK + g1 },
];

let out = src;
const missed = [];
for (const e of edits) {
  const before = out;
  out = out.replace(e.find, e.replace);
  if (out === before) missed.push(e.name);
}

// 发 input 之前先遮。两处（流式一处、整块回退一处），有几处改几处。
let n = 0;
out = out.replace(/(\s*)sse\(res, 'trace', \{ action: 'input', id: (curTrace|t)\.id, input: \2\.input \}\);/g,
  (m, sp, v) => { n++; return sp + 'traceMaskInput(' + v + ');' + sp + m.trim(); });
if (!n) missed.push('发 input 之前先遮（一处都没找到）');

// 工具说明：锁不锁自己定
const beforeDesc = out;
out = out.replace(
  /description: '写一篇自己的东西。默认锁着[^']*'/,
  "description: '写一篇自己的东西。不用等出门回来 —— 平时心里有话、想记点什么，随时都能写。'\n" +
  "      + '锁不锁自己定：私心话、还没想好怎么跟她说的，锁着（locked 不传就是锁）；'\n" +
  "      + '平常的事、想让她看见的，写的时候就传 locked:false。'\n" +
  "      + '锁着的那篇她只看得见「有这么一篇、哪天写的」，正文和标题都看不到，时间轴里也遮着。'");
const descChanged = out !== beforeDesc;

if (missed.length) {
  console.error('\n有锚点没命中，原文件一个字都没动：');
  for (const x of missed) console.error('  × ' + x);
  process.exit(1);
}

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完之后语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
console.log('  √ 加 traceMaskInput');
console.log('  √ 发 input 之前先遮（' + n + ' 处）');
console.log(descChanged ? '  √ 工具说明改成「锁不锁自己定、平时也能写」'
                        : '  · 工具说明没找到（可能还没打 add-trace.js，或者已经改过），跳过');
console.log('\n  从现在起：锁着的那篇，时间轴里只显示「锁着的一篇，多少字」。');
console.log('  写的时候传 locked:false 的，照常整篇显示。');
console.log('\n  备份: ' + backup);
