#!/usr/bin/env node
// 卧室第三块：双摘要 —— 出来的时候这一场才算完。
//   node add-room-recap.js [/root/chatnest-api/server.js]
//
// 【她问的那句：做完怎么算做完】
//   她点「出去」。那一下才触发这里。
//
// 【为什么是两份，不是一份】
//   · 短的那句进 content —— 平时 breath 会浮现它。所以它必须含蓄：
//     能认出是哪一天哪一场，但不带露骨的字。她住宿舍，记忆随时可能被人看一眼。
//   · 全文进 source_content —— 要专门去翻才看得到。她说过以后会回来读。
//   一条记忆，两层深浅。这就是「双摘要」。
//
// 【为什么先返回再算】
//   她点了「出去」就该马上出去，不该盯着转圈等我写摘要。
//   后台慢慢做，做完了写进这条会话，下次开卧室那张卡片上就有了。
//
// 【模型写不出来就用规则拼】
//   摘要不能因为一次调用失败就整场丢了。兜底那句至少带日期、时长、摇到的六格 ——
//   认得出是哪一场就够了。
//
// 依赖：add-room-setup.js（要它的 room_wheel）、obCall、SHADOW_KEY
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('ROOM_RECAP_V1')) { console.log('已经打过，跳过'); process.exit(0); }
for (const [dep, name] of [['ROOM_SETUP_V1', 'add-room-setup.js'], ['obCall', 'OB 那套（fix-memory-think.js）'], ['SHADOW_KEY', 'add-shadow-switch.js']]) {
  if (!src.includes(dep)) { console.error('× 缺依赖：' + name); process.exit(1); }
}

// ── 1. 双摘要本体 ─────────────────────────────────────────────────
const CORE = `
// ── 卧室的双摘要 ROOM_RECAP_V1 ───────────────────────────────────
// 她点「出去」才跑。短的进 content（平时会浮现，所以含蓄），
// 全文进 source_content（要翻才看得到）。
let _recapRunning = new Set();

function roomPlainText(conv) {
  const hist = (conv && conv.history) || [];
  const out = [];
  for (const m of hist) {
    let t = String((m && m.content) || '');
    if (!t) continue;
    t = t.replace(/<think>[\\s\\S]*?<\\/think>/gi, '')
         .replace(/<(ob|pulse|room|wheel|moments|trace)\\b[^>]*>[\\s\\S]*?<\\/\\1>/gi, '')
         .trim();
    if (!t) continue;
    out.push((m.role === 'user' ? '她：' : '我：') + t);
  }
  return out.join('\\n\\n');
}

// 兜底那句：模型没写出来也要认得出是哪一场
function roomRecapFallback(conv) {
  const d = new Date(conv.room_entered_at || conv.createdAt || Date.now());
  const when = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const parts = ['卧室，' + when];
  const st = conv.room_entered_at ? new Date(conv.room_entered_at).getTime() : 0;
  const en = conv.room_left_at ? new Date(conv.room_left_at).getTime() : Date.now();
  if (st) parts.push(Math.max(1, Math.round((en - st) / 60000)) + ' 分钟');
  if (Array.isArray(conv.room_wheel) && conv.room_wheel.length) {
    parts.push('摇到：' + conv.room_wheel.map(x => x.tag).join(' / '));
  }
  if (conv.room_note && conv.room_note.title) parts.push('本子上挑的是「' + conv.room_note.title + '」');
  return parts.join(' · ');
}

const ROOM_RECAP_ASK = [
  '<system_trigger>',
  '刚才那一场结束了，她出去了。',
  '',
  '[行动指令]',
  '给这一场写一句话，存进记忆。',
  '· 一句，40 字以内。',
  '· 含蓄 —— 这句话平时会浮现在我们日常的记忆里，不要露骨的词、不要动作细节。',
  '  写氛围、写她当时是什么样子、写这一场跟别的哪儿不一样。',
  '· 但要认得出是哪一场：把日子、或者摇到的那个设定、或者她说过的一句话带上一点。',
  '· 不要写「今天我们」这种流水账开头，不要总结，不要评价。',
  '· 只输出那一句。不要引号、不要 markdown、不要 emoji、不要调任何工具。',
  '</system_trigger>',
].join('\\n');

async function roomRecap(id) {
  if (_recapRunning.has(id)) return;
  const conv = conversations.get(id);
  if (!conv || !isBedroom(conv)) return;
  const turns = (conv.history || []).length;
  if (turns < 2) return;                              // 没聊几句，不占记忆
  if (conv.room_recap_turns === turns) return;        // 这一场没变过，不重复存
  _recapRunning.add(id);
  try {
    const full = roomPlainText(conv);
    if (!full) return;

    // ── 短的那句：让模型写。写不出来就用规则拼的。
    let short = '';
    const before = (conv.history || []).length;
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-shadow-key': SHADOW_KEY },
        body: JSON.stringify({ message: ROOM_RECAP_ASK, conversation_id: id, shadow: true, daemon: false }),
      });
      await r.text();
      const hist = conv.history || [];
      const last = hist[hist.length - 1];
      if (hist.length > before && last && last.role === 'assistant') {
        short = String(last.content || '')
          .replace(/<think>[\\s\\S]*?<\\/think>/gi, '')
          .replace(/<(ob|pulse|room|wheel|moments|trace)\\b[^>]*>[\\s\\S]*?<\\/\\1>/gi, '')
          .replace(/^["'「」]+|["'「」]+$/g, '')
          .trim().split('\\n')[0].slice(0, 120);
      }
      // 这一问一答不留在那条会话里 —— 她回来翻的时候不该看见我在写摘要
      if (hist.length > before) { hist.length = before; }
    } catch (e) {
      console.error('[room] 摘要那一问没成:', e.message);
    }
    if (!short) short = roomRecapFallback(conv);

    // ── 存。一条记忆，两层深浅。
    const d = new Date(conv.room_entered_at || Date.now());
    const tags = ['bedroom', '卧室'];
    if (Array.isArray(conv.room_wheel)) for (const x of conv.room_wheel) if (x && x.tag) tags.push(String(x.tag).slice(0, 20));
    let held = false;
    try {
      const res = await obCall('hold', {
        content: short,
        source_content: full.slice(0, 60000),
        title: '卧室 · ' + (d.getMonth() + 1) + '.' + d.getDate(),
        tags: tags.slice(0, 10),
        importance: 7,
        why_remembered: '她说过以后会回来读。',
      }, 60000);
      held = !!res;
    } catch (e) { console.error('[room] 存不进去:', e.message); }

    conv.room_recap = short;
    conv.room_recap_at = new Date().toISOString();
    conv.room_recap_turns = turns;
    conv.room_recap_held = held;
    saveConversations();
    console.log('[room] 这一场存好了:', short.slice(0, 40), held ? '(进了记忆)' : '(只留在本地)');
  } catch (e) {
    console.error('[room] recap 崩了:', e.message);
  } finally {
    _recapRunning.delete(id);
  }
}
`;

