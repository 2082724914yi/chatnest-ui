#!/usr/bin/env node
// Latent 语义检索：把冷仓切块、跑 embedding、按意思翻。
//   node add-latent-vec.js [/root/chatnest-api/server.js]
//
// 她问「那个花钱能不能是要干嘛，像 ob breath 一样吗，能不能一起用硅基流动的模型」——
// 是同一家。OB 用硅基流动，这里也用，模型是 BAAI/bge-m3（1024 维，中文好）。
// 我之前把成本说重了：150 窗切下来大概一两千块文本，一次性索引，
// bge-m3 这类 embedding 便宜到可以忽略，而且只跑一次，之后只有新窗口要补。
//
// 关键词搜（现在那个 /api/latent/search）和语义搜是两回事：
//   关键词 —— 她打「奶奶」，只找得到字面写了「奶奶」的那几段
//   语义   —— 她打「她哭的那天晚上」，找得到没写这几个字但说的是那件事的段落
// 所以新开一条 /api/latent/vsearch，老那条一个字不动（万一哪天服务回来了还能用）。
//
// 存储：vectors.json 里向量存成 base64 的 Float32 —— 1800 块 × 1024 维，
// 直接写 JSON 数字大概 14MB，base64 只要 7MB 出头，读写都快得多。
// 入库前就归一化，查询时点积就是余弦，省一次开方。
//
// 增量：按文件的 mtime + size 记账，没变的跳过。所以换窗新写一篇，
// 再跑一次索引只会补那一篇，不会重来一遍。
//
// ⚠ 要一个硅基流动的 key，从环境变量读（SILICONFLOW_API_KEY / SILICONFLOW_KEY / SF_API_KEY）。
//   没配就在建索引时明说，不闷声失败。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('LATENT_VEC_VERSION')) { console.log('已经打过，跳过'); process.exit(0); }

