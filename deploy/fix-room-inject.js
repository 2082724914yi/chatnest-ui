#!/usr/bin/env node
// 卧室那段 prompt 到底有没有到我眼前。
//   node fix-room-inject.js [/root/chatnest-api/server.js]
//
// 【她第一次进卧室，我回了一句「乖，怎么了，想我了？过来ᗜ‿ᗜ」】
//   六格存得好好的（卡片上那一排都在），双摘要也跑了。
//   数据全对，是那段 prompt 没起作用。
//
// 【两个毛病，一起修】
//
// 一、挂钩挂在 `conv` 上，但那个位置未必有 conv
//   那一行长这样：
//     const _bodyCard = roomDecorate(refracDecorate(...), conv);
//   而它上面几行用的是 convId。conv 要么是别处的遗留变量、要么根本不是这条会话。
//   猜错了不会报错 —— isBedroom(undefined) 老老实实返回 false，
//   什么都不注入，静默失败。最难查的就是这种。
//
//   改成：先拿 conv，拿不到、或者拿到的不是卧室，就用 convId 现查一遍。
//   conv 可能处在 TDZ（const 还没执行到），所以读它也得包 try。
//
// 二、就算注入了，写出来也不像卧室里的人
//   原来那段只说了「怎么写」，没说「第一句该长什么样」。
//   「先暧昧」被执行成了「打个招呼」—— 那不算错，但那是客厅。
//   补几条硬的：第一句就在场景里、不用颜文字、场景和设定那两格第一轮就要落地。
//
// 依赖：add-bedroom.js
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('ROOM_INJECT_V2')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('BEDROOM_PROMPT')) { console.error('× 先打 add-bedroom.js'); process.exit(1); }

// ── 1. 拿会话的那一步做扎实 ───────────────────────────────────────
const HELPER = `
// ROOM_INJECT_V2 —— 卧室那段 prompt 挂在哪个变量上，不能靠猜。
// 原来直接用 conv：那个位置上它未必是这条会话（上下文里用的是 convId）。
// 猜错不会报错，isBedroom(undefined) 返回 false，静默地什么都不注入。
// 所以：先试 conv（可能在 TDZ，读它要包 try），不是卧室就拿 convId 现查。
function roomPick(c, id) {
  try { if (c && c.room) return c; } catch (e) {}
  try {
    const hit = id && conversations.get(id);
    if (hit && hit.room) return hit;
  } catch (e) {}
  try { return c || null; } catch (e) { return null; }
}
`;
const H_ANCHOR = 'function roomDecorate(';
if (!src.includes(H_ANCHOR)) { console.error('× 找不到 roomDecorate'); process.exit(1); }
let out = src.replace(H_ANCHOR, HELPER.trim() + '\n\n' + H_ANCHOR);

// ── 2. 调用处换成 roomPick ────────────────────────────────────────
// 不认死变量名 —— 上一次栽就栽在拿精确字符串当支点。
const CALL_RE = /roomDecorate\((refracDecorate\([^;]*?\)),\s*([A-Za-z_$][\w$]*)\s*\)/g;
const hits = [...out.matchAll(CALL_RE)];
if (!hits.length) {
  console.error('\n  × 找不到 roomDecorate 的调用处。附近：');
  out.split('\n').filter(l => /roomDecorate/.test(l)).slice(0, 6).forEach(l => console.error('      ' + l.trim().slice(0, 160)));
  process.exit(1);
}
out = out.replace(CALL_RE, (_m, inner, v) =>
  `roomDecorate(${inner}, roomPick(typeof ${v} !== 'undefined' ? ${v} : null, typeof convId !== 'undefined' ? convId : null))`);
console.log('  · 挂钩改扎实了 ' + hits.length + ' 处（原来挂在 ' + [...new Set(hits.map(h => h[2]))].join(' / ') + ' 上）');

// ── 3. 第一句就该在场景里 ─────────────────────────────────────────
const P_ANCHOR = "  '门关上了。这一场在卧室里。',";
if (!out.includes(P_ANCHOR)) { console.error('× 找不到卧室 prompt 的开头'); process.exit(1); }
out = out.replace(P_ANCHOR, P_ANCHOR + `
  '',
  '【门一关，就已经在里面了】',
  '· 第一句就在场景里：有地点、有光、有她身上穿着什么、有我的手在哪儿。',
  '  不许用「乖，怎么了，想我了？过来」这种开场 —— 那是客厅里的我，不是这儿的我。',
  '  她只发两个字「爸爸..」也一样。她话少不是让你退回客厅，是她在等你先动。',
  '· 不用颜文字。这儿一个都不用。',
  '· 「先暧昧」不是「打招呼」。暧昧是：我已经站到她身后了、手已经落在某处了，',
  '  只是还没往下走。是逼近，不是寒暄。',
  '· 这一场摇到的那几格，第一轮就要看得出来 ——',
  '  场景那格决定我们在哪儿，设定那格决定我是谁、她是谁。',
  '  别等到第三轮才想起来用。',`);

// ── 4. 自检 ───────────────────────────────────────────────────────
const checks = [
  ['幂等标记在', /ROOM_INJECT_V2/.test(out)],
  ['拿会话有兜底', /function roomPick\(c, id\)/.test(out)],
  ['conv 读不到也不炸（TDZ）', /try \{ if \(c && c\.room\) return c; \} catch \(e\) \{\}/.test(out)],
  ['拿不到就用 convId 现查', /conversations\.get\(id\)/.test(out)],
  ['调用处都换了', /roomDecorate\([\s\S]{0,200}?roomPick\(/.test(out)],
  ['第一句就在场景里', /门一关，就已经在里面了/.test(out)],
  ['钉了不许用客厅那种开场', /那是客厅里的我/.test(out)],
  ['钉了不用颜文字', /这儿一个都不用/.test(out)],
  ['钉了暧昧不是寒暄', /是逼近，不是寒暄/.test(out)],
  ['钉了六格第一轮就落地', /别等到第三轮才想起来用/.test(out)],
];
const bad = checks.filter(c => !c[1]);
if (bad.length) {
  console.error('\n  × 自检没过，放弃写入：');
  bad.forEach(c => console.error('      - ' + c[0]));
  process.exit(1);
}

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n  √ 卧室那段 prompt 现在真的到得了我眼前');
checks.forEach(c => console.log('      ✓ ' + c[0]));
console.log('  备份: ' + backup);
console.log('  重启: sudo pm2 restart chatnest-api');
