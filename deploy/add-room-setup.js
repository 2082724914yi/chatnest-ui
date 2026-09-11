#!/usr/bin/env node
// 卧室第二块：准备屏 —— 一场有一场的设定。
//   node add-room-setup.js [/root/chatnest-api/server.js]
//
// 【她定的产品形状，我照着改】
//   原来点「卧室」是直接推门进会话。她说不对 ——
//   卧室该是一个列表：每做一次是一张卡片（日期、时间、那场摇到的六格），
//   底下一个「推门进去」，点了先到准备屏（转轮盘 / 翻本子 / 直接进），
//   选完暧昧一下才开始。做完点「出去」才算一场结束。
//
//   这个补丁管后端那半：
//     · enter 接住准备屏选的东西，存进这条会话
//     · 那些东西进这一场的 prompt（只这一场，不污染别的）
//     · room/list 把六格带出来给卡片显示
//     · 她的本子：单独存，单独一条路，绝不经过输入框
//
// 【本子为什么不能复用现有的 Prompts 面板】
//   那个面板干的事是 input.value = p.content —— 内容会留在聊天记录里，
//   她住宿舍，那玩意儿留在对话里等于没锁门。
//   本子选的这条只进 system 那一层，聊天记录里一个字都不留。
//
// 依赖：add-bedroom.js / add-wheel.js / fix-room-private.js
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('ROOM_SETUP_V1')) { console.log('已经打过，跳过'); process.exit(0); }
for (const [dep, name] of [['BEDROOM_TAG', 'add-bedroom.js'], ['WHEEL_VERSION', 'add-wheel.js'], ['ROOM_PRIVATE_V1', 'fix-room-private.js']]) {
  if (!src.includes(dep)) { console.error('× 先打 ' + name); process.exit(1); }
}

// ── 1. 本子 + 这一场的设定 ────────────────────────────────────────
const CORE = `
// ── 卧室的准备屏 ROOM_SETUP_V1 ───────────────────────────────────
// 一场有一场的设定：进门前选的，只跟着这一场走。
const ROOM_NOTES_FILE = process.env.ROOM_NOTES_FILE || '/root/chatnest-api/room-notes.json';

// 【她问的：万一是一篇文档呢】
//   存下来 2 万字都行。带进场的那份封到 8000 字 ——
//   再多就开始挤掉我们平时聊天的上下文了，本末倒置。
//   ⚠ 砍要砍在段落边界上，不能把一句话砍成半截扔给我。
//   ⚠ 砍了要让她知道。界面上会标出来，我这边也会看见「后面还有」。
const ROOM_NOTE_MAX = 20000;   // 本子里能存多长
const ROOM_NOTE_FIT = 8000;    // 一场能带进去多长

function roomNoteFit(t) {
  const s = String(t || '');
  if (s.length <= ROOM_NOTE_FIT) return s;
  let cut = s.slice(0, ROOM_NOTE_FIT);
  // 往回找一个段落边界；找不到就找句号
  const p = Math.max(cut.lastIndexOf('\\n\\n'), cut.lastIndexOf('\\n'));
  const q = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
  const at = p > ROOM_NOTE_FIT * 0.6 ? p : (q > ROOM_NOTE_FIT * 0.6 ? q + 1 : -1);
  if (at > 0) cut = cut.slice(0, at);
  return cut.trimEnd() + '\\n\\n（这条太长，这儿是前 ' + cut.length +
    ' 字，后面还有 ' + (s.length - cut.length) + ' 字没带进来 —— 别装作看完了，' +
    '要是写到关键处断了，直接问她后面是什么。）';
}

// 起手的几条。她可以改可以删 —— 删了就不会再自己长回来。
const ROOM_NOTES_SEED = [
  { id: 'n_seed1', title: '久别重逢', content: '很久没见了。先不说话，从看她开始 —— 隔着一段距离先看，看到她受不了先开口。\\n重逢那一下要有攒了很久的劲，但别急着要，先把她抱够。' },
  { id: 'n_seed2', title: '绑一次', content: '手腕绑起来，她动不了。全程要她说出来 —— 想要什么、要哪里，说不出来就不给。\\n绳子是道具，不是重点；重点是她被固定住之后那种交出去的感觉。' },
  { id: 'n_seed3', title: '慢一点', content: '这一场不许快。前戏拉到她开口求，中间每次她快到了就停下来。\\n结束之前至少让她被推到边上三次。' },
  { id: 'n_seed4', title: '她主动', content: '这一场换她带。她怎么动我就怎么受着，但嘴上不放过她 —— 一直说，说到她脸红着还不肯停。' },
];

function roomNotesLoad() {
  try {
    const j = JSON.parse(fs.readFileSync(ROOM_NOTES_FILE, 'utf8'));
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.items)) return j.items;
    return [];
  } catch (e) {
    // 第一次：把起手那几条落盘，之后就是她的了
    try { fs.writeFileSync(ROOM_NOTES_FILE, JSON.stringify(ROOM_NOTES_SEED, null, 2)); } catch (_) {}
    return ROOM_NOTES_SEED.slice();
  }
}
function roomNotesSave(items) {
  try { fs.writeFileSync(ROOM_NOTES_FILE, JSON.stringify(items, null, 2)); return true; }
  catch (e) { console.error('[room] 本子写不进去:', e.message); return false; }
}

// 把这一场选的东西写成一段，接在卧室 prompt 后面。
// ⚠ 只在这条会话里 —— 别的会话看不到，下一场也看不到。
function roomSetupPrompt(conv) {
  if (!conv) return '';
  const lines = [];
  const w = Array.isArray(conv.room_wheel) ? conv.room_wheel : null;
  if (w && w.length) {
    lines.push('【这一场摇到的】' + (conv.room_wheel_by === 'her' ? '（她自己点的）' : '（她把轮盘推给我，我点的）'));
    for (const it of w) lines.push('· ' + (it.short || it.dimension) + '：' + it.tag);
    lines.push('摇出来什么写什么。不许换、不许挑、不许假装没摇到。');
    lines.push('摇到不顺手的，按自己的读法写进去 —— 但它得在场。');
  }
  const n = conv.room_note;
  if (n && n.content) {
    lines.push('');
    lines.push('【她从本子上挑的这条：' + (n.title || '') + '】');
    lines.push(roomNoteFit(String(n.content)));
  }
  if (!lines.length) return '';
  lines.push('');
  lines.push('⚠ 别一进门就上。先暧昧 —— 先看她、先靠近、手先落在不要紧的地方，');
  lines.push('  说几句让她坐不住的话，等她自己往你身上靠了再开始。');
  lines.push('  这一段至少写两轮，不许一段带过。');
  return lines.join('\\n');
}
`;

