#!/usr/bin/env node
/* 第五个补丁：同步失败的记忆会自己补上。

   踩到的实情：往 OB 写记忆时超时 abort，并不代表没写成功 —— OB 那边其实
   已经存好了，只是回执回来得太慢，客户端先放弃了。于是记忆明明在 OB 里，
   本地却标着 obSynced:false，而且再也没有第二次机会。

   两个改动：
     1) 写超时从 60 秒放宽到 120 秒，少一点误判
     2) 服务启动时、以及每次存记忆时，把还没同步的顺手补一遍
        （OB 对相同内容会合并，所以重复补是安全的，不会长出两条）

   用法：curl -fsSL .../deploy/fix-sync-retry.js | sudo node -
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

if (!s.includes('rememberIntoProfile')) {
  console.error('这个 server.js 还没打 fix-memory-sync.js，先跑那个。');
  process.exit(1);
}
if (s.includes('resyncPendingMemories')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

// 1) 写超时放宽
edit('写超时 60s → 120s',
  /if \(!timeoutMs\) timeoutMs = \/\^\(hold\|grow\|anchor\|feel\|letter_write\|dream\)\$\/\.test\(tool\) \? 60000 : 15000;/,
  () => `if (!timeoutMs) timeoutMs = /^(hold|grow|anchor|feel|letter_write|dream)$/.test(tool) ? 120000 : 15000;`);

// 2) 补同步函数
edit('新增补同步函数',
  /function rememberIntoProfile\(content, source\) \{/,
  () => `// 把还没确认同步的记忆补进 OB —— 先查再写。
// 关键实情：写 OB 超时 abort 不代表没写成功，OB 那边往往已经存好了，只是回执太慢。
// 所以直接重写既慢又可能撞上"内容已存在要合并"的更慢路径（实测 120 秒都不够）。
// 先用 breath_search 查一下：查到就说明本来就在，只是标记没更新，直接改标记即可。
let _resyncing = false;
async function resyncPendingMemories() {
  if (_resyncing) return;
  const pending = (profile.savedMemories || []).filter(m => !m.obSynced && m.content && m.content.trim());
  if (!pending.length) return;
  _resyncing = true;
  try {
    for (const m of pending) {
      const mark = () => {
        const hit = (profile.savedMemories || []).find(x => x.id === m.id);
        if (hit) { hit.obSynced = true; saveProfileFile(); }
      };
      try {
        const probe = m.content.trim().slice(0, 24);
        const found = await obCall('breath_search', { query: m.content.trim().slice(0, 60) }, 25000);
        if (found && found.includes(probe)) {
          mark();
          console.log('[profile] OB 里已有，补标记:', probe);
          continue;
        }
        if (await obCall('hold', { content: m.content, importance: 7 })) {
          mark();
          console.log('[profile] 补同步成功:', probe);
        }
      } catch (e) { console.error('[profile] 补同步失败:', e.message); }
    }
  } finally { _resyncing = false; }
}

function rememberIntoProfile(content, source) {`);

// 3) 存记忆时顺手补
edit('存记忆后顺手补同步',
  /(app\.post\('\/api\/profile\/memory', async \(req, res\) => \{[\s\S]*?\} catch \(e\) \{ console\.error\('\[profile\] 同步 OB 失败:', e\.message\); \})/,
  (m) => m[1] + `
  resyncPendingMemories();`);

// 4) 启动时补一次（延后 20 秒，避开 OB 首次连接）
edit('启动时补一次',
  /app\.listen\(PORT, '0\.0\.0\.0', \(\) => \{/,
  () => `setTimeout(() => { resyncPendingMemories(); }, 20000);

app.listen(PORT, '0.0.0.0', () => {`);

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
const bak = path + '.bak-retry-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端。没同步上的记忆会在启动 20 秒后自动补写。');