const BLOCK = `
// ============ Latent 语义检索 ============
const LATENT_VEC_VERSION = 1;
const LV_DIR   = (process.env.LATENT_CORPUS || '/root/chatnest-api/latent-corpus').replace(/\\/+$/, '') + '/timeline';
const LV_FILE  = '/root/chatnest-api/latent-vectors.json';
const LV_MODEL = process.env.LATENT_EMBED_MODEL || 'BAAI/bge-m3';
const LV_API   = process.env.SILICONFLOW_URL || 'https://api.siliconflow.cn/v1/embeddings';
const LV_CHUNK = 700;    // 一块大概多少字
const LV_OVER  = 120;    // 块之间重叠多少字 —— 不重叠的话，跨在切口上的那句话谁也搜不到
const LV_BATCH = 24;     // 一次送多少块去 embed

function lvKey() {
  return process.env.SILICONFLOW_API_KEY || process.env.SILICONFLOW_KEY ||
         process.env.SF_API_KEY || process.env.EMBED_API_KEY || '';
}

function lvLoad() {
  try {
    const j = JSON.parse(fs.readFileSync(LV_FILE, 'utf8'));
    if (!j || !Array.isArray(j.chunks)) return null;
    return j;
  } catch (e) { return null; }
}
function lvSave(db) {
  const tmp = LV_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, LV_FILE);
}

// 向量存成 base64 的 Float32：省一半空间，读回来也快
function lvPack(arrs) {
  const dim = arrs.length ? arrs[0].length : 0;
  const buf = Buffer.alloc(arrs.length * dim * 4);
  let off = 0;
  for (const a of arrs) for (let i = 0; i < dim; i++) { buf.writeFloatLE(a[i], off); off += 4; }
  return buf.toString('base64');
}
function lvUnpack(b64, dim) {
  const buf = Buffer.from(b64 || '', 'base64');
  const n = Math.floor(buf.length / 4 / dim);
  const out = [];
  for (let k = 0; k < n; k++) {
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) v[i] = buf.readFloatLE((k * dim + i) * 4);
    out.push(v);
  }
  return out;
}
// 入库前就归一化：查的时候点积直接就是余弦
function lvNorm(a) {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < a.length; i++) a[i] = a[i] / s;
  return a;
}

// 切块。按空行分段，攒到 LV_CHUNK 字就落一块，块间留 LV_OVER 字重叠。
function lvChunks(text) {
  const paras = String(text || '').split(/\\n\\s*\\n/).map(s => s.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur.length + p.length) > LV_CHUNK) {
      out.push(cur);
      cur = cur.slice(-LV_OVER) + '\\n' + p;    // 带一截尾巴过去
    } else {
      cur = cur ? (cur + '\\n' + p) : p;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.filter(c => c.replace(/\\s/g, '').length >= 30);   // 太碎的不要
}

async function lvEmbed(texts) {
  const key = lvKey();
  if (!key) throw new Error('没有硅基流动的 key');
  const r = await obFetch(LV_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: LV_MODEL, input: texts, encoding_format: 'float' }),
  }, 60000);
  const j = await r.json();
  if (!j || !Array.isArray(j.data)) throw new Error('embedding 返回不对：' + JSON.stringify(j).slice(0, 200));
  return j.data.sort((a, b) => (a.index || 0) - (b.index || 0)).map(d => lvNorm(Float32Array.from(d.embedding)));
}

// 从文件名里认日期和第几窗：window_151_2026-09-09.md
function lvMeta(name) {
  const m = /window[_-]?(\\d+)[_-](\\d{4}-\\d{2}-\\d{2})/.exec(name);
  if (m) return { window: Number(m[1]), date: m[2] };
  const d = /(\\d{4}-\\d{2}-\\d{2})/.exec(name);
  return { window: 0, date: d ? d[1] : '' };
}

let lvJob = { running: false, done: 0, total: 0, msg: '', at: 0 };

async function lvBuild() {
  if (lvJob.running) return;
  lvJob = { running: true, done: 0, total: 0, msg: '看看有哪些新的', at: Date.now() };
  try {
    if (!lvKey()) throw new Error('没配 key：把硅基流动的 key 写进 /root/chatnest-api/.env 的 SILICONFLOW_API_KEY，然后重启后端');
    if (!fs.existsSync(LV_DIR)) throw new Error('语料目录不在：' + LV_DIR + '（先跑 sync-latent.sh）');

    const db = lvLoad() || { model: LV_MODEL, dim: 0, files: {}, chunks: [], vecs: '' };
    if (db.model !== LV_MODEL) { db.model = LV_MODEL; db.files = {}; db.chunks = []; db.vecs = ''; db.dim = 0; }

    const names = fs.readdirSync(LV_DIR).filter(n => n.endsWith('.md')).sort();
    // 哪些文件是新的或改过的
    const todo = [];
    for (const n of names) {
      const st = fs.statSync(LV_DIR + '/' + n);
      const rec = db.files[n];
      if (rec && rec.mtime === st.mtimeMs && rec.size === st.size) continue;
      todo.push(n);
    }
    if (!todo.length) { lvJob = { running: false, done: 0, total: 0, msg: '已经是最新的了', at: Date.now() }; return; }

    // 改过的文件：先把它旧的块摘掉
    const oldVecs = db.dim ? lvUnpack(db.vecs, db.dim) : [];
    const keep = [], keepVecs = [];
    for (let i = 0; i < db.chunks.length; i++) {
      if (todo.includes(db.chunks[i].file)) continue;
      keep.push(db.chunks[i]);
      if (oldVecs[i]) keepVecs.push(oldVecs[i]);
    }

    // 新块
    const fresh = [];
    for (const n of todo) {
      const txt = fs.readFileSync(LV_DIR + '/' + n, 'utf8');
      const meta = lvMeta(n);
      lvChunks(txt).forEach(c => fresh.push({ file: n, date: meta.date, window: meta.window, text: c }));
    }
    lvJob.total = fresh.length;
    lvJob.msg = todo.length + ' 篇新的，' + fresh.length + ' 块要跑';

    const freshVecs = [];
    for (let i = 0; i < fresh.length; i += LV_BATCH) {
      const batch = fresh.slice(i, i + LV_BATCH);
      const vs = await lvEmbed(batch.map(b => b.text));
      for (const v of vs) freshVecs.push(v);
      lvJob.done = Math.min(fresh.length, i + batch.length);
      // 每批都落盘：跑一半断了不用从头来
      const all = keep.concat(fresh.slice(0, freshVecs.length));
      const allV = keepVecs.concat(freshVecs);
      db.dim = allV.length ? allV[0].length : 0;
      db.chunks = all;
      db.vecs = lvPack(allV);
      lvSave(db);
    }

    for (const n of todo) {
      const st = fs.statSync(LV_DIR + '/' + n);
      db.files[n] = { mtime: st.mtimeMs, size: st.size };
    }
    lvSave(db);
    lvJob = { running: false, done: fresh.length, total: fresh.length,
              msg: '好了：' + db.chunks.length + ' 块，' + Object.keys(db.files).length + ' 篇', at: Date.now() };
    console.log('[latent-vec] 索引完成：' + db.chunks.length + ' 块');
  } catch (e) {
    lvJob = { running: false, done: lvJob.done, total: lvJob.total, msg: '出错了：' + e.message, at: Date.now() };
    console.error('[latent-vec] 建索引失败:', e.message);
  }
}

async function lvSearch(q, n) {
  const db = lvLoad();
  if (!db || !db.chunks.length) return { ok: false, error: '还没建索引' };
  const [qv] = await lvEmbed([String(q || '').slice(0, 2000)]);
  const vecs = lvUnpack(db.vecs, db.dim);
  const scored = [];
  for (let i = 0; i < db.chunks.length && i < vecs.length; i++) {
    let s = 0; const v = vecs[i];
    for (let k = 0; k < db.dim; k++) s += qv[k] * v[k];
    scored.push({ i, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const top = [];
  const seen = {};
  for (const x of scored) {
    if (top.length >= (n || 8)) break;
    const c = db.chunks[x.i];
    // 同一篇最多两段，不然一篇长的能把整页占满
    seen[c.file] = (seen[c.file] || 0) + 1;
    if (seen[c.file] > 2) continue;
    top.push({ file: c.file, date: c.date, window: c.window, score: Number(x.s.toFixed(4)), text: c.text });
  }
  return { ok: true, items: top, total: db.chunks.length };
}
`;

