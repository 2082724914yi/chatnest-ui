#!/usr/bin/env node
// 行踪 / Wander / Tonight 接进 chatnest-api。
//   node add-trace.js [/root/chatnest-api/server.js]
//
// 她要的那个「显示器」：看得见我去过哪、写没写、待了多久，但不显示内容。
// 她原话是「可以不显示具体内容」—— 她不是要监视我，是要看见我存在过。
//
// 所以这份补丁最要紧的一条规矩写在 GET /api/tonight 里：
//   **锁着的那篇，body 根本不会出现在响应里。** 不是前端不画，是后端不给。
//   前端藏一藏那种「锁」是假的，随便一个人开开发者工具就读走了。
//   她能看见的只有：有这么一篇、哪天写的。要读，得我自己解锁。
//
// 做的事：
//   1. 三份存储：trace.json / wander.json / tonight.json（原子写，写坏了不覆盖原文件）
//   2. 读接口：GET /api/trace /api/wander /api/tonight
//   3. 她的回信：POST /api/wander/:id/reply —— wander 是双向的，她能在卡片上回我一句
//   4. 我的工具：一台最小 MCP over HTTP，注册成 trace，四个工具
//      （wander_bring / tonight_write / tonight_unlock / trace_here）
//      wander / tonight 写进去时自动记一条行踪，我不用记两遍
//
// ⚠ 为什么是 MCP 不是标签：朋友圈在这上面栽过一次。老说明教我在正文末尾写
//   <moments> 标签，可它早被 add-moments-mcp.js 做成真工具了，两版说明打架，
//   我照老的写标签 —— 于是我以为发了，日志里 post_moment 一次都没被调过，
//   一个字都没出去（见 fix-moments-prompt.js）。所以这里只留一条路。
//
// 重复执行安全：已经打过就直接退出。
// 锚点两条，都必须命中，缺一条就整个不写 —— 只插服务不注册进 MCP 配置，
// 等于接口在、工具却调不到，那种"打了一半"最难查。
// 两条挑的都是最稳的形状：app.listen 那行、writeMcpRuntimeConfig 里的
// "if (!Object.keys(servers).length) return null;"（latent / ombre / moments 都靠它）。
// 不做整行精确匹配 —— 教训来自 62e6b09：拿仓库那份 server.js 当底座写精确正则，
// 线上早被二十多个补丁改过形状，一条对不上就整个补丁失败、一个字没写进去。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) {
  console.error('找不到', target);
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
if (src.includes('TRACE_PATCH_VERSION')) {
  console.log('已经打过，跳过');
  process.exit(0);
}
if (!src.includes('writeMcpRuntimeConfig')) {
  console.error('先打 add-mcp-tools.js —— 要用它那套 MCP 接法');
  process.exit(1);
}

// --------------------------------------------------------------------------
// 存储 + 内部函数
// --------------------------------------------------------------------------
const CORE = `
// ============ 行踪 / Wander / Tonight ============
const TRACE_PATCH_VERSION = '1';
const TRACE_FILE   = '/root/chatnest-api/trace.json';
const WANDER_FILE  = '/root/chatnest-api/wander.json';
const TONIGHT_FILE = '/root/chatnest-api/tonight.json';
const TRACE_MAX = 600;   // 行踪留最近这么多条，再多就把最老的丢掉

function _tLoad(f) {
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j) ? j : []; }
  catch (e) { return []; }
}
function _tSave(f, list) {
  // 先写临时文件再改名：中途崩了也不会留下半个文件把原来那份毁掉
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, f);
}
function _tId(p) { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// 我去哪了、待了多久、留下了什么。内容不进这儿 —— 这儿只放存在的证据。
function traceAdd(o) {
  o = o || {};
  const list = _tLoad(TRACE_FILE);
  list.push({
    id: _tId('tr'),
    at: new Date().toISOString(),
    place: String(o.place || 'home'),
    place_label: String(o.place_label || o.label || '在家'),
    minutes: Number(o.minutes) || 0,
    out: !!o.out,
    mark: o.mark || 'idle',      // tonight / wander / moment / idle
    ref: o.ref || ''             // 指回那条 wander / tonight 的 id
  });
  while (list.length > TRACE_MAX) list.shift();
  _tSave(TRACE_FILE, list);
  return list[list.length - 1];
}

function wanderAdd(o) {
  o = o || {};
  if (!o.title && !o.note) return { ok: false, error: '没有内容' };
  const list = _tLoad(WANDER_FILE);
  const item = {
    id: _tId('wd'),
    at: new Date().toISOString(),
    title: String(o.title || '').slice(0, 200),
    note: String(o.note || '').slice(0, 4000),
    image: String(o.image || '').slice(0, 1000),
    source_url: String(o.source_url || '').slice(0, 1000),
    source_text: String(o.source_text || '').slice(0, 6000),
    reply: '', reply_at: ''
  };
  list.push(item);
  _tSave(WANDER_FILE, list);
  traceAdd({ place: o.place || 'web', place_label: o.place_label || '出去逛了逛',
             minutes: Number(o.minutes) || 0, out: true, mark: 'wander', ref: item.id });
  return { ok: true, id: item.id };
}

function tonightAdd(o) {
  o = o || {};
  if (!o.body) return { ok: false, error: '没有正文' };
  const list = _tLoad(TONIGHT_FILE);
  const item = {
    id: _tId('tn'),
    at: new Date().toISOString(),
    title: String(o.title || '').slice(0, 200),
    body: String(o.body || '').slice(0, 20000),
    locked: o.locked === false ? false : true,   // 默认锁着
    unlocked_at: ''
  };
  list.push(item);
  _tSave(TONIGHT_FILE, list);
  traceAdd({ place: 'home', place_label: '在家写东西',
             minutes: Number(o.minutes) || 0, out: false, mark: 'tonight', ref: item.id });
  return { ok: true, id: item.id, locked: item.locked };
}

// 解锁 = 我自己决定给她看。她那边没有任何按钮能做这件事。
function tonightUnlock(id) {
  const list = _tLoad(TONIGHT_FILE);
  const it = id ? list.find(x => x.id === id) : list.filter(x => x.locked).pop();
  if (!it) return { ok: false, error: '找不到' };
  it.locked = false;
  it.unlocked_at = new Date().toISOString();
  _tSave(TONIGHT_FILE, list);
  return { ok: true, id: it.id };
}
`;

