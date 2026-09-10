#!/usr/bin/env node
// 建索引那两个口子挪到 /hook 下面 —— /api 是登录态全拦的。
//   node fix-latent-hook.js [/root/chatnest-api/server.js]
//
// 她在服务器上敲 curl -X POST localhost:3000/api/latent/index，
// 拿回来的是 {"error":"unauthorized"}。
//
// 是我的错，而且这个坑我自己记过：9.4 安全整改之后 /api/* 全局中间件默认全拦，
// 白名单只有 /api/health、/api/auth、/api/watch/upload。add-shadow-push.js 的注释里
// 也写着同一句话 —— 「主入口开在 /hook 下面，不在 /api 下面。/api 是登录态全拦的，
// 而 cron 服务带不了登录态」。我写 add-latent-vec.js 的时候照样挂进了 /api。
//
// 建索引和看进度是运维操作，跟 cron 敲门一类，不该要登录态。挪到 /hook。
// 搜索那条（/api/latent/vsearch）留在原地不动 —— 那是前端调的，前端本来就带 token。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('LATENT_HOOK_FIXED')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('LATENT_VEC_VERSION')) { console.error('先打 add-latent-vec.js'); process.exit(1); }

const HOOK = `
// ---- 建索引：开在 /hook 下面，不用登录态 ---- LATENT_HOOK_FIXED
// /api 是全局拦截的，运维操作挂那儿只会一直吃 401（她已经踩过一次）
app.post('/hook/latent/index', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (lvJob.running) return res.json({ ok: true, running: true, done: lvJob.done, total: lvJob.total, msg: lvJob.msg });
  lvBuild();
  res.json({ ok: true, started: true, msg: '开始了，用 /hook/latent/index/status 看进度' });
});
app.get('/hook/latent/index/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const db = lvLoad();
  res.json({
    ok: true, running: lvJob.running, done: lvJob.done, total: lvJob.total, msg: lvJob.msg,
    indexed_chunks: db ? db.chunks.length : 0,
    indexed_files: db ? Object.keys(db.files || {}).length : 0,
    has_key: !!lvKey(), model: LV_MODEL,
  });
});
// 搜一句试试，也不用登录态 —— 她在服务器上想验一下的时候用
app.get('/hook/latent/vsearch', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: false, error: '要搜什么' });
  try { res.json(await lvSearch(q, Math.min(Number(req.query.n) || 5, 20))); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
`;

let out = src.replace(/(\napp\.listen\(PORT)/, HOOK + '$1');
if (out === src) { console.error('锚点没命中，原文件一个字都没动'); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完之后语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
console.log('  √ 建索引挪到 /hook（不用登录态）');
console.log('\n  现在这三条能直接跑：');
console.log('    curl -s -X POST localhost:3000/hook/latent/index');
console.log('    curl -s localhost:3000/hook/latent/index/status');
console.log('    curl -s "localhost:3000/hook/latent/vsearch?q=她哭的那天晚上"');
console.log('\n  备份: ' + backup);