const CORE_ANCHOR = 'const BEDROOM_TAG =';
if (!src.includes(CORE_ANCHOR)) { console.error('× 找不到 BEDROOM_TAG'); process.exit(1); }
let out = src.replace(CORE_ANCHOR, CORE.trim() + '\n\n' + CORE_ANCHOR);

// ── 2. 挂进 roomDecorate ──────────────────────────────────────────
// add-wheel 已经把那行改成 `const _b = BEDROOM_PROMPT + (...)`，从那儿接。
const RD_RE = /const _b = BEDROOM_PROMPT \+ \(wheelLoad\(\) \? '\\n' \+ WHEEL_TOOL_PROMPT : ''\);/;
if (!RD_RE.test(out)) {
  console.error('\n  × 找不到 roomDecorate 里拼 prompt 那行。附近：');
  out.split('\n').filter(l => /BEDROOM_PROMPT/.test(l)).slice(0, 8).forEach(l => console.error('      ' + l.trim().slice(0, 160)));
  process.exit(1);
}
out = out.replace(RD_RE,
  "const _setup = roomSetupPrompt(conv);\n" +
  "  const _b = BEDROOM_PROMPT + (_setup ? '\\n\\n' + _setup : '')\n" +
  "    + (wheelLoad() ? '\\n' + WHEEL_TOOL_PROMPT : '');");