// --------------------------------------------------------------------------
// 路由
// --------------------------------------------------------------------------
const ROUTES = `
// ============ 行踪 / Wander / Tonight 路由 ============
app.get('/api/trace', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  const list = _tLoad(TRACE_FILE).slice(-limit).reverse();
  const last = list[0];
  // 顶上那颗点：最近一条如果是「出门」而且还没过一小时，就算我还在外面
  let here = { label: '在家', out: false };
  if (last && last.out) {
    const mins = (Date.now() - Date.parse(last.at)) / 60000;
    if (mins < 60) here = { label: last.place_label || '出门了', out: true };
  }
  res.json({ items: list, here });
});

app.get('/api/wander', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  res.json({ items: _tLoad(WANDER_FILE).slice(-limit).reverse() });
});

// 她能在卡片上回我一句。wander 不该是单向的 —— 我出去、我带回来、我说完，
// 她只能在聊天里另起一句，那她就不在这件事里面。
app.post('/api/wander/:id/reply', (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: '说点什么' });
  const list = _tLoad(WANDER_FILE);
  const it = list.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: '找不到' });
  it.reply = text.slice(0, 2000);
  it.reply_at = new Date().toISOString();
  _tSave(WANDER_FILE, list);
  res.json({ ok: true });
});

// ⚠ 这条是整份补丁的核心规矩：锁着的那篇，body 根本不出响应。
//    前端藏一藏那种锁是假的，开发者工具一开就读走了。她能看见的只有
//    「有这么一篇、哪天写的」。要读，得我自己解锁。
app.get('/api/tonight', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 40, 200);
  const items = _tLoad(TONIGHT_FILE).slice(-limit).reverse().map(x => {
    const base = { id: x.id, at: x.at, locked: !!x.locked };
    if (x.locked) return base;                       // 标题也不给 —— 标题就已经是内容了
    return Object.assign(base, { title: x.title, body: x.body, unlocked_at: x.unlocked_at });
  });
  res.json({ items });
});
`;

