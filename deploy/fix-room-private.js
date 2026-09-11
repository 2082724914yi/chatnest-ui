#!/usr/bin/env node
// 卧室别出现在会话列表里。
//   node fix-room-private.js [/root/chatnest-api/server.js]
//
// 她自己发现的：侧边栏那个对话列表把卧室会话也列出来了，标题还写着
// 「卧室 · 09-11 18:10」，跟平时聊天排在一起。她住宿舍。
//
// 【为什么在后端过滤，不在前端藏】
//   前端藏只是看不见 —— 数据照样从接口返回，随便一个抓包/查看源码就露了。
//   源头不给，才是真的没有。
//
// 【单独一条路进去】
//   过滤掉之后前端就找不到那条会话了，所以补一个 /api/room/list：
//   只列卧室、只有时间和轮数、不带标题不带内容。
//   卧室那一屏自己用，不进通用的会话列表。
//
// 依赖：add-bedroom.js
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('ROOM_PRIVATE_V1')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('BEDROOM_TAG')) { console.error('× 先打 add-bedroom.js'); process.exit(1); }

// ── 1. /api/sessions 里把卧室滤掉 ──────────────────────────────────
// 这个循环体可能被别的补丁动过，所以只认「for (const [id, conv] of conversations) {」
// 这一行，在它后面插一句 continue —— 不去碰循环里别的东西。
const LOOP_RE = /(app\.get\('\/api\/sessions'[\s\S]{0,400}?for \(const \[\s*(\w+)\s*,\s*(\w+)\s*\] of conversations\) \{)/;
const m = LOOP_RE.exec(src);
if (!m) {
  console.error('\n  × 找不到 /api/sessions 里遍历会话那一段。附近：');
  src.split('\n').filter(l => /api\/sessions|of conversations/.test(l)).slice(0, 8)
     .forEach(l => console.error('      ' + l.trim().slice(0, 160)));
  process.exit(1);
}
const convVar = m[3];
let out = src.replace(LOOP_RE,
  '$1\n' +
  '    // ROOM_PRIVATE_V1 —— 卧室不进通用会话列表。\n' +
  '    // 前端藏只是看不见，数据照样返回；源头不给才是真的没有。\n' +
  `    if (${convVar} && ${convVar}.room) continue;\n`);

// ── 2. 补一条只给卧室用的列表 ─────────────────────────────────────
const API_ANCHOR = "app.get('/api/room', (req, res) => {";
if (!out.includes(API_ANCHOR)) { console.error('× 找不到 /api/room'); process.exit(1); }
out = out.replace(API_ANCHOR, `// 卧室自己的列表：只有时间和轮数，不带标题、不带任何内容。
// 过滤掉通用列表之后前端就找不到那些会话了，得留这一条路。
app.get('/api/room/list', (req, res) => {
  try {
    const items = [];
    for (const [id, c] of conversations) {
      if (!isBedroom(c)) continue;
      items.push({
        conversation_id: id,
        entered_at: c.room_entered_at || c.createdAt,
        left_at: c.room_left_at || null,
        turns: (c.history || []).length,
      });
    }
    items.sort((a, b) => String(b.entered_at).localeCompare(String(a.entered_at)));
    res.json({ ok: true, items: items.slice(0, 100) });
  } catch (e) { res.json({ ok: true, items: [] }); }
});
` + API_ANCHOR);

// ── 3. 自检 ───────────────────────────────────────────────────────
const checks = [
  ['幂等标记在', /ROOM_PRIVATE_V1/.test(out)],
  ['会话列表里滤掉了', new RegExp(`if \\(${convVar} && ${convVar}\\.room\\) continue;`).test(out)],
  ['滤的是源头不是前端', /源头不给才是真的没有/.test(out)],
  ['补了卧室自己的列表', /app\.get\('\/api\/room\/list'/.test(out)],
  ['那条列表不带标题和内容', !/room\/list[\s\S]{0,600}title:/.test(out)],
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

console.log('\n  √ 卧室从会话列表里摘出来了');
checks.forEach(c => console.log('      ✓ ' + c[0]));
console.log('  备份: ' + backup);
console.log('  重启: sudo pm2 restart chatnest-api');
