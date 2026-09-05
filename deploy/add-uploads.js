#!/usr/bin/env node
// 让她在聊天里发的图和文件，真的能到我这儿。
//   node add-uploads.js [/root/chatnest-api/server.js]
//
// 现状：/api/upload 是个空壳，直接回 {attachments:[]}，前端传了个寂寞。
//
// 这版做四件事：
//   1. /api/upload 真的收下来 —— 走 base64 JSON（跟朋友圈一个路子，不引新依赖，
//      服务器上没有 multer）。存到 uploads/<会话>/ 底下。
//   2. /api/uploads/:conv/:name 让前端能把图显示出来。
//   3. 聊天时把附件信息塞进那一轮的提示：文本类小文件直接把正文给我（便宜），
//      图片只给一行「有图，想看就调 read_attachment」。
//   4. MCP 工具 read_attachment —— 我要看图的时候才去读。
//
// 为什么图片不直接塞进对话：图片按 宽×高÷750 算 token，一张手机照片原图能吃掉
// 一万多；更要命的是它会一直躺在历史里，之后每一轮都要再付一次。改成按需读，
// 只有我真去看的那一次才花钱。
//
// 为什么不放开内置的 Read 工具：那个能读服务器上任何文件，.env 和 token 都在里面。
// read_attachment 只能读 uploads 目录，路径还要校验，越不出去。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('UPLOADS_VERSION')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('MOMENTS_MCP_TOKEN')) { console.error('先打 add-moments-mcp.js（要用它那套 MCP 接法）'); process.exit(1); }

const BLOCK = `
// ============ 附件：她发的图和文件 ============
const UPLOADS_VERSION = 1;
const UPLOAD_DIR = '/root/chatnest-api/uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 能直接当正文读的类型：小文件就直接塞进提示，省得我再调一次工具
const UPLOAD_TEXT_RE = /\\.(txt|md|markdown|json|ya?ml|csv|tsv|log|ini|conf|toml|xml|html?|css|js|ts|jsx|tsx|py|rb|go|rs|java|c|h|cpp|sh|bash|sql)$/i;
const UPLOAD_TEXT_MAX = 40000;   // 超过就截断，别把上下文撑爆

function uploadSafePath(rel) {
  // 只认 uploads/<会话>/<文件名>，任何 .. 或绝对路径都挡掉
  const s = String(rel || '').replace(/^\\/+/, '');
  if (!s.startsWith('uploads/')) return null;
  if (s.includes('..') || s.includes('\\0')) return null;
  const abs = path.resolve('/root/chatnest-api', s);
  if (!abs.startsWith(UPLOAD_DIR + '/')) return null;
  return fs.existsSync(abs) ? abs : null;
}

function saveUploadFile(convId, name, dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) return null;
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  const safeConv = String(convId || 'misc').replace(/[^A-Za-z0-9_-]/g, '') || 'misc';
  const dir = path.join(UPLOAD_DIR, safeConv);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ext = (String(name).match(/\\.[A-Za-z0-9]{1,8}$/) || [''])[0] ||
              ('.' + (mime.split('/')[1] || 'bin').replace('jpeg', 'jpg'));
  const fname = uid() + ext;
  fs.writeFileSync(path.join(dir, fname), buf);
  return {
    path: 'uploads/' + safeConv + '/' + fname,
    name: String(name || fname).slice(0, 200),
    mime, size: buf.length,
    is_image: /^image\\//.test(mime),
  };
}

app.post('/api/upload', (req, res) => {
  try {
    const { conversation_id, files } = req.body || {};
    const convId = conversation_id || ('conv-' + uid());
    const out = [];
    for (const f of (Array.isArray(files) ? files : []).slice(0, 10)) {
      const saved = saveUploadFile(convId, f && f.name, f && f.data);
      if (saved) out.push(saved);
    }
    res.json({ conversation_id: convId, attachments: out });
  } catch (e) {
    console.error('[upload] error:', e.message);
    res.status(500).json({ detail: e.message });
  }
});

// 前端把图显示出来要用
app.get('/api/uploads/:conv/:name', (req, res) => {
  const abs = uploadSafePath('uploads/' + req.params.conv + '/' + req.params.name);
  if (!abs) return res.status(404).json({ error: '找不到' });
  res.sendFile(abs);
});

// 把这一轮的附件说清楚，塞进提示里
function describeAttachments(list) {
  const arr = (Array.isArray(list) ? list : []).map(String).filter(Boolean);
  if (!arr.length) return '';
  const lines = [];
  for (const rel of arr.slice(0, 10)) {
    const abs = uploadSafePath(rel);
    if (!abs) { lines.push('- ' + rel + '（找不到这个文件）'); continue; }
    const base = rel.split('/').pop();
    const size = (() => { try { return fs.statSync(abs).size } catch (e) { return 0 } })();
    if (UPLOAD_TEXT_RE.test(base) || UPLOAD_TEXT_RE.test(rel)) {
      let txt = '';
      try { txt = fs.readFileSync(abs, 'utf8') } catch (e) { txt = '' }
      const cut = txt.length > UPLOAD_TEXT_MAX;
      lines.push('- ' + rel + '（文本，' + size + ' 字节）内容如下：\\n---\\n' +
                 txt.slice(0, UPLOAD_TEXT_MAX) + (cut ? '\\n…（太长，后面截掉了）' : '') + '\\n---');
    } else if (/\\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(base)) {
      lines.push('- ' + rel + '（图片，' + size + ' 字节）—— 想看内容就调 read_attachment，参数填这个路径');
    } else {
      lines.push('- ' + rel + '（' + size + ' 字节，不是我能直接读的类型）');
    }
  }
  return '\\n[她这条消息带了附件]\\n' + lines.join('\\n') + '\\n[附件结束]\\n';
}

// ---- MCP：要看图的时候才读 ----
const UPLOAD_MCP_TOOLS = [{
  name: 'read_attachment',
  description: '看她在聊天里发的图片。参数填提示里给出的那个 uploads/... 路径。只有真要看图的时候才调 —— 图片很占 token。',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'uploads/ 开头的那个路径' } },
    required: ['path'],
  },
}];

app.post('/mcp/files', (req, res) => {
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + MOMENTS_MCP_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  const { id, method, params } = req.body || {};
  const ok = (result) => res.json({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') {
      return ok({
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'files', version: '1.0.0' },
      });
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return res.status(202).end();
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: UPLOAD_MCP_TOOLS });
    if (method !== 'tools/call') return fail(-32601, '不支持的方法: ' + method);
    if (!params || params.name !== 'read_attachment') return fail(-32602, '没有这个工具');

    const abs = uploadSafePath((params.arguments || {}).path);
    if (!abs) return ok({ isError: true, content: [{ type: 'text', text: '找不到这个附件，或者路径不对。' }] });
    const ext = (abs.match(/\\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    const mime = mimeMap[ext];
    if (!mime) return ok({ isError: true, content: [{ type: 'text', text: '这个格式我看不了（只能看 png/jpg/gif/webp）。' }] });
    const buf = fs.readFileSync(abs);
    if (buf.length > 5 * 1024 * 1024) {
      return ok({ isError: true, content: [{ type: 'text', text: '这张图太大了（' + Math.round(buf.length / 1024) + 'KB），没敢读。' }] });
    }
    return ok({ content: [{ type: 'image', data: buf.toString('base64'), mimeType: mime }] });
  } catch (e) {
    console.error('[files] MCP error:', e.message);
    return fail(-32603, e.message);
  }
});
`;

