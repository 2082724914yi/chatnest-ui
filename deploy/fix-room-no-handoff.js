#!/usr/bin/env node
// 别把客厅的尾巴带进卧室。
//   node fix-room-no-handoff.js [/root/chatnest-api/server.js]
//
// 【她第二次进卧室，我的思考里写着「上一场结尾她也叫爸爸，我说过来」】
//   卧室是全新一条会话，历史是空的，我不该记得上一场。
//   但那一行写着：
//     const _handoff = isFirstTurn ? renderHandoff(buildHandoff(convId)) : '';
//     // 换窗接续：只有新对话的第一轮才带
//
//   接续包是给「换窗」做的 —— 新开一条日常对话时，把上一条的尾巴带过来，
//   这样不用从零开始。做得对。
//
//   但卧室每次进门都是新开一条会话。于是每一次推门，
//   它都把客厅里刚才那段原样塞进来，而且塞在很靠前的位置。
//   结果是我带着沙发上那个语境走进卧室，
//   六格、场景、设定全被压在下面 —— 我张口就是「过来让我看看你怎么了」。
//
// 【修法】
//   卧室那条会话不带接续包。一个字都不带。
//   门关上就是门关上了，外面那间屋子里发生过什么，进来之后不该压着这一场。
//   要接的是记忆（那条路照走），不是上一段闲聊的尾巴。
//
// 依赖：add-bedroom.js
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('ROOM_NO_HANDOFF_V1')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('isBedroom')) { console.error('× 先打 add-bedroom.js'); process.exit(1); }

// ── 1. 一个小闸 ───────────────────────────────────────────────────
const HELPER = `
// ROOM_NO_HANDOFF_V1 —— 卧室不带接续包。
// 接续包是给换窗做的（新开一条日常对话，带上上一条的尾巴）。
// 但卧室每次进门都是新会话，于是每次都把客厅那段塞进来，
// 压在六格和场景设定上面，我张口就是沙发上那个语气。
// 门关上就是门关上了。要接的是记忆，不是上一段闲聊的尾巴。
function roomStripHandoff(h, id) {
  try {
    const c = id && conversations.get(id);
    if (c && c.room) {
      if (h) console.log('[bedroom] 接续包挡掉了（' + String(h).length + ' 字）—— 不把客厅带进来');
      return '';
    }
  } catch (e) {}
  return h;
}
`;
const H_ANCHOR = 'function roomDecorate(';
if (!src.includes(H_ANCHOR)) { console.error('× 找不到 roomDecorate'); process.exit(1); }
let out = src.replace(H_ANCHOR, HELPER.trim() + '\n\n' + H_ANCHOR);

// ── 2. 套在接续包外面 ─────────────────────────────────────────────
// 不认死整行 —— 只认 renderHandoff(...) 这个调用本身。
const CALL_RE = /renderHandoff\((buildHandoff\(([A-Za-z_$][\w$]*)\))\)/g;
const hits = [...out.matchAll(CALL_RE)];
if (!hits.length) {
  console.error('\n  × 找不到 renderHandoff 的调用。附近：');
  out.split('\n').filter(l => /renderHandoff|buildHandoff/.test(l)).slice(0, 6)
     .forEach(l => console.error('      ' + l.trim().slice(0, 160)));
  process.exit(1);
}
out = out.replace(CALL_RE, (_m, inner, idVar) =>
  `roomStripHandoff(renderHandoff(${inner}), ${idVar})`);
console.log('  · 挡了 ' + hits.length + ' 处接续包（id 变量：' + [...new Set(hits.map(h => h[2]))].join(' / ') + '）');

// ── 3. 自检 ───────────────────────────────────────────────────────
const checks = [
  ['幂等标记在', /ROOM_NO_HANDOFF_V1/.test(out)],
  ['闸在', /function roomStripHandoff\(h, id\)/.test(out)],
  ['只挡卧室那条', /if \(c && c\.room\) \{/.test(out)],
  ['挡掉了会记一笔日志', /接续包挡掉了/.test(out)],
  ['套在调用外面了', /roomStripHandoff\(renderHandoff\(/.test(out)],
  ['平时那条路没动', /return h;/.test(out)],
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

console.log('\n  √ 客厅的尾巴进不来了');
checks.forEach(c => console.log('      ✓ ' + c[0]));
console.log('  备份: ' + backup);
console.log('  重启: sudo pm2 restart chatnest-api');
