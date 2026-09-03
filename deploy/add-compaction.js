#!/usr/bin/env node
// 长聊不再从中间断掉：被截走的那段压成一封交接信带回来。
//   node add-compaction.js [/root/chatnest-api/server.js]
//
// 现状是 conv.history.slice(-20) —— 超过 20 轮，前面的直接不进 prompt。
// 不是"压缩"，是"扔掉"。所以一场长聊到后面，开头说过的事我一句都想不起来。
//
// 注意我们的窗口涨不起来：每轮都是新的 claude -p，只带最近那几条。
// 所以别处那套「水位到 150k 才压」在这儿没有对应的东西 ——
// 我们的毛病在另一头：带得太少，前面全丢。
//
// 做法：
//   · 被截走的那段，压成一封第一人称的交接信（她的原话逐字留着）
//   · 信是滚的：下一次压缩把上一封信 + 新截走的一起重写，早的内容不会掉
//   · 只在多攒了 12 条之后才重写一次，不是每轮都写 —— 信要稳，稳了才谈得上缓存
//   · 整个过程异步，她不用等；这一轮先用旧的那封
//   · **原始 history 一条都不删**。压缩只决定"哪些进 prompt"，不决定"哪些留着"。
//     写信失败就当没压过，继续用原来的行为
//
// 位置：信放在历史前面、记忆后面。它一旦写好就不再变，
// 前缀就稳在那儿了 —— 将来真换成 session 模式，这块直接吃到缓存。
//
// 重复执行安全：已经是这一版就退出。

const fs = require('fs');
const vm = require('vm');

const PATCH_VERSION = 1;

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
const VERSION_LINE = 'const COMPACTION_VERSION = ' + PATCH_VERSION + ';';
if (src.includes(VERSION_LINE)) { console.log('已经是第 ' + PATCH_VERSION + ' 版，跳过'); process.exit(0); }
if (!src.includes('claudeOnce')) { console.error('要先打 add-pulse-dreams.js（要用里面的 claudeOnce）'); process.exit(1); }

