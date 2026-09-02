#!/usr/bin/env node
/* 第十六个补丁：前端要能把 OB 的工具都用起来，后端这几个入口得放行参数。

   记忆页新加了「工具台」（标题栏那个 🧰），十几个工具都能在前端跑并显示 OB 的原话。
   但后端这两个入口把参数丢了：
     · /api/ombre/trace 只透传 bucket_id —— resolved / pinned / importance / content
       全被丢掉，等于调了个空的
     · 搜索只走 OB 的 /api/search（按正文/语义），搜标签搜不到

   顺带把 /api/ombre-dashboard/search 改成：OB 的结果 + 标签/主题域/标题命中的，
   合并去重，所以搜「家庭」这种标签也能搜出来。

   用法：curl -fsSL .../deploy/fix-ob-toolbench.js | sudo node -
   安全：先备份，全部命中才写入，写入前语法校验，可重复执行。 */
const fs = require('fs');
const path = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(path)) { console.error('找不到文件:', path); process.exit(1); }
let s = fs.readFileSync(path, 'utf8');
const orig = s;
const log = [];
let failed = 0;

function edit(label, re, make) {
  const m = s.match(re);
  if (!m) { log.push(['×', label, '没匹配到']); failed++; return; }
  const all = s.match(new RegExp(re.source, re.flags.replace('g', '') + 'g'));
  if (all && all.length > 1) { log.push(['×', label, `匹配到 ${all.length} 处，不敢动`]); failed++; return; }
  s = s.replace(re, make(m));
  log.push(['√', label, '']);
}

if (!s.includes("app.post('/api/ombre/trace'")) {
  console.error('这个 server.js 里没有 /api/ombre/trace，先跑前面的补丁。');
  process.exit(1);
}
if (s.includes('TRACE_PASSTHROUGH')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

// 1) trace 放行该放行的字段
edit('trace 透传参数',
  /app\.post\('\/api\/ombre\/trace', async \(req, res\) => \{\n  const \{ bucket_id \} = req\.body;\n  if \(!bucket_id\) return res\.status\(400\)\.json\(\{ error: 'bucket_id required' \}\);\n  const result = await obCall\('trace', \{ bucket_id \}\);\n  res\.json\(\{ ok: !!result, result \}\);\n\}\);/,
  () => `// trace 能改的字段不止 bucket_id，以前全被丢掉，等于调了个空的
const TRACE_PASSTHROUGH = ['resolved', 'pinned', 'protected', 'digested', 'dont_surface', 'importance',
  'content', 'name', 'tags', 'domain', 'why_remembered', 'status', 'weight', 'valence', 'arousal',
  'delete', 'delete_reason', 'restore'];

app.post('/api/ombre/trace', async (req, res) => {
  const body = req.body || {};
  if (!body.bucket_id) return res.status(400).json({ ok: false, message: 'bucket_id required' });
  const args = { bucket_id: String(body.bucket_id) };
  for (const k of TRACE_PASSTHROUGH) {
    const v = body[k];
    if (v === undefined || v === null || v === '') continue;
    args[k] = v;
  }
  const result = await obCall('trace', args, 60000);
  const w = obWriteResult(result);
  if (!w.ok) console.log('[OB] trace 没改成:', w.message);
  res.status(w.ok ? 200 : 502).json({ ...w, result });
});`);

// 2) 搜索也能搜到标签
edit('搜索加上标签命中',
  /    const raw = Array\.isArray\(data\) \? data : data\?\.results \|\| data\?\.items \|\| data\?\.buckets \|\| \[\];\n    const items = raw\.map\(normalizeBucket\);\n    res\.json\(\{ items, total: items\.length, query \}\);/,
  () => `    const raw = Array.isArray(data) ? data : data?.results || data?.items || data?.buckets || [];
    const items = raw.map(normalizeBucket);
    // OB 的搜索按正文/语义走，搜不到标签。所以再拿全量桶按标签/主题域/标题匹配一遍，合并去重。
    try {
      const r2 = await dashRequest('/api/buckets');
      const all = (Array.isArray(r2.data) ? r2.data : r2.data?.buckets || r2.data?.items || []).map(normalizeBucket);
      const q = query.toLowerCase();
      const seen = new Set(items.map(i => i.id));
      for (const it of all) {
        if (seen.has(it.id)) continue;
        const hay = [...(it.tags || []), ...(it.domains || []), it.name || ''].join(' ').toLowerCase();
        if (hay.includes(q)) { items.push(it); seen.add(it.id); }
      }
    } catch (e) { console.log('[OB Dashboard] 标签匹配失败（只用 OB 的结果）:', e.message); }
    res.json({ items, total: items.length, query });`);

// ---- 报告 ----
console.log('\n补丁结果：');
for (const [mark, label, note] of log) console.log(`  ${mark} ${label}${note ? '  — ' + note : ''}`);

if (failed) {
  console.error(`\n有 ${failed} 处没打上，原文件未改动。把上面的输出发回来。`);
  process.exit(1);
}
try {
  new (require('vm').Script)(s, { filename: 'patched' });
} catch (e) {
  console.error('\n补丁后语法有问题，原文件未改动：', e.message);
  process.exit(1);
}
const bak = path + '.bak-bench-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端。工具台里的 trace 会真的改到记忆，搜索也能搜标签了。');
