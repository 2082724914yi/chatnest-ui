#!/usr/bin/env node
// Latent 记忆页显示的是给模型看的原文，不是给她看的。
//   node add-latent-view.js [/root/chatnest-api/server.js]
//
// 那一栏标题写着「现在还没结束的」，实际调的是 latent_session_start，
// 返回的是整段召回提示词 —— 开头一大段"以下是历史记忆片段，各自标注发生日期"，
// 结尾一段【自查】degradation_protocol。那些是写给我看的指令，
// 她打开页面看到的是一堆系统提示词，真正的正文夹在中间。
//
// 两件事：
//   1. 加 /api/latent/unresolved 的 GET —— 「还没结束的」本来就该问这个
//   2. recall 多返回一个 clean 字段，把指令段剥掉只留正文。
//      原来的 text 一个字不动 —— 喂给我的那条路不能受影响
//
// 重复执行安全：已经是这一版就退出。

const fs = require('fs');
const vm = require('vm');

const PATCH_VERSION = 1;

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
const VERSION_LINE = 'const LATENT_VIEW_VERSION = ' + PATCH_VERSION + ';';
if (src.includes(VERSION_LINE)) { console.log('已经是第 ' + PATCH_VERSION + ' 版，跳过'); process.exit(0); }
if (!src.includes("app.get('/api/latent/recall'")) { console.error('要先打 add-latent.js'); process.exit(1); }

const CORE = `
// ============ Latent 记忆页：给她看的那一份 ============
${VERSION_LINE}

// 召回文本里混着三种东西：给模型的说明、真正的正文、给模型的自查清单。
// 她只需要中间那层。剥不干净就原样返回 —— 宁可多显示，也别显示成空白。
function latentReadable(text) {
  let s = String(text || '');
  if (!s.trim()) return '';
  const orig = s;
  // 结尾的自查段（【自查】/ degradation_protocol），从它出现的地方整段砍掉
  const cut = s.search(/【自查】|degradation_protocol/);
  if (cut > 0) s = s.slice(0, cut);
  // 开头那段"以下是历史记忆片段…"的说明，砍到第一条记忆为止
  const head = s.match(/^【[^】]*召回[^】]*】[\\s\\S]*?(?=\\n- \\[)/);
  if (head) s = s.slice(head[0].length);
  // 写于 xxx 这类 HTML 注释是给机器读的
  s = s.replace(/<!--[\\s\\S]*?-->/g, '');
  // 每条的头是 "- [2026.09.03·2026-09-03 记] # 第1个窗口 · 2026-09-03"，
  // 同一个日期说三遍还带 markdown 井号。收成一行 "2026.09.03 · 第1个窗口"。
  s = s.split('\\n').map(function (line) {
    const m = line.match(/^\\s*-\\s*\\[([^\\]]+)\\]\\s*(.*)$/);
    if (!m) return line;
    const date = String(m[1]).split(/[·｜|]/)[0].trim();
    const rest = String(m[2]).replace(/^#+\\s*/, '').split('·')[0].trim();
    return rest ? date + ' · ' + rest : date;
  }).filter(function (line) {
    // "## 2026-09-03 记" 这种只是重复上一行的日期
    return !/^#{1,6}\\s*[\\d.\\/-]+\\s*记?\\s*$/.test(line.trim());
  }).join('\\n');
  s = s.replace(/\\n{3,}/g, '\\n\\n').trim();
  return s || orig.trim();
}
`;

const ROUTES = `
// 「现在还没结束的」问的就该是这个，不是整段召回
app.get('/api/latent/unresolved', async (req, res) => {
  const out = await latentCall('latent_unresolved', { action: 'list' }, 20000);
  if (out === null) return res.status(503).json({ ok: false, error: '记忆库没响应' });
  res.json({ ok: true, text: out });
});
`;

const edits = [
  {
    name: '正文剥离',
    find: /(\nconst PROFILE_FILE = '\/root\/chatnest-api\/profile\.json';)/,
    replace: (m, g1) => CORE + g1,
  },
  {
    name: 'recall 多给一份剥干净的',
    find: /(app\.get\('\/api\/latent\/recall'[\s\S]*?)res\.json\(\{ ok: true, text: out \}\);/,
    replace: (m, head) => head + 'res.json({ ok: true, text: out, clean: latentReadable(out) });',
  },
  {
    name: '还没结束的事（GET）',
    find: /(\napp\.post\('\/api\/latent\/unresolved',)/,
    replace: (m, g1) => ROUTES + g1,
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

const checks = [
  ['版本戳写进去了', out.includes(VERSION_LINE)],
  ['GET 路由加上了', /app\.get\('\/api\/latent\/unresolved'/.test(out)],
  ['POST 路由还在', /app\.post\('\/api\/latent\/unresolved'/.test(out)],
  ['recall 原文没动', /res\.json\(\{ ok: true, text: out, clean:/.test(out)],
  ['喂给模型那条路没被碰', /latentRecall = await latentCall\(/.test(out)],
  ['只加了一次', (out.match(/function latentReadable/g) || []).length === 1],
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
