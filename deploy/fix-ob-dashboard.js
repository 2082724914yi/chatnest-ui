#!/usr/bin/env node
/* 第十一个补丁：前端 Memory（Ombre 页）一条记忆都不显示。

   实测她的线上后端：
     GET https://api.xiaoyixiaoyan.top/api/ombre-dashboard/status
     → 503 {"available":false,"error":"OMBRE_AUTH_FAILED"}

   前端和代理层其实早就写好了，卡在一处：代理去 OB Dashboard 登录时用的密码不对。
   server.js 里写的是
       DASHBOARD_PASSWORD = process.env.OMBRE_DASHBOARD_PASSWORD || OMBRE_TOKEN
   环境变量没设，就退回 OMBRE_TOKEN（MCP 的 Bearer token）。可这两个是两码事：
   拿 MCP token 去 POST /auth/login，OB 直接回 {"error":"密码错误"}。
   登录失败 → status/buckets/search 全 503 → 页面空白。
   所以"存进去了却看不见"：写入走 MCP 是通的，读取走 Dashboard 是断的。

   这个补丁做四件事（密码本身由 set-ob-password.sh 单独设置，不写进代码）：
     1) 给 server.js 加一个零依赖的 .env 读取器，密码放文件里，不进 pm2 也不进仓库
     2) 去掉"密码没配就拿 MCP token 顶上"的兜底 —— 那只会把真正的原因藏起来
     3) 修 dashRequest：401 重登重试时把 method/body 丢了，PATCH 会退化成 GET
     4) letter_write 补上 author/title —— OB 要 author 才知道这封信是谁写的

   用法：curl -fsSL .../deploy/fix-ob-dashboard.js | sudo node -
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

if (!s.includes('/api/ombre-dashboard/status')) {
  console.error('这个 server.js 里没有 OB Dashboard 代理，不是这台机器的文件？');
  process.exit(1);
}
if (s.includes('loadEnvFile')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

// 1) 零依赖 .env 读取器。放最前面，后面所有 process.env.* 才读得到。
edit('新增 .env 读取器',
  /^const express = require\('express'\);/m,
  () => `// 从 server.js 同目录的 .env 读配置（零依赖，不需要 npm install dotenv）。
// 密码这类东西放文件里，不写进代码、不进 git、不用记在 pm2 的启动参数里。
// 已经存在的环境变量优先，.env 只补没设过的。
function loadEnvFile() {
  try {
    const p = require('path').join(__dirname, '.env');
    if (!require('fs').existsSync(p)) return;
    for (const line of require('fs').readFileSync(p, 'utf8').split('\\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
    console.log('[env] 已读取 .env');
  } catch (e) { console.log('[env] 读 .env 失败:', e.message); }
}
loadEnvFile();

const express = require('express');`);

// 2) 别再拿 MCP token 当 Dashboard 密码顶上，没配就明说没配
edit('密码不再退回 MCP token',
  /const DASHBOARD_PASSWORD = process\.env\.OMBRE_DASHBOARD_PASSWORD \|\| OMBRE_TOKEN;/,
  () => `// Dashboard 密码 ≠ MCP token，两套认证。以前这里退回 OMBRE_TOKEN，
// 结果是每次登录都被 OB 回 "密码错误"，而报错只说 AUTH_FAILED，看不出是没配。
const DASHBOARD_PASSWORD = process.env.OMBRE_DASHBOARD_PASSWORD || '';
if (!DASHBOARD_PASSWORD) console.log('[OB Dashboard] 没有设 OMBRE_DASHBOARD_PASSWORD，记忆页会是空的（跑 set-ob-password.sh 设置）');`);

// 3) cookie：Node 的 headers.get('set-cookie') 会把多条粘成一串，
//    再 split(';')[0] 就只剩第一条的一半。有 getSetCookie 就用它。
edit('cookie 抓取更稳',
  /async function dashLogin\(\) \{/,
  () => `function pickCookie(r) {
  // 多条 Set-Cookie 时 headers.get 会用逗号粘成一串，直接 split(';') 会截断，
  // 所以优先用 Node 18+ 的 getSetCookie()，逐条取 name=value 再拼起来。
  try {
    if (typeof r.headers.getSetCookie === 'function') {
      const all = r.headers.getSetCookie();
      if (all && all.length) return all.map(v => String(v).split(';')[0]).join('; ');
    }
  } catch (e) {}
  const sc = r.headers.get('set-cookie');
  return sc ? String(sc).split(';')[0] : '';
}

async function dashLogin() {`);

edit('登录用 pickCookie',
  /  const sc = r\.headers\.get\('set-cookie'\);\n  if \(sc\) dashCookie = sc\.split\(';'\)\[0\];\n  if \(r\.status >= 400\) throw Object\.assign\(new Error\('OB Dashboard login failed'\)/,
  () => `  const sc = pickCookie(r);
  if (sc) dashCookie = sc;
  if (r.status >= 400) throw Object.assign(new Error('OB Dashboard login failed')`);

// 4) 401 重登重试时把 opts 丢了 —— PATCH 会退化成 GET，"让这条记忆休息"就静默失效
edit('重试保留请求参数',
  /  const sc = r\.headers\.get\('set-cookie'\);\n  if \(sc\) dashCookie = sc\.split\(';'\)\[0\];\n  if \(r\.status === 401 && !retried\) \{\n    dashCookie = '';\n    await ensureDashLogin\(\);\n    return dashRequest\(path, true\);\n  \}/,
  () => `  const sc2 = pickCookie(r);
  if (sc2) dashCookie = sc2;
  if (r.status === 401 && !retried) {
    // 注意要把 opts 一起带上：以前这里只传了 path，
    // 于是 cookie 过期后重试的 PATCH 会变成 GET，动作静默失效。
    dashCookie = '';
    await ensureDashLogin();
    return dashRequest(path, true, opts);
  }`);

// 5) 动作路由把 retried=true 写死了，等于关掉自动重登
edit('pin 动作恢复自动重登',
  /      const \{ status, data \} = await dashRequest\(`\/api\/bucket\/\$\{encodeURIComponent\(id\)\}\/\$\{action\}`, true\);/,
  () => '      const { status, data } = await dashRequest(`/api/bucket/${encodeURIComponent(id)}/${action}`, false);');

edit('pin 回退 PATCH 恢复自动重登',
  /        const patchRes = await dashRequest\(`\/api\/bucket\/\$\{encodeURIComponent\(id\)\}`, true, \{ method: 'PATCH', body: JSON\.stringify\(\{ pinned: action === 'pin' \}\) \}\);/,
  () => "        const patchRes = await dashRequest(`/api/bucket/${encodeURIComponent(id)}`, false, { method: 'PATCH', body: JSON.stringify({ pinned: action === 'pin' }) });");

edit('archive 动作恢复自动重登',
  /      const \{ status, data \} = await dashRequest\(`\/api\/bucket\/\$\{encodeURIComponent\(id\)\}\/archive`, true\);/,
  () => '      const { status, data } = await dashRequest(`/api/bucket/${encodeURIComponent(id)}/archive`, false);');

// 6) 写信要带 author，OB 才知道是谁写的；顺手支持 title
edit('letter_write 带上 author',
  /app\.post\('\/api\/ombre\/letter-write', async \(req, res\) => \{\n  const \{ content \} = req\.body;\n  if \(!content\) return res\.status\(400\)\.json\(\{ error: 'content required' \}\);\n  const result = await obCall\('letter_write', \{ content \}\);/,
  () => `app.post('/api/ombre/letter-write', async (req, res) => {
  const { content, author, title } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  // OB 的 letter_write 要 author 才知道这封信是谁写的：我写的填 ai，她写的填 user
  const args = { content, author: author === 'user' ? 'user' : 'ai' };
  if (title) args.title = title;
  const result = await obCall('letter_write', args);`);

// 7) 状态接口把"到底为什么连不上"说清楚，别让下次又猜
edit('状态接口说明原因',
  /app\.get\('\/api\/ombre-dashboard\/status', async \(req, res\) => \{\n  try \{/,
  () => `app.get('/api/ombre-dashboard/status', async (req, res) => {
  if (!DASHBOARD_PASSWORD) {
    return res.status(503).json({
      available: false, error: 'OMBRE_DASHBOARD_PASSWORD_MISSING',
      message: '没设 Dashboard 密码：在 /root/chatnest-api/.env 里加 OMBRE_DASHBOARD_PASSWORD=你的密码，然后重启'
    });
  }
  try {`);

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
const bak = path + '.bak-dash-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('接下来跑 set-ob-password.sh 填 Dashboard 密码，记忆页才会有东西。');