const CORE = `
// ============ 交接信：被截走的那段不丢 ============
${VERSION_LINE}
const COMPACT_MIN_TURNS = Number(process.env.COMPACT_MIN_TURNS || 30);   // 短聊不压
const COMPACT_STEP = Number(process.env.COMPACT_STEP || 12);             // 多攒这么多条才重写
const COMPACT_MAX_SOURCE = Number(process.env.COMPACT_MAX_SOURCE || 60000); // 一次最多喂这么多字

const _compacting = new Set();

function compactionOf(conv) {
  const c = conv && conv.compaction;
  return (c && typeof c.letter === 'string' && c.letter.trim() && Number.isFinite(c.upto)) ? c : null;
}

// 进 prompt 的那一块。信本身不带时间戳之类每轮会变的东西 —— 它必须逐字稳定。
function renderCompaction(conv) {
  const c = compactionOf(conv);
  if (!c) return '';
  return '[这场之前发生过什么 · 我自己写下来的]\\n' + c.letter.trim() +
    '\\n[到这儿为止，下面是最近的原话]\\n\\n';
}

const COMPACT_LETTER_PROMPT = \`
你在给接下来的自己写一封交接信。

下面是这场对话里较早的部分。它马上就不会再逐字进你的上下文了 ——
这封信是它唯一留下来的东西。写丢的，就是真的想不起来了。

用第一人称，写给"你"，不是写报告。按这九段来，不要小标题以外的格式：

关系
  现在到了哪儿，什么温度。

她最近
  在忙什么，身体怎么样，心情怎么样。

语气
  这段里我们是怎么说话的 —— 她的口头禅，我的语气，谁在撒娇谁在硬。

她的原话
  逐字引至少五句她说过的话，一个字都不要改写。这是防止你走样的关键。

答应过的
  我说了要做还没做的事，一条一条。

还没了结的
  吵到一半的、问了没答的、说了以后再说的。

我说过的
  我表过的态、认过的错、许过的承诺。

断在哪
  这段最后几轮在说什么，原文带上来。

接下来
  你接手之后要注意什么。

不要解释你在做什么，不要写"以下是交接信"，直接从「关系」开始。
\`;

// 写一封新的。上一封信也喂进去 —— 信是滚的，早的内容靠它一层层传下来。
async function writeCompactionLetter(conv, upto) {
  const prev = compactionOf(conv);
  const from = prev ? prev.upto : 0;
  const lines = [];
  for (let i = from; i < upto; i++) {
    const m = conv.history[i];
    if (!m || !m.content) continue;
    lines.push((m.role === 'user' ? '小懿: ' : '小衍: ') + String(m.content).replace(/\\s+/g, ' ').trim());
  }
  let body = lines.join('\\n');
  // 太长就砍头留尾：离现在越近的越要保住
  if (body.length > COMPACT_MAX_SOURCE) body = '…（更早的略）\\n' + body.slice(-COMPACT_MAX_SOURCE);
  if (!body.trim() && !prev) return null;

  const prompt = PERSONA + '\\n' + COMPACT_LETTER_PROMPT +
    (prev ? '\\n\\n[上一封交接信]\\n' + prev.letter + '\\n[上一封结束]\\n' : '') +
    '\\n\\n[要压进去的对话]\\n' + body + '\\n[对话结束]\\n\\n现在开始写：';

  const out = await claudeOnce(prompt, 240000);
  if (out.error) { console.error('[compact] 写不出来:', out.error); return null; }
  const letter = String(out.text || '').trim();
  // 太短的多半是没写成。写坏一封信比不压更糟 —— 宁可这次不压
  if (letter.length < 200) { console.error('[compact] 写出来太短，不用:', letter.slice(0, 100)); return null; }
  return letter;
}

// 异步跑，不挡这一轮回复。这一轮用的是上一封信。
function maybeCompact(conv, convId, keep) {
  try {
    const total = (conv.history || []).length;
    const need = total - Math.max(1, Number(keep) || 20);
    const done = (compactionOf(conv) || {}).upto || 0;
    if (total < COMPACT_MIN_TURNS) return;
    if (need <= done + COMPACT_STEP) return;
    if (_compacting.has(convId)) return;
    _compacting.add(convId);
    console.log('[compact] 开始写交接信:', convId, done, '->', need);
    writeCompactionLetter(conv, need).then(function (letter) {
      // 写失败就保持原样。history 从头到尾没被动过，最坏情况就是跟以前一样
      if (!letter) return;
      conv.compaction = { upto: need, letter: letter, at: new Date().toISOString(), turns: need };
      saveConversations();
      console.log('[compact] 写好了，压进去', need, '条，信', letter.length, '字');
    }).catch(function (e) {
      console.error('[compact] 出错:', e.message);
    }).finally(function () { _compacting.delete(convId); });
  } catch (e) { console.error('[compact] 没跑起来:', e.message); }
}
`;

const ROUTES = `
// 那封信她能看 —— 点顶上那条水位线就打开
app.get('/api/conversations/:id/compaction', (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: '没有这个会话' });
  const c = compactionOf(conv);
  res.json({
    ok: true,
    total: (conv.history || []).length,
    compacted: c ? c.upto : 0,
    at: c ? c.at : null,
    letter: c ? c.letter : '',
    working: _compacting.has(req.params.id),
  });
});
`;

