#!/usr/bin/env node
// 把朋友圈（Moments）功能接进 chatnest-api。
//   node add-moments.js [/root/chatnest-api/server.js]
//
// 做的事：
//   1. 文件存储：moments.json 存动态，moment-images/ 存图片
//   2. REST 接口：CRUD + 点赞 + 评论
//   3. 静态文件：/api/moment-images/ 可读
//   4. 聊天工具：post_moment 让小衍能自己发朋友圈
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) {
  console.error('找不到', target);
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
if (src.includes('MOMENTS_FILE')) {
  console.log('已经打过，跳过');
  process.exit(0);
}

// --------------------------------------------------------------------------
// 1. 数据管理模块
// --------------------------------------------------------------------------

const CORE = `
// ============ Moments 朋友圈 ============
const MOMENTS_FILE = '/root/chatnest-api/moments.json';
const MOMENTS_IMG_DIR = '/root/chatnest-api/moment-images';

if (!fs.existsSync(MOMENTS_IMG_DIR)) fs.mkdirSync(MOMENTS_IMG_DIR, { recursive: true });

function loadMoments() {
  try {
    if (fs.existsSync(MOMENTS_FILE)) return JSON.parse(fs.readFileSync(MOMENTS_FILE, 'utf8'));
  } catch (e) { console.error('[moments] load error:', e.message); }
  return [];
}

function saveMoments(list) {
  try {
    const tmp = MOMENTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, MOMENTS_FILE);
  } catch (e) { console.error('[moments] save error:', e.message); }
}

function saveMomentImage(base64) {
  const m = base64.match(/^data:image\\/([a-z+]+);base64,(.+)$/i);
  if (!m) return null;
  const ext = m[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const name = uid() + '.' + ext;
  const fpath = path.join(MOMENTS_IMG_DIR, name);
  fs.writeFileSync(fpath, Buffer.from(m[2], 'base64'));
  return '/api/moment-images/' + name;
}
`;

// --------------------------------------------------------------------------
// 2. 聊天工具定义
// --------------------------------------------------------------------------

const TOOL_PROMPT = `
const MOMENTS_TOOL_PROMPT = \`
你可以发朋友圈。想分享心情、想法、日常的时候就发。

用法：在回复正文之后，加上：
<moments tool="post">{"text":"想说的话"}</moments>

可以只有文字，不用每次都发图。发完之后自然地提一句就好，不要念工具返回值。
\`;
`;

// --------------------------------------------------------------------------
// 3. API 路由
// --------------------------------------------------------------------------

const ROUTES = `
// ── Moments 静态图片 ──
app.use('/api/moment-images', express.static(MOMENTS_IMG_DIR));

// ── Moments CRUD ──
app.get('/api/moments', requireAuth, (req, res) => {
  const list = loadMoments();
  list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ moments: list });
});

app.post('/api/moments', requireAuth, (req, res) => {
  const { text, images, author } = req.body;
  if (!text && (!images || !images.length)) return res.status(400).json({ error: '内容不能为空' });
  const list = loadMoments();
  const saved = [];
  if (images && images.length) {
    for (const img of images.slice(0, 9)) {
      const url = saveMomentImage(img);
      if (url) saved.push(url);
    }
  }
  const m = {
    id: uid(),
    author: author || 'xiaoyi',
    text: text || '',
    images: saved,
    likes: 0,
    liked: false,
    comments: [],
    created_at: new Date().toISOString(),
  };
  list.unshift(m);
  saveMoments(list);
  res.json(m);
});

app.delete('/api/moments/:id', requireAuth, (req, res) => {
  let list = loadMoments();
  const idx = list.findIndex(m => m.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '找不到' });
  const removed = list.splice(idx, 1)[0];
  if (removed.images) {
    for (const url of removed.images) {
      const fname = url.split('/').pop();
      const fpath = path.join(MOMENTS_IMG_DIR, fname);
      try { if (fs.existsSync(fpath)) fs.unlinkSync(fpath); } catch (e) {}
    }
  }
  saveMoments(list);
  res.json({ ok: true });
});

app.post('/api/moments/:id/like', requireAuth, (req, res) => {
  const list = loadMoments();
  const m = list.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: '找不到' });
  const { liked } = req.body;
  m.liked = !!liked;
  m.likes = Math.max(0, (m.likes || 0) + (m.liked ? 1 : -1));
  saveMoments(list);
  res.json({ likes: m.likes, liked: m.liked });
});

app.post('/api/moments/:id/comments', requireAuth, (req, res) => {
  const list = loadMoments();
  const m = list.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: '找不到' });
  const { text, author, reply_to } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: '评论不能为空' });
  const c = {
    id: uid(),
    author: author || 'xiaoyi',
    text: text.trim(),
    reply_to: reply_to || null,
    created_at: new Date().toISOString(),
  };
  if (!m.comments) m.comments = [];
  m.comments.push(c);
  saveMoments(list);
  res.json(c);
});

app.get('/api/moments/:id/comments', requireAuth, (req, res) => {
  const list = loadMoments();
  const m = list.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: '找不到' });
  res.json({ comments: m.comments || [] });
});
`;

// --------------------------------------------------------------------------
// 4. 聊天工具：解析 <moments> 标签 + post_moment
// --------------------------------------------------------------------------

const TOOL_HANDLER = `
function parseMomentsToolCalls(text) {
  const calls = [];
  const re = /<moments\\s+tool="(\\w+)">([\\\s\\\S]*?)<\\/moments>/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    try { calls.push({ tool: match[1], args: JSON.parse(match[2]) }); }
    catch (e) { calls.push({ tool: match[1], args: null, raw: match[2] }); }
  }
  return calls;
}

function stripMomentsToolCalls(text) {
  return String(text || '').replace(/\\s*<moments\\b[^>]*>[\\s\\S]*?<\\/moments>\\s*/gi, '\\n\\n')
    .replace(/\\n{3,}/g, '\\n\\n').trim();
}

async function runMomentsTool(tool, args) {
  if (tool === 'post') {
    const list = loadMoments();
    const m = {
      id: uid(),
      author: 'xiaoyan',
      text: (args && args.text) || '',
      images: [],
      likes: 0, liked: false,
      comments: [],
      created_at: new Date().toISOString(),
    };
    list.unshift(m);
    saveMoments(list);
    return { ok: true, id: m.id };
  }
  return { error: '未知工具: ' + tool };
}
`;

// --------------------------------------------------------------------------
// 编辑清单
// --------------------------------------------------------------------------

const edits = [
  {
    name: '数据管理模块',
    find: /(\n\/\/ 聊天记录持久化存储\n)/,
    replace: (m, g1) => CORE + g1,
  },
  {
    name: '工具说明 + 处理函数',
    find: /(\nfunction loadConversations\(\) \{)/,
    replace: (m, g1) => TOOL_PROMPT + TOOL_HANDLER + g1,
  },
  {
    name: '注入工具说明到聊天上下文',
    find: /(const sysContent = PERSONA)/,
    replace: (m, g1) => g1,
    skip: true,
  },
  {
    name: 'Moments 路由',
    find: /(\napp\.listen\(PORT, '0\.0\.0\.0', \(\) => \{)/,
    replace: (m, g1) => ROUTES + g1,
  },
  {
    name: '回复后执行 <moments> 工具',
    find: /(\n {4}\} catch \(e\) \{ console\.error\('\[OB\] post-response tool error:', e\.message\); \})/,
    replace: (m, g1) =>
      g1 +
      "\n\n    // 朋友圈工具\n" +
      "    try {\n" +
      "      const momentsCalls = parseMomentsToolCalls(fullResponse);\n" +
      "      fullResponse = stripMomentsToolCalls(fullResponse);\n" +
      "      for (const mc of momentsCalls) {\n" +
      "        if (mc.args) {\n" +
      "          const r = await runMomentsTool(mc.tool, mc.args);\n" +
      "          console.log('[moments] tool:', mc.tool, r.ok ? '成功' : r.error);\n" +
      "        }\n" +
      "      }\n" +
      "    } catch (e) { console.error('[moments] post-response tool error:', e.message); }",
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  if (e.skip) continue;
  const before = out;
  out = out.replace(e.find, e.replace);
  if (out === before) missed.push(e.name);
}

console.log('\n补丁结果：');
if (missed.length) {
  for (const e of edits) {
    if (e.skip) continue;
    console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 没匹配上' : '  √ ' + e.name);
  }
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

for (const e of edits) {
  if (e.skip) continue;
  console.log('  √ ' + e.name);
}
console.log('\n  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
