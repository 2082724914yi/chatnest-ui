#!/usr/bin/env node
/* 第十二个补丁：前端点"保存"永远弹"已保存"，哪怕 OB 其实拒收了。

   obCall 拿回来的是 OB 的一段文字，成功失败都是文字：
     成功  "新建→44683f2ccaa8 感情"
     失败  "feel 必须指向一条原始记忆（source_bucket 不能为空）。"
   而路由一律写 res.json({ ok: !!result })，只要有字就算成功。
   所以那两条被拒的记忆，前端照样弹了"记忆已保存" —— 报错全被吞了。

   这个补丁：
     1) 加 obWriteResult()：从回复里认出 bucket_id（12 位十六进制）和错误措辞，
        给出真实的 ok，并把 OB 原话带回前端
     2) hold / grow / plan / letter-write / anchor 五个写入路由都改用它
     3) 顺便把 bucket_id 回给前端 —— 前端"锚点"要先 hold 再 anchor，
        以前取的是 result.bucket_id（字符串上哪来的字段），永远是空的

   用法：curl -fsSL .../deploy/fix-ob-write-result.js | sudo node -
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

if (!s.includes("app.post('/api/ombre/hold'")) {
  console.error('这个 server.js 里没有 /api/ombre/hold，先跑前面的补丁。');
  process.exit(1);
}
if (s.includes('obWriteResult')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

// 1) 判定函数
edit('新增写入结果判定',
  /app\.post\('\/api\/ombre\/hold', async \(req, res\) => \{/,
  () => `// OB 写入成功失败都返回一段中文，这里把它翻译成前端能用的结果。
// 成功那句一定带 bucket_id（12 位十六进制），失败那句带的是拒收理由。
function obWriteResult(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return { ok: false, bucket_id: null, message: 'OB 没有回应（可能超时）', raw: '' };
  const id = (t.match(/\\b[0-9a-f]{12}\\b/) || [null])[0];
  if (id) return { ok: true, bucket_id: id, message: t.slice(0, 200), raw: t };
  const looksBad = /^\\s*[❌✗]|必须|不能|错误|失败|无效|拒绝|required|invalid/i.test(t);
  return { ok: !looksBad, bucket_id: null, message: t.slice(0, 200), raw: t };
}

app.post('/api/ombre/hold', async (req, res) => {`);

// 2) hold
edit('hold 返回真实结果',
  /  const result = await obCall\('hold', args\);\n  res\.json\(\{ ok: !!result, result \}\);/,
  () => `  const result = await obCall('hold', args);
  const w = obWriteResult(result);
  if (!w.ok) console.log('[OB] hold 没存进去:', w.message);
  res.status(w.ok ? 200 : 502).json({ ...w, result });`);

// 3) grow
edit('grow 返回真实结果',
  /  const result = await obCall\('grow', \{ content \}\);\n  res\.json\(\{ ok: !!result, result \}\);/,
  () => `  const result = await obCall('grow', { content });
  const w = obWriteResult(result);
  if (!w.ok) console.log('[OB] grow 没存进去:', w.message);
  res.status(w.ok ? 200 : 502).json({ ...w, result });`);

// 4) plan
edit('plan 返回真实结果',
  /app\.post\('\/api\/ombre\/plan', async \(req, res\) => \{\n  const result = await obCall\('plan', req\.body \|\| \{\}\);\n  res\.json\(\{ ok: !!result, result \}\);/,
  () => `app.post('/api/ombre/plan', async (req, res) => {
  const { content, weight, why_remembered } = req.body || {};
  if (!content) return res.status(400).json({ ok: false, message: 'content required' });
  // plan 存进不衰减的承诺区，weight 是这个承诺有多重（0-1）
  const args = { content };
  const w0 = Number(weight);
  if (Number.isFinite(w0) && w0 >= 0 && w0 <= 1) args.weight = w0;
  if (why_remembered) args.why_remembered = why_remembered;
  const result = await obCall('plan', args);
  const w = obWriteResult(result);
  if (!w.ok) console.log('[OB] plan 没存进去:', w.message);
  res.status(w.ok ? 200 : 502).json({ ...w, result });`);

// 5) letter_write
edit('letter_write 返回真实结果',
  /  const result = await obCall\('letter_write', args\);\n  res\.json\(\{ ok: !!result, result \}\);/,
  () => `  const result = await obCall('letter_write', args);
  const w = obWriteResult(result);
  if (!w.ok) console.log('[OB] 信没写进去:', w.message);
  res.status(w.ok ? 200 : 502).json({ ...w, result });`);

// 6) anchor
edit('anchor 返回真实结果',
  /app\.post\('\/api\/ombre\/anchor', async \(req, res\) => \{\n  const \{ bucket_id \} = req\.body;\n  if \(!bucket_id\) return res\.status\(400\)\.json\(\{ error: 'bucket_id required' \}\);\n  const result = await obCall\('anchor', \{ bucket_id \}\);\n  res\.json\(\{ ok: !!result, result \}\);/,
  () => `app.post('/api/ombre/anchor', async (req, res) => {
  const { bucket_id } = req.body;
  if (!bucket_id) return res.status(400).json({ ok: false, message: 'bucket_id required' });
  const result = await obCall('anchor', { bucket_id });
  const w = obWriteResult(result);
  if (!w.ok) console.log('[OB] anchor 没打上:', w.message);
  res.status(w.ok ? 200 : 502).json({ ...w, result });`);

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
const bak = path + '.bak-wres-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端。以后前端说"已保存"就是真存进去了，没存进去会把 OB 的原话说出来。');