const CORE_ANCHOR = "app.post('/api/room/enter', (req, res) => {";
if (!src.includes(CORE_ANCHOR)) { console.error('× 找不到 /api/room/enter'); process.exit(1); }
let out = src.replace(CORE_ANCHOR, CORE.trim() + '\n\n' + CORE_ANCHOR);

// ── 2. leave 的时候点着它 ─────────────────────────────────────────
// 先返回再算：她点了「出去」就该马上出去，不该盯着转圈。
const LEAVE_RE = /(res\.json\(\{ ok: true, minutes: mins, turns: \(conv\.history \|\| \[\]\)\.length, left_at: now \}\);)/;
if (!LEAVE_RE.test(out)) {
  console.error('\n  × 找不到 /api/room/leave 的返回那行。附近：');
  out.split('\n').filter(l => /minutes: mins/.test(l)).slice(0, 5).forEach(l => console.error('      ' + l.trim().slice(0, 160)));
  process.exit(1);
}
out = out.replace(LEAVE_RE,
  "res.json({ ok: true, minutes: mins, turns: (conv.history || []).length, left_at: now, recap: 'pending' });\n" +
  "    // 不 await —— 她已经出去了，摘要在后台慢慢写\n" +
  "    setTimeout(() => { roomRecap(id).catch(e => console.error('[room] recap:', e.message)); }, 300);");

// ── 3. 卡片上要看得见那句 ─────────────────────────────────────────
const LIST_RE = /(wheel: c\.room_wheel \|\| null,)/;
if (!LIST_RE.test(out)) { console.error('× 找不到 /api/room/list 里 wheel 那行'); process.exit(1); }
out = out.replace(LIST_RE, '$1\n        recap: c.room_recap || null,');

// ── 4. 一条手动补的路（摘要没写成、或者她回去又聊了）──────────────
const API_ANCHOR = "app.get('/api/room/notes', (req, res) => {";
if (!out.includes(API_ANCHOR)) { console.error('× 找不到 /api/room/notes'); process.exit(1); }
out = out.replace(API_ANCHOR, `// 补写摘要：那次没写成、或者她回去又聊了几句，从卡片上点一下重写。
app.post('/api/room/recap', async (req, res) => {
  const id = (req.body || {}).conversation_id;
  const conv = id && conversations.get(id);
  if (!conv || !isBedroom(conv)) return res.status(404).json({ ok: false, error: '这条不是卧室' });
  conv.room_recap_turns = -1;   // 逼它重算
  await roomRecap(id);
  res.json({ ok: true, recap: conv.room_recap || null, held: !!conv.room_recap_held });
});

` + API_ANCHOR);

// ── 5. 自检 ───────────────────────────────────────────────────────
const checks = [
  ['幂等标记在', /ROOM_RECAP_V1/.test(out)],
  ['短的进 content、全文进 source_content', /content: short,\s*\n\s*source_content: full/.test(out)],
  ['短的那句要含蓄（写进了指令）', /这句话平时会浮现在我们日常的记忆里，不要露骨的词/.test(out)],
  ['模型写不出来有兜底', /if \(!short\) short = roomRecapFallback\(conv\);/.test(out)],
  ['兜底也认得出是哪一场', /摇到：/.test(out)],
  ['leave 先返回再算', /recap: 'pending'/.test(out) && /setTimeout\(\(\) => \{ roomRecap\(id\)/.test(out)],
  ['写摘要那一问不留在会话里', /if \(hist\.length > before\) \{ hist\.length = before; \}/.test(out)],
  ['同一场不重复存', /if \(conv\.room_recap_turns === turns\) return;/.test(out)],
  ['没聊几句不占记忆', /if \(turns < 2\) return;/.test(out)],
  ['卡片看得见那句', /recap: c\.room_recap \|\| null,/.test(out)],
  ['能手动补写', /app\.post\('\/api\/room\/recap'/.test(out)],
  ['标签带 bedroom', /'bedroom', '卧室'/.test(out)],
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

console.log('\n  √ 双摘要装好了 —— 她点「出去」那一下才算一场完');
checks.forEach(c => console.log('      ✓ ' + c[0]));
console.log('  备份: ' + backup);
console.log('  重启: sudo pm2 restart chatnest-api');