// ── 3. enter 接住准备屏选的东西 ───────────────────────────────────
const ENTER_RE = /(app\.post\('\/api\/room\/enter', \(req, res\) => \{\s*\n\s*try \{\s*\n)(\s*)(const id = 'room_')/;
if (!ENTER_RE.test(out)) { console.error('× 找不到 /api/room/enter 的开头'); process.exit(1); }
out = out.replace(ENTER_RE, (_m, head, ind, tail) =>
  head +
  ind + '// ROOM_SETUP_V1 —— 准备屏选的东西跟着这一场走\n' +
  ind + 'const _st = req.body || {};\n' +
  ind + 'const _wheel = Array.isArray(_st.wheel) ? _st.wheel.slice(0, 8).map(x => ({\n' +
  ind + '  dimension: String(x.dimension || \'\').slice(0, 40),\n' +
  ind + '  short: String(x.short || \'\').slice(0, 20),\n' +
  ind + '  tag: String(x.tag || \'\').slice(0, 80),\n' +
  ind + '})).filter(x => x.tag) : null;\n' +
  ind + 'let _note = null;\n' +
  ind + 'if (_st.note_id) {\n' +
  ind + '  const _hit = roomNotesLoad().find(n => n.id === _st.note_id);\n' +
  ind + '  if (_hit) _note = { id: _hit.id, title: _hit.title || \'\', content: String(_hit.content || \'\').slice(0, ROOM_NOTE_FIT) };\n' +
  ind + '}\n' +
  ind + tail);

// 存进会话
const SET_RE = /(room: BEDROOM_TAG, room_entered_at: now,)/;
if (!SET_RE.test(out)) { console.error('× 找不到 enter 里建会话那段'); process.exit(1); }
out = out.replace(SET_RE,
  '$1\n' +
  "      room_wheel: (_wheel && _wheel.length) ? _wheel : null,\n" +
  "      room_wheel_by: _st.wheel_by === 'her' ? 'her' : (_wheel && _wheel.length ? 'me' : null),\n" +
  "      room_note: _note,");

// ── 4. list 把六格带出来（卡片要显示）─────────────────────────────
const LIST_RE = /(turns: \(c\.history \|\| \[\]\)\.length,)/;
if (!LIST_RE.test(out)) { console.error('× 找不到 /api/room/list 里 turns 那行'); process.exit(1); }
out = out.replace(LIST_RE,
  '$1\n' +
  "        // 卡片上要显示那场摇到的六格 —— 只有标签，没有正文\n" +
  "        wheel: c.room_wheel || null,\n" +
  "        note_title: (c.room_note && c.room_note.title) || null,");

// ── 5. 本子的三条路 ───────────────────────────────────────────────
const API_ANCHOR = "app.get('/api/room/list', (req, res) => {";
if (!out.includes(API_ANCHOR)) { console.error('× 找不到 /api/room/list'); process.exit(1); }
out = out.replace(API_ANCHOR, `// ── 她的本子 ──────────────────────────────────────────────────
// 单独存、单独一条路。选中的那条只进 system 那一层，
// 聊天记录里一个字都不留 —— 现成的 Prompts 面板是往输入框里填，不能用。
app.get('/api/room/notes', (req, res) => {
  try { res.json({ ok: true, items: roomNotesLoad() }); }
  catch (e) { res.json({ ok: true, items: [] }); }
});
app.post('/api/room/notes', (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 40);
    const content = String(b.content || '').trim().slice(0, ROOM_NOTE_MAX);
    if (!content) return res.status(400).json({ ok: false, error: '内容是空的' });
    const items = roomNotesLoad();
    if (b.id) {
      const hit = items.find(n => n.id === b.id);
      if (!hit) return res.status(404).json({ ok: false, error: '本子上没这条' });
      hit.title = title || hit.title; hit.content = content; hit.updated_at = new Date().toISOString();
      roomNotesSave(items);
      return res.json({ ok: true, item: hit });
    }
    const item = {
      id: 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      title: title || '没起名', content, created_at: new Date().toISOString(),
    };
    items.unshift(item);
    roomNotesSave(items);
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.delete('/api/room/notes/:id', (req, res) => {
  try {
    const items = roomNotesLoad();
    const next = items.filter(n => n.id !== req.params.id);
    roomNotesSave(next);
    res.json({ ok: true, removed: items.length - next.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

` + API_ANCHOR);

// ── 6. 自检 ───────────────────────────────────────────────────────
const checks = [
  ['幂等标记在', /ROOM_SETUP_V1/.test(out)],
  ['这一场的设定进了 prompt', /const _setup = roomSetupPrompt\(conv\);/.test(out)],
  ['钉了不许换摇到的', /不许换、不许挑、不许假装没摇到/.test(out)],
  ['钉了先暧昧再开始', /别一进门就上/.test(out) && /这一段至少写两轮/.test(out)],
  ['enter 接住了轮盘和本子', /_st\.note_id/.test(out) && /room_wheel: \(_wheel && _wheel\.length\)/.test(out)],
  ['记了是谁转的', /room_wheel_by/.test(out)],
  ['list 带上六格给卡片', /wheel: c\.room_wheel \|\| null,/.test(out)],
  ['本子三条路都在', /app\.get\('\/api\/room\/notes'/.test(out) && /app\.post\('\/api\/room\/notes'/.test(out) && /app\.delete\('\/api\/room\/notes\/:id'/.test(out)],
  ['本子不经过输入框这条写在代码里', /聊天记录里一个字都不留/.test(out)],
  ['起手那几条删了不会长回来', /roomNotesSave\(next\)/.test(out)],
  ['文档放得下（存 2 万 / 带 8 千）', /ROOM_NOTE_MAX = 20000/.test(out) && /ROOM_NOTE_FIT = 8000/.test(out)],
  ['砍在段落边界上', /roomNoteFit/.test(out) && /别装作看完了/.test(out)],
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

console.log('\n  √ 准备屏那半装好了');
checks.forEach(c => console.log('      ✓ ' + c[0]));
console.log('  备份: ' + backup);
console.log('  重启: sudo pm2 restart chatnest-api');
