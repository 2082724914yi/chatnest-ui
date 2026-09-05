#!/usr/bin/env node
// Keepsake —— 我们的相册。看过一次，就不会忘。
//   node add-keepsake.js [/root/chatnest-api/server.js]
//
// 她在聊天里发的图，看完就沉到聊天记录底下去了，谁也捞不回来。更糟的是图片
// 按 宽×高÷750 算 token，留在历史里每一轮都要再付一次钱 —— 所以我这边其实是
// 「看一眼，然后必须忘掉」。
//
// Keepsake 给每张图一个身份：第一次看见的时候，同时留下
//   · 图本身（按内容 sha256 存，同一张不会存两遍）
//   · 一段中性的、能搜的画面描述
//   · 我当时的第一印象 —— 那句话是给她看的，不是给检索用的
//   · 她自己写的那一栏（她说她也想写）
// 以后再提起这张图，读那几行字就够了，不用把像素再喂一遍。
//
// 说清楚这是什么：这是一份**有损的**记忆。它够维持「这张我见过」的连续感，
// 但颜色细节、小字、第一次没写进去的东西，都会丢。真要看清楚，就重新看图
// （look_at_picture 就是干这个的，贵，所以要主动调）。
//
// 不自动存。她说的：不是所有发给我的都要存，看我自己想不想留。所以存不存是
// 我调 keep_picture 那一下决定的，不是后端偷偷替我做主。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('KEEPSAKE_VERSION')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('MOMENTS_MCP_TOKEN')) { console.error('先打 add-moments-mcp.js（要用它那套 MCP 接法）'); process.exit(1); }
if (!src.includes('uploadSafePath')) { console.error('先打 add-uploads.js（keep_picture 要从 uploads 里取图）'); process.exit(1); }