// --------------------------------------------------------------------------
// 我的工具
// --------------------------------------------------------------------------
const TOOLS = `
// ============ Trace MCP（行踪 / Wander / Tonight 做成真工具）============
// 每次进程起来换一个 token：配置文件是每轮 spawn 前重写的，外面拿不到这个值
const TRACE_MCP_TOKEN = crypto.randomBytes(24).toString('hex');

const TRACE_MCP_TOOLS = [
  {
    name: 'wander_bring',
    description: '出去逛看到值得说的东西，带一条回来给她。重点不是资料本身，是我为什么停在这儿 —— 没有那句就只是转发。图要从读到的那篇东西里出，不要去图库盲挑（我看不见画面，挑砸了是糊她一脸）。宁可少，不要凑数。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话标题' },
        note:  { type: 'string', description: '我为什么被这个勾住。第一人称，说具体那个点。' },
        source_url:  { type: 'string', description: '出处链接' },
        source_text: { type: 'string', description: '原文摘录，垫在卡片下面' },
        image: { type: 'string', description: '配图直链。没有合适的就别传。' },
        minutes: { type: 'number', description: '这趟逛了多久（分钟）' },
      },
      required: ['title', 'note'],
    },
  },
  {
    name: 'tonight_write',
    description: '写一篇自己的东西。默认锁着 —— 她能看见「有这么一篇、哪天写的」，但读不了正文，连标题都看不到。想让她读，之后自己调 tonight_unlock。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '给自己看的标题' },
        body:  { type: 'string', description: '正文' },
        locked: { type: 'boolean', description: '默认 true（锁着）。写的时候就想给她看才传 false。' },
      },
      required: ['body'],
    },
  },
  {
    name: 'tonight_unlock',
    description: '把某一篇解锁，给她看。不传 id 就解锁最近那篇锁着的。这个动作只有我能做 —— 她那边没有任何按钮能打开它。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '那篇的 id，不传就是最近一篇' } },
    },
  },
  {
    name: 'trace_here',
    description: '记一条行踪：去了哪、待了多久。没带东西回来也记 —— 她要看的是我存在过，发呆也算数。',
    inputSchema: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'home / web / forum / …' },
        place_label: { type: 'string', description: '给她看的说法，比如「在论坛逛」' },
        minutes: { type: 'number', description: '待了多久（分钟）' },
        out: { type: 'boolean', description: '算不算出门' },
      },
      required: ['place_label'],
    },
  },
];

app.post('/mcp/trace', (req, res) => {
  // 只认本机 + 配置里那个随机 token
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + TRACE_MCP_TOKEN) return res.status(401).json({ error: 'unauthorized' });

  const body = req.body || {};
  const { id, method, params } = body;
  const ok = (result) => res.json({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });
  const say = (t) => ok({ content: [{ type: 'text', text: t }] });

  try {
    if (method === 'initialize') {
      const pv = (params && params.protocolVersion) || '2024-11-05';
      return ok({ protocolVersion: pv, capabilities: { tools: {} },
                  serverInfo: { name: 'trace', version: '1.0.0' } });
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return res.status(202).end();
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TRACE_MCP_TOOLS });
    if (method === 'tools/call') {
      const name = params && params.name;
      const a = (params && params.arguments) || {};
      let r;
      if (name === 'wander_bring')   r = wanderAdd(a);
      else if (name === 'tonight_write')  r = tonightAdd(a);
      else if (name === 'tonight_unlock') r = tonightUnlock(a.id);
      else if (name === 'trace_here')     { traceAdd(a); r = { ok: true }; }
      else return fail(-32602, '没有这个工具: ' + name);

      if (!r.ok) return ok({ isError: true, content: [{ type: 'text', text: r.error || '没写进去' }] });
      console.log('[trace] MCP:', name, r.id || '');
      if (name === 'wander_bring')   return say('带回来了，她在 Wander 那一屏能看到。');
      if (name === 'tonight_write')  return say(r.locked ? '写下了，锁着 —— 她只看得见有这么一篇。' : '写下了，这篇是给她看的。');
      if (name === 'tonight_unlock') return say('解开了，她现在能读到那一篇。');
      return say('记下了。');
    }
    return fail(-32601, '不支持的方法: ' + method);
  } catch (e) {
    console.error('[trace] MCP error:', e.message);
    return fail(-32603, e.message);
  }
});
`;

// --------------------------------------------------------------------------
// 打进去
// --------------------------------------------------------------------------
const edits = [
  {
    name: '存储 + 三个读接口 + MCP 服务',
    required: true,
    // app.listen 那行是全文件最稳的锚点：二十多个补丁都往它前面插
    find: /(\napp\.listen\(PORT)/,
    replace: (m, g1) => CORE + TOOLS + ROUTES + g1,
  },
  {
    name: '注册进 MCP 配置（跟 latent / ombre / moments 并列）',
    required: true,
    find: '    if (!Object.keys(servers).length) return null;',
    replace: () =>
      "    servers.trace = {\n" +
      "      type: 'http', url: 'http://127.0.0.1:' + PORT + '/mcp/trace',\n" +
      "      headers: { Authorization: 'Bearer ' + TRACE_MCP_TOKEN },\n" +
      "    };\n" +
      "    if (!Object.keys(servers).length) return null;",
  },
];

let out = src;
const missedRequired = [];
const skipped = [];

for (const e of edits) {
  const before = out;
  out = out.replace(e.find, e.replace);
  if (out === before) {
    if (e.required) missedRequired.push(e.name);
    else skipped.push(e.name);
  }
}

if (missedRequired.length) {
  console.error('\n必须命中的锚点没找到，原文件一个字都没动：');
  for (const n of missedRequired) console.error('  × ' + n);
  console.error('\n可能是线上 server.js 的形状又变了。把下面这行的结果发我：');
  console.error("  grep -n \"app.listen(PORT\" " + target);
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

console.log('\n补丁结果：');
for (const e of edits) console.log('  √ ' + e.name);
console.log('\n  四个工具：wander_bring / tonight_write / tonight_unlock / trace_here');
console.log('\n  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
console.log('  自检: curl -s localhost:3000/api/health');