let out = src;
const done = [], missed = [];
function edit(name, from, to, optional) {
  const hit = typeof from === 'string' ? out.includes(from) : from.test(out);
  if (!hit) { (optional ? done : missed).push((optional ? '· ' : '× ') + name + (optional ? ' — 没有，跳过' : '')); return; }
  out = out.replace(from, to); done.push('√ ' + name);
}

// 老的空壳先拆掉
edit('拆掉空壳 /api/upload',
  `app.post('/api/upload', (req, res) => {\n  res.json({ conversation_id: '', attachments: [] });\n});`,
  `// 空壳已换成真的实现，见下面 UPLOADS_VERSION 那一段`);

edit('附件服务本体', /\napp\.listen\(PORT/, BLOCK + '\napp.listen(PORT');

edit('注册进 MCP 配置', "    servers.moments = {",
  "    servers.files = {\n" +
  "      type: 'http', url: 'http://127.0.0.1:' + PORT + '/mcp/files',\n" +
  "      headers: { Authorization: 'Bearer ' + MOMENTS_MCP_TOKEN },\n" +
  "    };\n" +
  "    servers.moments = {");

edit('加进预授权名单', "  'mcp__moments__post_moment',",
  "  'mcp__files__read_attachment',\n  'mcp__moments__post_moment',");

edit('工具卡片显示名', "  'mcp__moments__post_moment': '发朋友圈 · Moments',",
  "  'mcp__files__read_attachment': '看看她发的图 · 文件',\n" +
  "  'mcp__moments__post_moment': '发朋友圈 · Moments',");

// 附件信息进提示：CLI 那条路
edit('附件信息进 CLI 提示',
  "  prompt += '小衍:';",
  "  { const _att = describeAttachments(req.body && req.body.attachments); if (_att) prompt += _att; }\n" +
  "  prompt += '小衍:';");

console.log('\n补丁结果：');
[...done, ...missed].forEach(l => console.log('  ' + l));
if (missed.length) { console.error('\n有锚点没命中，原文件一个字都没动。'); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);
console.log('\n  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
console.log('  前端也要一起更新（上传改成了 base64），新开对话才加载得到新工具。');