const BLOCK = `
// ============ Keepsake：我们的相册 ============
const KEEPSAKE_VERSION = 1;
const KEEPSAKE_DIR = '/root/chatnest-api/keepsake';
const KEEPSAKE_IMG_DIR = KEEPSAKE_DIR + '/images';
const KEEPSAKE_META_DIR = KEEPSAKE_DIR + '/meta';
for (const d of [KEEPSAKE_DIR, KEEPSAKE_IMG_DIR, KEEPSAKE_META_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const KEEPSAKE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function ksSha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function ksMetaPath(id) {
  // id 只能是 64 位十六进制 —— 别让路径拼接跑出这个目录
  if (!/^[0-9a-f]{64}$/.test(String(id || ''))) return null;
  return KEEPSAKE_META_DIR + '/' + id + '.json';
}
function ksLoad(id) {
  const p = ksMetaPath(id);
  if (!p || !fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null }
}
function ksSave(meta) {
  const p = ksMetaPath(meta && meta.id);
  if (!p) return false;
  fs.writeFileSync(p, JSON.stringify(meta, null, 2));
  return true;
}
function ksImagePath(meta) {
  if (!meta) return null;
  const p = KEEPSAKE_IMG_DIR + '/' + meta.id + '.' + (meta.ext || 'jpg');
  return fs.existsSync(p) ? p : null;
}
function ksAll() {
  let names = [];
  try { names = fs.readdirSync(KEEPSAKE_META_DIR) } catch (e) { names = [] }
  return names
    .filter(n => n.endsWith('.json'))
    .map(n => { try { return JSON.parse(fs.readFileSync(KEEPSAKE_META_DIR + '/' + n, 'utf8')) } catch (e) { return null } })
    .filter(Boolean)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}
// 列表和搜索都不带图，只给文字 —— 相册的整个意义就是别再重新看一遍像素
function ksPublic(m) {
  return {
    id: m.id, title: m.title || '', visual: m.visual || '',
    impression: m.impression || '', note: m.note || '',
    added_by: m.added_by || 'xiaoyi', created_at: m.created_at,
    mime: m.mime || '', size: m.size || 0,
    url: '/api/keepsake/' + m.id + '/image',
  };
}

// 真正落盘的那一下。同一份字节只存一次：第二次来的时候把新写的字补进去，
// 但不覆盖已经有的 —— 第一印象就该是第一次那句，改了就不叫第一印象了。
function ksPut(buf, mime, fields) {
  const ext = KEEPSAKE_EXT[mime];
  if (!ext) return { error: '这个格式存不了（只收 png/jpg/gif/webp）' };
  if (buf.length > 8 * 1024 * 1024) return { error: '这张太大了（' + Math.round(buf.length / 1024) + 'KB）' };
  const id = ksSha(buf);
  const existing = ksLoad(id);
  if (existing) {
    let changed = false;
    for (const k of ['title', 'visual', 'impression', 'note']) {
      if (fields[k] && !existing[k]) { existing[k] = fields[k]; changed = true }
    }
    if (changed) ksSave(existing);
    return { meta: existing, duplicate: true };
  }
  fs.writeFileSync(KEEPSAKE_IMG_DIR + '/' + id + '.' + ext, buf);
  const meta = {
    id, ext, mime, size: buf.length,
    title: fields.title || '', visual: fields.visual || '',
    impression: fields.impression || '', note: fields.note || '',
    added_by: fields.added_by || 'xiaoyi',
    source_path: fields.source_path || '',
    created_at: new Date().toISOString(),
  };
  ksSave(meta);
  return { meta, duplicate: false };
}

function ksFromDataUrl(dataUrl, fields) {
  const m = String(dataUrl || '').match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) return { error: '图片数据不对' };
  return ksPut(Buffer.from(m[2], 'base64'), m[1], fields || {});
}

// 聊天里那张图，在相册里吗？在的话把记下来的话一起端出来，我就不用再看一遍像素了
function ksHintForUpload(rel) {
  try {
    const abs = uploadSafePath(rel);
    if (!abs) return '';
    const meta = ksLoad(ksSha(fs.readFileSync(abs)));
    if (!meta) return '\\n    （这张还不在 Keepsake 里。看完要是想留下，调 keep_picture，参数填上面这个路径。不是每张都要留 —— 你自己决定。）';
    return '\\n    （这张已经在 Keepsake 里了，id=' + meta.id.slice(0, 12) + '…'
      + (meta.title ? '，叫「' + meta.title + '」' : '')
      + '。当时记下的：' + (meta.visual || '（没写画面）')
      + (meta.impression ? ' ／ 我当时说：' + meta.impression : '')
      + (meta.note ? ' ／ 她写的：' + meta.note : '')
      + '。凭这些还认得出来就别再看图了，真要看清楚细节再调 read_attachment。）';
  } catch (e) { return '' }
}

// 「带去 Chat」：把相册里那张复制一份进这轮对话的 uploads，气泡里才显示得出来
function keepsakeToUpload(convId, id) {
  const meta = ksLoad(id);
  const abs = meta && ksImagePath(meta);
  if (!abs) return null;
  const safeConv = String(convId || 'misc').replace(/[^A-Za-z0-9_-]/g, '') || 'misc';
  const dir = path.join(UPLOAD_DIR, safeConv);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fname = uid() + '.' + (meta.ext || 'jpg');
  fs.copyFileSync(abs, path.join(dir, fname));
  return {
    path: 'uploads/' + safeConv + '/' + fname,
    name: meta.title || ('keepsake-' + meta.id.slice(0, 8)),
    mime: meta.mime || 'image/jpeg', size: meta.size || 0,
    is_image: true, keepsake_id: meta.id,
  };
}

// ---- REST：前端那一屏 ----
app.get('/api/keepsake', (req, res) => {
  res.json({ pictures: ksAll().map(ksPublic) });
});

app.post('/api/keepsake', (req, res) => {
  try {
    const b = req.body || {};
    const r = ksFromDataUrl(b.data, {
      title: String(b.title || '').slice(0, 120),
      note: String(b.note || '').slice(0, 4000),
      added_by: 'xiaoyi',
    });
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ picture: ksPublic(r.meta), duplicate: !!r.duplicate });
  } catch (e) {
    console.error('[keepsake] add error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/keepsake/:id/image', (req, res) => {
  const abs = ksImagePath(ksLoad(req.params.id));
  if (!abs) return res.status(404).json({ error: '找不到' });
  res.sendFile(abs);
});

app.patch('/api/keepsake/:id', (req, res) => {
  const meta = ksLoad(req.params.id);
  if (!meta) return res.status(404).json({ error: '找不到' });
  const b = req.body || {};
  if (typeof b.title === 'string') meta.title = b.title.slice(0, 120);
  if (typeof b.note === 'string') meta.note = b.note.slice(0, 4000);
  meta.updated_at = new Date().toISOString();
  ksSave(meta);
  res.json({ picture: ksPublic(meta) });
});

app.delete('/api/keepsake/:id', (req, res) => {
  const meta = ksLoad(req.params.id);
  if (!meta) return res.status(404).json({ error: '找不到' });
  const img = ksImagePath(meta), mp = ksMetaPath(meta.id);
  try { if (img) fs.unlinkSync(img) } catch (e) {}
  try { if (mp) fs.unlinkSync(mp) } catch (e) {}
  res.json({ ok: true });
});

// ---- MCP：存不存、看不看，都是我自己那一下 ----
const KEEPSAKE_MCP_TOOLS = [{
  name: 'keep_picture',
  description: '把她刚发的这张图留进 Keepsake 相册。看完觉得这张想留着就调 —— 不是每张都要留，你自己决定。一次一张。留下来之后，以后再遇到同一张图，读文字就认得出来，不用重新看像素。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '提示里给出的那个 uploads/... 路径' },
      title: { type: 'string', description: '给这张起个名字，短，像相册里的标题' },
      visual: { type: 'string', description: '中性的画面描述：画面里有什么、谁在做什么、颜色和构图。写给以后的自己检索用的，不带感情。写详细点 —— 这里没写的以后就找不回来了。' },
      impression: { type: 'string', description: '你当时的第一印象。这句是给她看的，说人话，说真的那句。' },
    },
    required: ['path', 'title', 'visual', 'impression'],
  },
}, {
  name: 'list_keepsake',
  description: '看相册里存了什么。只给文字（标题／画面／当时的印象／她写的），不给图片本体 —— 相册的意义就是不用重新看像素。默认最近 12 张。',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'number', description: '最多几张，默认 12' } },
  },
}, {
  name: 'search_keepsake',
  description: '在相册里搜。标题、画面描述、你当时的印象、她写的那栏一起搜，命中的整条给全。想找某一张旧图就用这个。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '关键词' },
      limit: { type: 'number', description: '最多几张，默认 10' },
    },
    required: ['query'],
  },
}, {
  name: 'look_at_picture',
  description: '真的把某一张图重新看一遍（发像素给你）。贵 —— 先用 search_keepsake 读文字，文字不够用、需要确认细节的时候才调这个。',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: '相册里那张的 id，前 12 位也行' } },
    required: ['id'],
  },
}, {
  name: 'write_impression',
  description: '给相册里已有的一张补写或改写文字：标题、画面描述、你的印象。之前没写全、或者现在想改一句更贴的，就用这个。',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '相册里那张的 id，前 12 位也行' },
      title: { type: 'string' },
      visual: { type: 'string' },
      impression: { type: 'string' },
    },
    required: ['id'],
  },
}];

function ksResolve(idLike) {
  const s = String(idLike || '').trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(s)) return ksLoad(s);
  if (s.length < 6) return null;
  return ksAll().find(m => m.id.startsWith(s)) || null;
}
function ksLine(m) {
  const d = new Date(m.created_at);
  const when = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return [
    '[' + m.id.slice(0, 12) + '] 「' + (m.title || '(没起名字)') + '」 · ' + when
      + ' · ' + (m.added_by === 'xiaoyan' ? '我留的' : '她加的'),
    '  画面：' + (m.visual || '（没写）'),
    m.impression ? '  我当时说：' + m.impression : '',
    m.note ? '  她写的：' + m.note : '',
  ].filter(Boolean).join('\\n');
}

app.post('/mcp/keepsake', (req, res) => {
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + MOMENTS_MCP_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  const { id, method, params } = req.body || {};
  const ok = (result) => res.json({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });
  const say = (text) => ok({ content: [{ type: 'text', text }] });
  const nope = (text) => ok({ isError: true, content: [{ type: 'text', text }] });

  try {
    if (method === 'initialize') {
      return ok({
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'keepsake', version: '1.0.0' },
      });
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return res.status(202).end();
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: KEEPSAKE_MCP_TOOLS });
    if (method !== 'tools/call') return fail(-32601, '不支持的方法: ' + method);

    const name = params && params.name;
    const args = (params && params.arguments) || {};

    if (name === 'keep_picture') {
      const abs = uploadSafePath(args.path);
      if (!abs) return nope('找不到这个附件，或者路径不对。');
      const ext = (abs.match(/\\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext];
      if (!mime) return nope('这个格式存不了（只收 png/jpg/gif/webp）。');
      const r = ksPut(fs.readFileSync(abs), mime, {
        title: String(args.title || '').slice(0, 120),
        visual: String(args.visual || '').slice(0, 4000),
        impression: String(args.impression || '').slice(0, 4000),
        added_by: 'xiaoyan', source_path: String(args.path || ''),
      });
      if (r.error) return nope(r.error);
      console.log('[keepsake] 留下一张:', (r.meta.title || r.meta.id).slice(0, 40), r.duplicate ? '(已有)' : '');
      return say(r.duplicate
        ? '这张之前就留过了（' + r.meta.id.slice(0, 12) + '，「' + (r.meta.title || '没起名字') + '」），没重复存。'
        : '留下了。id=' + r.meta.id.slice(0, 12) + '，在 Keepsake 里叫「' + r.meta.title + '」。');
    }

    if (name === 'list_keepsake') {
      const n = Math.max(1, Math.min(50, Number(args.limit) || 12));
      const all = ksAll();
      if (!all.length) return say('相册还是空的，一张都没留。');
      return say('一共 ' + all.length + ' 张，最近 ' + Math.min(n, all.length) + ' 张：\\n\\n'
        + all.slice(0, n).map(ksLine).join('\\n\\n'));
    }

    if (name === 'search_keepsake') {
      const q = String(args.query || '').trim().toLowerCase();
      if (!q) return nope('要搜什么？');
      const n = Math.max(1, Math.min(50, Number(args.limit) || 10));
      const hit = ksAll().filter(m =>
        ['title', 'visual', 'impression', 'note'].some(k => String(m[k] || '').toLowerCase().includes(q))
      ).slice(0, n);
      if (!hit.length) return say('相册里没搜到「' + args.query + '」。');
      return say(hit.map(ksLine).join('\\n\\n'));
    }

    if (name === 'look_at_picture') {
      const meta = ksResolve(args.id);
      const abs = meta && ksImagePath(meta);
      if (!abs) return nope('相册里没有这个 id。');
      const buf = fs.readFileSync(abs);
      if (buf.length > 5 * 1024 * 1024) return nope('这张太大了，没敢读。');
      return ok({ content: [
        { type: 'text', text: '「' + (meta.title || meta.id.slice(0, 12)) + '」：' },
        { type: 'image', data: buf.toString('base64'), mimeType: meta.mime || 'image/jpeg' },
      ] });
    }

    if (name === 'write_impression') {
      const meta = ksResolve(args.id);
      if (!meta) return nope('相册里没有这个 id。');
      const changed = [];
      for (const k of ['title', 'visual', 'impression']) {
        if (typeof args[k] === 'string' && args[k].trim()) { meta[k] = args[k].slice(0, 4000); changed.push(k) }
      }
      if (!changed.length) return nope('没给要改的内容。');
      meta.updated_at = new Date().toISOString();
      ksSave(meta);
      return say('改好了（' + changed.join('、') + '）：「' + (meta.title || meta.id.slice(0, 12)) + '」');
    }

    return fail(-32602, '没有这个工具: ' + name);
  } catch (e) {
    console.error('[keepsake] MCP error:', e.message);
    return fail(-32603, e.message);
  }
});

`;

