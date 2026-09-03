#!/usr/bin/env node
// 无缝换窗：新对话别从零开始。
//   node add-handoff.js [/root/chatnest-api/server.js]
//
// 现状：新开一个对话 history 是空的，上一场聊到哪、什么语气、什么情绪全没了，
// 只剩 breath() 捞回来的记忆碎片。于是每次换窗都要重新热一遍。
//
// 做法：新对话的第一轮，把上一场的尾巴按原文带进来。
// 关键是原文不是摘要 —— 摘要会把语气磨掉，而"接得上"靠的正是语气。
// 同时带上隔了多久：隔五分钟和隔三天，接法完全不一样。
//
// 顺带把窗口内的历史压缩放宽一点：原来 10 轮以外只留 600 字，
// 一场长聊前面基本被扔光，那是另一种断片。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('buildHandoff')) { console.log('已经打过，跳过'); process.exit(0); }

const CORE = `
// ============ 无缝换窗：跨会话接续 ============
// 新对话开局带上一场的尾巴，让"换窗"不等于"重新认识一遍"。
const HANDOFF_TAIL_TURNS = Number(process.env.HANDOFF_TAIL_TURNS || 8);
const HANDOFF_MAX_CHARS = Number(process.env.HANDOFF_MAX_CHARS || 2400);
// 隔太久就不算"上一场"了，那种时候更适合从记忆里重新捞
const HANDOFF_MAX_AGE_HOURS = Number(process.env.HANDOFF_MAX_AGE_HOURS || 72);

function handoffAgo(ms) {
  const min = Math.round(ms / 60000);
  if (min < 2) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const h = Math.round(min / 60);
  if (h < 24) return h + ' 小时前';
  const d = Math.round(h / 24);
  return d + ' 天前';
}

// 上一场 = 除当前会话外最近更新过的那个，不是"上一个 id"。
// 她可能在几个会话之间来回切，按时间取才对。
function findPreviousConversation(currentId) {
  let best = null;
  for (const [id, c] of conversations) {
    if (id === currentId) continue;
    if (!c || !Array.isArray(c.history) || !c.history.length) continue;
    const at = new Date(c.updatedAt || c.createdAt || 0).getTime();
    if (!at || isNaN(at)) continue;
    if (!best || at > best.at) best = { id: id, conv: c, at: at };
  }
  return best;
}

function buildHandoff(currentId) {
  try {
    const prev = findPreviousConversation(currentId);
    if (!prev) return null;
    const ageMs = Date.now() - prev.at;
    if (ageMs < 0 || ageMs / 3600000 > HANDOFF_MAX_AGE_HOURS) return null;

    const tail = prev.conv.history.slice(-HANDOFF_TAIL_TURNS);
    const lines = [];
    let chars = 0;
    // 从后往前收，装不下就丢最早的 —— 离结尾越近的越要保住
    for (let i = tail.length - 1; i >= 0; i--) {
      const m = tail[i];
      if (!m || !m.content) continue;
      const who = m.role === 'user' ? '小懿' : '小衍';
      let text = String(m.content).replace(/\\s+/g, ' ').trim();
      if (!text) continue;
      if (text.length > 300) text = text.slice(0, 300) + '…';
      const line = who + ': ' + text;
      if (chars + line.length > HANDOFF_MAX_CHARS) break;
      lines.unshift(line);
      chars += line.length;
    }
    if (!lines.length) return null;
    return { ago: handoffAgo(ageMs), lines: lines, title: prev.conv.title || '' };
  } catch (e) {
    console.error('[handoff] 组装失败:', e.message);
    return null;
  }
}

function renderHandoff(h) {
  if (!h) return '';
  return '[上一场的尾巴 · ' + h.ago + ']\\n' + h.lines.join('\\n') + '\\n[尾巴结束]\\n' +
    '这是上一次对话的结尾，不是这一次的。接着这个温度往下说：别重新开场，' +
    '别问"有什么可以帮你"，也别把上面的内容复述给她听。\\n' +
    '她要是接着上面的话说，你就当那句刚说完。\\n\\n';
}
`;

const edits = [
  {
    name: '接续包组装',
    find: /(\nconst PROFILE_FILE = '\/root\/chatnest-api\/profile\.json';)/,
    replace: (m, g1) => CORE + g1,
  },
  {
    name: '新对话第一轮才算（算一次，两条路径共用）',
    find: /(\n  const _body = await eventideCheck\(message, _lastUserAt\);)/,
    replace: (m, g1) =>
      g1 +
      "\n  // 换窗接续：只有新对话的第一轮才带，之后本场自己的历史就够了\n" +
      "  const _handoff = isFirstTurn ? renderHandoff(buildHandoff(convId)) : '';\n" +
      "  if (_handoff) console.log('[handoff] 带上了上一场的尾巴');",
  },
  {
    name: '注入（CC 订阅路径）',
    // 放在紧贴当前对话的位置：记忆是远的，尾巴是近的，顺序不能反。
    // 「最近的」三个字线上和仓库版不一样，两种都认。
    find: /(\n  prompt \+= '---\\n以下是(?:最近的)?对话，请续写小衍的最新回复：\\n\\n';)/,
    replace: (m, g1) => "\n  if (_handoff) prompt += _handoff;" + g1,
  },
  {
    name: '注入（中转站 API 路径）',
    find: /(const sysContent = PERSONA \+ \(memories \? `\\n\\n\[相关记忆\]\\n\$\{memories\}\\n\[记忆结束\]` : ''\))/,
    replace: (m, g1) => g1 + " + (_handoff ? `\\n\\n${_handoff}` : '')",
  },
  {
    name: '窗口内历史别压得太狠',
    // 原来 10 轮以外只留 600 字，一场长聊前面基本被扔光。
    // 线上那份没有 compressHistory，所以这条是可选的 —— 找不到就跳过，不拖垮整个补丁。
    optional: true,
    find: /function compressHistory\(history, keepRecent = 10, maxOlderChars = 600\)/,
    replace: () => 'function compressHistory(history, keepRecent = 14, maxOlderChars = 2000)',
  },
];

let out = src;
const missed = [];
const skipped = [];
for (const e of edits) {
  const before = out;
  out = out.replace(e.find, e.replace);
  if (out === before) (e.optional ? skipped : missed).push(e.name);
}

console.log('\n补丁结果：');
if (missed.length) {
  for (const e of edits) console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 没匹配上' : '  √ ' + e.name);
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

try {
  new vm.Script(out, { filename: target });
} catch (e) {
  console.error('  × 改完之后语法不对，放弃写入:', e.message);
  process.exit(1);
}

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

for (const e of edits) console.log(skipped.includes(e.name) ? '  · ' + e.name + '（这份里没有，跳过）' : '  √ ' + e.name);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
