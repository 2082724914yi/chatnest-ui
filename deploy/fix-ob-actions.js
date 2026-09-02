#!/usr/bin/env node
/* 第十四个补丁：详情页那排按钮（钉选 / Anchor / 已解决 / 归档 / 遗忘）点了没反应，
   还有状态栏永远显示「0 钉选 · 0 feel · 0 已解决」。

   两处都是后端的问题：

   1) 动作路由走的是 Dashboard 的 REST（/api/bucket/:id/pin 之类），
      而 OB 根本没有这些路径 —— 404。回退的 PATCH 也不通。
      更糟的是最后一律 res.json({ok:true})，所以前端弹"已钉选"，实际什么都没发生。
      「标记已解决」调的是 trace(bucket_id) 却没传 resolved，等于空跑；
      「归档」调的是 grow（那是整理记忆的工具，跟归档没关系）；
      「主动遗忘」映射到 release（那只是解除 anchor）。
      全部改成走 MCP 的 trace / anchor / release，参数按 OB 文档给对。

   2) /api/ombre-dashboard/status 只回了 total / permanent / dynamic / archived，
      而前端状态栏要读的是 pinned / feel / resolved —— 后端从来没给过，所以恒为 0。
      现在顺带把桶列表拉一次，把这几个数真的算出来，
      再把 plan / letter 的条数也带上。

   另外 normalizeBucket 补上 weight / score（网页上排序用的那个权重），
   前端就能按跟网页一样的顺序排。

   用法：curl -fsSL .../deploy/fix-ob-actions.js | sudo node -
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

if (!s.includes("app.post('/api/ombre-dashboard/buckets/:id/action'")) {
  console.error('这个 server.js 里没有动作路由，先跑前面的补丁。');
  process.exit(1);
}
if (s.includes('OB_ACTIONS')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

// 1) normalizeBucket 带上权重
edit('记忆带上权重',
  /    activationCount: Number\(b\.activation_count \?\? meta\.activation_count \?\? 0\),/,
  () => `    activationCount: Number(b.activation_count ?? meta.activation_count ?? 0),
    // 网页上排序用的那个权重，前端跟着它排就跟网页一个顺序
    weight: Number.isFinite(Number(b.weight ?? b.score ?? meta.weight ?? meta.score)) ? Number(b.weight ?? b.score ?? meta.weight ?? meta.score) : null,`);

// 2) status 真的把 pinned / feel / resolved 算出来
edit('状态栏数字算准',
  /    const buckets = data\?\.buckets \|\| \{\};\n    res\.json\(\{\n      available: true, version: data\?\.version \|\| null,\n      total: Number\(buckets\.total \?\? data\?\.total \?\? 0\),\n      permanent: Number\(buckets\.permanent \?\? 0\),\n      dynamic: Number\(buckets\.dynamic \?\? 0\),\n      archived: Number\(buckets\.archive \?\? buckets\.archived \?\? 0\),\n    \}\);/,
  () => `    const buckets = data?.buckets || {};
    // 前端状态栏要的是 pinned / feel / resolved，/api/status 不给，
    // 所以顺手把桶列表拉一次自己数。数不出来就退回 0，不影响其它数字。
    let counted = {};
    try {
      const r2 = await dashRequest('/api/buckets');
      const list = (Array.isArray(r2.data) ? r2.data : r2.data?.buckets || r2.data?.items || []).map(normalizeBucket);
      if (list.length) {
        const byType = t => list.filter(i => String(i.type).toLowerCase() === t).length;
        counted = {
          listed: list.length,
          pinned: list.filter(i => i.pinned).length,
          resolved: list.filter(i => i.resolved).length,
          digested: list.filter(i => i.digested).length,
          feel: list.filter(i => String(i.type).toLowerCase() === 'feel' || (i.domains || []).includes('feel')).length,
          plan: byType('plan'),
          letter: byType('letter'),
        };
      }
    } catch (e) { console.log('[OB Dashboard] 数桶失败（不影响主状态）:', e.message); }
    res.json({
      available: true, version: data?.version || null,
      total: Number(buckets.total ?? data?.total ?? 0),
      permanent: Number(buckets.permanent ?? 0),
      dynamic: Number(buckets.dynamic ?? 0),
      archived: Number(buckets.archive ?? buckets.archived ?? 0),
      ...counted,
    });`);

// 3) 动作路由整个换掉：走 MCP 的 trace / anchor / release
s = s.replace('// Dashboard API: bucket actions (pin/unpin/archive via Dashboard REST)\n', '');
const OLD_ACTION_START = s.indexOf("app.post('/api/ombre-dashboard/buckets/:id/action'");
const OLD_ACTION_END = s.indexOf("\n});", s.indexOf("[OB Action]", OLD_ACTION_START));
if (OLD_ACTION_START < 0 || OLD_ACTION_END < 0) {
  console.error('定位不到动作路由的范围，原文件未改动。');
  process.exit(1);
}
const NEW_ACTION = `// 这些动作全部走 MCP 的 trace/anchor/release —— Dashboard 没有对应的 REST，
// 以前打过去全是 404，然后还照样回 ok:true，所以点了"没反应"。
// 参数按 OB 文档：pinned/resolved/digested 用 1/0，归档用 delete=true（只移进档案，不物理删）。
const OB_ACTIONS = {
  pin:       (id) => ['trace', { bucket_id: id, pinned: 1 }],
  // 解除最后一层保护时 OB 要求同一次调用里显式给回 importance
  unpin:     (id, b) => ['trace', { bucket_id: id, pinned: 0, importance: impOr(b, 7) }],
  protect:   (id) => ['trace', { bucket_id: id, protected: 1 }],
  unprotect: (id, b) => ['trace', { bucket_id: id, protected: 0, importance: impOr(b, 7) }],
  resolve:   (id) => ['trace', { bucket_id: id, resolved: 1 }],
  unresolve: (id) => ['trace', { bucket_id: id, resolved: 0 }],
  digest:    (id) => ['trace', { bucket_id: id, digested: 1 }],
  undigest:  (id) => ['trace', { bucket_id: id, digested: 0 }],
  anchor:    (id) => ['anchor', { bucket_id: id }],
  release:   (id) => ['release', { bucket_id: id }],
  archive:   (id, b) => ['trace', { bucket_id: id, delete: true, delete_reason: b.reason || '小懿在前端归档' }],
  forget:    (id, b) => ['trace', { bucket_id: id, delete: true, delete_reason: b.reason || '小懿在前端选择遗忘' }],
  restore:   (id) => ['trace', { bucket_id: id, restore: true }],
};
function impOr(body, def) {
  const n = parseInt(body && body.importance, 10);
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : def;
}

app.post('/api/ombre-dashboard/buckets/:id/action', async (req, res) => {
  const body = req.body || {};
  const action = String(body.action || '');
  const id = req.params.id;
  if (!id) return res.status(400).json({ ok: false, message: 'bucket_id required' });
  const make = OB_ACTIONS[action];
  if (!make) return res.status(400).json({ ok: false, message: '不认识的动作: ' + action });
  try {
    const [tool, args] = make(id, body);
    const result = await obCall(tool, args, 60000);
    const w = obWriteResult(result);
    console.log(\`[OB Action] \${action} -> \${tool}\`, w.ok ? 'ok' : '失败: ' + w.message);
    res.status(w.ok ? 200 : 502).json({ ...w, action, tool });
  } catch (e) {
    console.error(\`[OB Action] \${action} 出错:\`, e.message);
    res.status(500).json({ ok: false, action, message: e.message });
  }
});`;
s = s.slice(0, OLD_ACTION_START) + NEW_ACTION + s.slice(OLD_ACTION_END + 4);
log.push(['√', '动作路由整个换掉', '']);

// ---- 报告 ----
console.log('\n补丁结果：');
for (const [mark, label, note] of log) console.log(`  ${mark} ${label}${note ? '  — ' + note : ''}`);

if (failed) {
  console.error(`\n有 ${failed} 处没打上，原文件未改动。把上面的输出发回来。`);
  process.exit(1);
}
if (!s.includes('OB_ACTIONS') || !/obWriteResult/.test(s)) {
  console.error('\n替换结果不对（缺 OB_ACTIONS 或 obWriteResult），原文件未改动。先跑 fix-ob-write-result.js。');
  process.exit(1);
}
try {
  new (require('vm').Script)(s, { filename: 'patched' });
} catch (e) {
  console.error('\n补丁后语法有问题，原文件未改动：', e.message);
  process.exit(1);
}
const bak = path + '.bak-obact-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端。详情页那排按钮会真的生效，状态栏的钉选/feel/已解决也不再是 0。');