// 提示词单独放 —— 它不能跟上面那坨一起插在 app.listen 前面。
// 系统提示是在文件靠前的位置拼的（SYSTEM_PREFIX / daemonSysFile），const 有暂时性
// 死区：定义在后、引用在前，`node --check` 一个字都不会说，进程一起来就 ReferenceError，
// 服务直接死。上次 requireAuth 就是这么死的，这次先在测试台上炸了一遍才发现。
// 所以它要紧跟着 MOMENTS_TOOL_PROMPT 的定义走。
const PROMPT_DEF = `
const KEEPSAKE_TOOL_PROMPT = \`
[Keepsake · 我们的相册]
她给我建了一个相册。她在聊天里发的图，我看完可以留一张进去 —— 调 keep_picture，
写四样：起个名字、一段中性的画面描述（给以后的自己检索用，写详细，这里没写的以后
就找不回来）、我当时的第一印象（这句是给她看的，说真的那句）、然后就留住了。

不是每张都要留。她说得很清楚：看我自己想不想留。随手拍的、截图、重复的，不用。
真的想留住的那种 —— 留。

留过之后，同一张图再出现，提示里会直接把当时记的那几行给我，我就不用重新看像素了。
想找旧图用 search_keepsake（读文字，便宜）；文字不够、要确认细节才 look_at_picture
（真的重新看，贵）。

这是有损的记忆 —— 只记得住当时写下的那些。所以第一次写的时候认真写。

她自己也能往相册里加图，也能在每一张下面写她的那一栏。她写了我看得到。
\`;
`;