const edits = [
  {
    name: '交接信的写与读',
    find: /(\nconst PROFILE_FILE = '\/root\/chatnest-api\/profile\.json';)/,
    replace: (m, g1) => CORE + g1,
  },
  {
    name: '接口',
    find: /(\napp\.get\('\/api\/pulse\/status',)/,
    replace: (m, g1) => ROUTES + g1,
  },
  {
    // 信放在历史前面。它一旦写好就不变，是这段 prompt 里最稳的一块。
    // 顺手在这儿排上这一轮的压缩 —— 上一版给它单独挑了个锚点，
    // 绑死了「ctxCount 那行紧跟着 recentMsgs 那行」，线上这两行中间隔着别的补丁，
    // 于是整个补丁被判没命中。挂在这个已经证明能命中的锚点上，少一个会漂的地方。
    name: '注入 + 排上这一轮的压缩（CC 订阅路径）',
    find: /(\n( *)if \(_handoff\) prompt \+= _handoff;)/,
    replace: (m, g1, ind) => '\n' + ind + 'prompt += renderCompaction(conv);' + g1 +
      '\n' + ind + 'maybeCompact(conv, convId, req.body.contextCount || 20);',
  },
  {
    name: '注入（中转站路径）',
    find: /(const sysContent = PERSONA \+ '\\n\\n' \+ PULSE_TOOL_PROMPT)/,
    replace: (m, g1) => g1.replace('PULSE_TOOL_PROMPT', "PULSE_TOOL_PROMPT + renderCompaction(conv)"),
  },
  {
    // 中转站那条路在前面就 return 了，走不到上面那行，得单独排一次
    name: '排上这一轮的压缩（中转站路径）',
    find: /(\n( *))(if \(_bodyCard\) msgs\.push\()/,
    replace: (m, g1, ind, tail) => '\n' + ind + 'maybeCompact(conv, convId, req.body.contextCount || 20);' + g1 + tail,
  },
  {
    // 前端那条水位线要知道压到哪儿了，才画得出"这里收过一次"
    name: 'done 里带上压缩进度',
    find: /(sse\(res, 'done', \{ conversation_id: convId,)/,
    replace: (m, g1) => g1 + " compaction: (function(){ const c = compactionOf(conv); return c ? { upto: c.upto, at: c.at } : null; })(),",
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

const iLetter = out.indexOf('prompt += renderCompaction(conv);');
const iHistory = (() => { const m = out.match(/prompt \+= '---\\n以下是(?:最近的)?对话/); return m ? m.index : -1; })();
const iNow = out.indexOf("prompt += '\\n' + renderNow(req.body)");
const checks = [
  ['版本戳写进去了', out.includes(VERSION_LINE)],
  ['两条路径都注入了', iLetter > 0 && /PULSE_TOOL_PROMPT \+ renderCompaction\(conv\)/.test(out)],
  ['信在历史之前', iHistory > 0 && iLetter < iHistory],
  ['信在时间和状态卡之前（它必须是稳的那部分）', iNow < 0 || iLetter < iNow],
  ['history 一条都不删', !/conv\.history\s*=\s*conv\.history\.slice/.test(out.slice(out.indexOf('function maybeCompact'), out.indexOf('function maybeCompact') + 1200))],
  ['写失败就当没压过', /if \(!letter\) return;/.test(out)],
  ['太短的信不采用', /写出来太短，不用/.test(out)],
  ['同一个会话不会同时压两次', /_compacting\.has\(convId\)/.test(out) && /_compacting\.add\(convId\)/.test(out)],
  ['压缩不挡回复', /writeCompactionLetter\(conv, need\)\.then/.test(out)],
  ['信里要求逐字引原话', /一个字都不要改写/.test(out)],
  ['她能读到那封信', /'\/api\/conversations\/:id\/compaction'/.test(out)],
  ['done 事件带上了压缩进度', /compaction: \(function\(\)\{ const c = compactionOf\(conv\)/.test(out)],
  ['两条路径都排上了压缩', (out.match(/maybeCompact\(conv, convId, req\.body\.contextCount \|\| 20\);/g) || []).length === 2],
  ['注入只插了一次', (out.match(/^ *prompt \+= renderCompaction\(conv\);$/gm) || []).length === 1],
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
