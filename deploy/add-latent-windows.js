#!/usr/bin/env node
// Latent 全文页：一天一条，点得进去，改得动。
//   node add-latent-windows.js [/root/chatnest-api/server.js]
//
// 现在前端那页把 MCP 返回的一整段原样塞进一个块里，所以搜出来是一大坨、分不清；
// 「最近留下的」调的是 latent_session_start，本来就只给最近一次召回。
// 语料本身是一窗一个 md（window_NN_YYYY-MM-DD.md），信息都在，只是没有口子读。
//
// 加三个口子（都只碰语料目录里的 .md，不经过 MCP）：
//   GET  /api/latent/windows        列出全部窗口：日期、窗口号、标题、字数、开头一段
//   GET  /api/latent/window?file=   读一整篇
//   POST /api/latent/window         改一篇（{file, text}）
//
// 改完不用重启：上游 server 会按语料目录的签名变化自己重建索引
// （mcp_server.py 的 _corpus_signature → _reload_from_disk）。
//
// 路径安全：file 一律取 basename 再拼进 timeline 目录，且必须以 .md 结尾 ——
// 不接受任何带目录的写法，`../` 进不来。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
const VERSION_LINE = '// LATENT_WINDOWS_VERSION = 1';
if (src.includes('LATENT_WINDOWS_VERSION')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes("app.get('/api/latent/search'")) {
  console.error('要先打 add-latent.js'); process.exit(1);
}

const CORE = `
${VERSION_LINE}
// ---- Latent 语料直读：一窗一个 md，前端要按天列、点进去看、改 ----
// 走文件不走 MCP：MCP 那几个工具是给模型检索用的，返回的是拼好的召回文本，
// 拆不出「哪条是哪天」。这里要的是原始文件本身。
const LATENT_CORPUS_DIR = process.env.LATENT_CORPUS || '/root/chatnest-api/latent-corpus';
const LATENT_TIMELINE_DIR = LATENT_CORPUS_DIR.replace(/\\/+$/, '') + '/timeline';

// 只认 timeline 目录下的 .md。basename 已经把目录部分削掉了，'../' 进不来。
function latentDocPath(name) {
  const b = String(name || '').split('/').pop().split('\\\\').pop();
  if (!b || !b.endsWith('.md') || b.startsWith('.')) return null;
  return LATENT_TIMELINE_DIR + '/' + b;
}

// 日期优先看文件名（window_63_2026-07-18.md），文件名里没有就看开头几行。
// 这跟上游解析语料的优先级是同一个口径，免得前端显示的日期跟它检索用的日期对不上。
function latentDocMeta(name, text) {
  const head = String(text || '').slice(0, 400);
  let date = (name.match(/(20\\d{2})[-._]?(\\d{2})[-._]?(\\d{2})/) || []).slice(1, 4).join('-');
  if (!date || date.length !== 10) {
    const m = head.match(/(20\\d{2})[-./年](\\d{1,2})[-./月](\\d{1,2})/);
    date = m ? m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0') : '';
  }
  const win = (name.match(/window[_-]?(\\d+)/i) || [])[1] || '';
  // 标题取第一个 # 开头的行；没有就用文件名
  const titleLine = (String(text || '').split('\\n').find(l => /^#{1,3}\\s+\\S/.test(l)) || '').replace(/^#+\\s*/, '').trim();
  const body = String(text || '').replace(/^#.*$/gm, '').replace(/<!--[\\s\\S]*?-->/g, '').trim();
  return {
    file: name,
    date: date || '',
    window: win ? Number(win) : null,
    title: titleLine || name.replace(/\\.md$/, ''),
    chars: String(text || '').length,
    preview: body.replace(/\\s+/g, ' ').slice(0, 90),
  };
}
`;

const ROUTES = `
// 一天一条的列表。151 篇每篇只回 90 字开头，整包几十 KB，一次给完不分页。
app.get('/api/latent/windows', async (req, res) => {
  try {
    if (!fs.existsSync(LATENT_TIMELINE_DIR)) {
      return res.json({ ok: true, dir: LATENT_TIMELINE_DIR, windows: [], note: '语料目录还不存在' });
    }
    const names = fs.readdirSync(LATENT_TIMELINE_DIR).filter(n => n.endsWith('.md'));
    const list = [];
    for (const n of names) {
      try {
        const t = fs.readFileSync(LATENT_TIMELINE_DIR + '/' + n, 'utf8');
        list.push(latentDocMeta(n, t));
      } catch (e) { /* 单篇读不了不该让整页空掉 */ }
    }
    // 日期新的在前；同一天按窗口号倒序；没日期的沉到最后
    list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || ((b.window || 0) - (a.window || 0)));
    res.json({ ok: true, dir: LATENT_TIMELINE_DIR, count: list.length, windows: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/latent/window', async (req, res) => {
  const p = latentDocPath(req.query && req.query.file);
  if (!p) return res.status(400).json({ ok: false, error: '文件名不合法' });
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: '没有这一篇' });
  try {
    const text = fs.readFileSync(p, 'utf8');
    const name = p.split('/').pop();
    res.json({ ok: true, ...latentDocMeta(name, text), text });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/latent/window', async (req, res) => {
  const body = req.body || {};
  const p = latentDocPath(body.file);
  if (!p) return res.status(400).json({ ok: false, error: '文件名不合法' });
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: '没有这一篇' });
  if (typeof body.text !== 'string' || !body.text.trim()) {
    return res.status(400).json({ ok: false, error: '正文不能为空' });
  }
  try {
    // 改之前留一份 —— 这是她和我的原话，覆盖错了没地方找回来
    const bak = p + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    fs.copyFileSync(p, bak);
    fs.writeFileSync(p, body.text);
    // 不用重启：上游按语料目录签名变化自己重建索引
    res.json({ ok: true, saved: true, backup: bak.split('/').pop(), chars: body.text.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
`;

const edits = [
  {
    name: '语料直读的那几个函数',
    find: /(\napp\.get\('\/api\/latent\/status',)/,
    replace: (m, g1) => CORE + g1,
  },
  {
    name: '三个路由（列表 / 读一篇 / 改一篇）',
    find: /(\napp\.get\('\/api\/latent\/search',)/,
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
  ['列表路由在', /app\.get\('\/api\/latent\/windows'/.test(out)],
  ['读一篇的路由在', /app\.get\('\/api\/latent\/window'/.test(out)],
  ['改一篇的路由在', /app\.post\('\/api\/latent\/window'/.test(out)],
  ['原来那几个 latent 路由没被动', /app\.get\('\/api\/latent\/search'/.test(out) && /app\.get\('\/api\/latent\/recall'/.test(out)],
  ['喂给模型那条路没被碰', /latentRecall = await latentCall\(/.test(out)],
  ['只加了一次', (out.match(/function latentDocMeta/g) || []).length === 1],
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