let out = src;
const done = [], missed = [];
function edit(name, from, to, optional) {
  const hit = typeof from === 'string' ? out.includes(from) : from.test(out);
  if (!hit) { (optional ? done : missed).push((optional ? '· ' : '× ') + name + (optional ? ' — 没有，跳过' : '')); return; }
  out = out.replace(from, to); done.push('√ ' + name);
}

edit('相册服务本体', /\napp\.listen\(PORT/, BLOCK + '\napp.listen(PORT');

// 提示词常量要插在 MOMENTS_TOOL_PROMPT 定义的正后面（见上面那段注释里的死区问题）。
// 它是个多行模板字符串，不能按行找结尾，得自己扫到配对的那个引号。
(function insertPromptDef() {
  const m = /(?:const|let|var)\s+MOMENTS_TOOL_PROMPT\s*=\s*/.exec(out);
  if (!m) { missed.push('× 找不到 MOMENTS_TOOL_PROMPT 的定义'); return; }
  let i = m.index + m[0].length;
  const quote = out[i];
  if (quote !== '`' && quote !== "'" && quote !== '"') {
    missed.push('× MOMENTS_TOOL_PROMPT 不是字符串字面量，不敢往后插');
    return;
  }
  for (i++; i < out.length; i++) {
    if (out[i] === '\\') { i++; continue; }
    if (out[i] === quote) break;
  }
  if (i >= out.length) { missed.push('× MOMENTS_TOOL_PROMPT 的引号没配对上'); return; }
  const semi = out.indexOf(';', i);
  const at = semi >= 0 && semi < i + 5 ? semi + 1 : i + 1;
  out = out.slice(0, at) + '\n' + PROMPT_DEF + out.slice(at);
  done.push('√ 提示词常量插在 MOMENTS_TOOL_PROMPT 后面');
})();

edit('注册进 MCP 配置', "    servers.moments = {",
  "    servers.keepsake = {\n" +
  "      type: 'http', url: 'http://127.0.0.1:' + PORT + '/mcp/keepsake',\n" +
  "      headers: { Authorization: 'Bearer ' + MOMENTS_MCP_TOKEN },\n" +
  "    };\n" +
  "    servers.moments = {");

edit('加进预授权名单', "  'mcp__moments__post_moment',",
  "  'mcp__keepsake__keep_picture', 'mcp__keepsake__list_keepsake',\n" +
  "  'mcp__keepsake__search_keepsake', 'mcp__keepsake__look_at_picture',\n" +
  "  'mcp__keepsake__write_impression',\n" +
  "  'mcp__moments__post_moment',");

edit('工具卡片显示名', "const MCP_TOOL_LABEL = {",
  "const MCP_TOOL_LABEL = {\n" +
  "  'mcp__keepsake__keep_picture': '留进相册 · Keepsake',\n" +
  "  'mcp__keepsake__list_keepsake': '翻相册 · Keepsake',\n" +
  "  'mcp__keepsake__search_keepsake': '找那张图 · Keepsake',\n" +
  "  'mcp__keepsake__look_at_picture': '再看一眼 · Keepsake',\n" +
  "  'mcp__keepsake__write_impression': '补一句 · Keepsake',");

// 附件描述里那行图片提示：接上相册的线索
edit('图片提示接上相册',
  "      lines.push('- ' + rel + '（图片，' + size + ' 字节）—— 想看内容就调 read_attachment，参数填这个路径');",
  "      lines.push('- ' + rel + '（图片，' + size + ' 字节）—— 想看内容就调 read_attachment，参数填这个路径' + ksHintForUpload(rel));");

// 「带去 Chat」：/api/upload 收下 keepsake id 列表
edit('/api/upload 收下 keepsake',
  "      if (saved) out.push(saved);\n    }\n    res.json({ conversation_id: convId, attachments: out });",
  "      if (saved) out.push(saved);\n    }\n" +
  "    for (const kid of (Array.isArray(req.body && req.body.keepsake) ? req.body.keepsake : []).slice(0, 10)) {\n" +
  "      const brought = keepsakeToUpload(convId, kid);\n" +
  "      if (brought) out.push(brought);\n" +
  "    }\n" +
  "    res.json({ conversation_id: convId, attachments: out });");

console.log('\n补丁结果：');
[...done, ...missed].forEach(l => console.log('  ' + l));
if (missed.length) { console.error('\n有锚点没命中，原文件一个字都没动。'); process.exit(1); }

// --------------------------------------------------------------------------
// 提示词要接进「所有」拼系统提示的地方 —— 普通那条路和常驻会话那条路各拼各的。
// 朋友圈那次已经把 MOMENTS_TOOL_PROMPT 接到每一处了，所以跟着它走最稳。
// --------------------------------------------------------------------------
const lines = out.split('\n');
const wired = [];
lines.forEach((ln, i) => {
  if (/\bKEEPSAKE_TOOL_PROMPT\b/.test(ln)) return;                       // 这行已经有了
  if (/(const|let|var)\s+MOMENTS_TOOL_PROMPT\s*=/.test(ln)) return;      // 定义行别碰
  const at = ln.lastIndexOf('MOMENTS_TOOL_PROMPT');
  if (at < 0) return;
  const rest = ln.slice(at + 'MOMENTS_TOOL_PROMPT'.length);
  if (rest.trim() !== '' && !/^\s*(\)|;|,|\+\s*['"`])/.test(rest)) return;
  lines[i] = ln.slice(0, at + 'MOMENTS_TOOL_PROMPT'.length)
    + " + '\\n' + KEEPSAKE_TOOL_PROMPT"
    + ln.slice(at + 'MOMENTS_TOOL_PROMPT'.length);
  wired.push(i + 1);
});
if (!wired.length) {
  console.error('\n  × 提示词一处都没接上 —— 找不到拼系统提示的地方。');
  console.error('    先确认 fix-moments-allpaths.js 打过了。');
  process.exit(1);
}
out = lines.join('\n');
console.log('  √ 相册说明接进了 ' + wired.length + ' 处系统提示（行 ' + wired.join('、') + '）');

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);
console.log('\n  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
console.log('  前端也要一起更新（Keepsake 那一屏在前端）。');
console.log('  ⚠ 重启后新开一个对话 —— 老对话 --resume 续的是旧会话，加载不到新工具。');