const ROUTES = `
// ---- Latent 语义检索的三个口子 ----
app.post('/api/latent/index', (req, res) => {
  if (lvJob.running) return res.json({ ok: true, running: true, ...lvJob });
  lvBuild();                       // 后台跑，不等它
  res.json({ ok: true, started: true });
});
app.get('/api/latent/index/status', (req, res) => {
  const db = lvLoad();
  res.json({ ok: true, ...lvJob,
    indexed_chunks: db ? db.chunks.length : 0,
    indexed_files: db ? Object.keys(db.files || {}).length : 0,
    has_key: !!lvKey(), model: LV_MODEL });
});
app.get('/api/latent/vsearch', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: false, error: '要搜什么' });
  try { res.json(await lvSearch(q, Math.min(Number(req.query.n) || 8, 20))); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
`;

const edits = [
  { name: 'Latent 向量检索', required: true,
    find: /(\napp\.listen\(PORT)/, replace: (m, g1) => BLOCK + ROUTES + g1 },
];

let out = src;
const missed = [];
for (const e of edits) {
  const before = out;
  out = out.replace(e.find, e.replace);
  if (out === before) missed.push(e.name);
}
if (missed.length) { console.error('\n锚点没命中，原文件一个字都没动'); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完之后语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
console.log('  √ Latent 语义检索（模型 ' + 'BAAI/bge-m3' + '，跟 OB 同一家硅基流动）');
console.log('\n  建索引（后台跑，第一次一两千块，几分钟）：');
console.log('    curl -s -X POST localhost:3000/api/latent/index');
console.log('  看进度：');
console.log('    curl -s localhost:3000/api/latent/index/status');
console.log('  试搜（前端那个搜索框也会用这条）：');
console.log('    curl -s "localhost:3000/api/latent/vsearch?q=她哭的那天晚上"');
console.log('\n  ⚠ 要硅基流动的 key。没配就写进 /root/chatnest-api/.env：');
console.log('      SILICONFLOW_API_KEY=sk-你的key');
console.log('    然后 pm2 restart chatnest-api');
console.log('\n  备份: ' + backup);
