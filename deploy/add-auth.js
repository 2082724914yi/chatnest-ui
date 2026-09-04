#!/usr/bin/env node
// 把门关上：所有 /api 默认要凭据，token 换成随机的、会过期的。
//   node add-auth.js [/root/chatnest-api/server.js]
//
// 打之前的实况（我在她线上实测过）：
//   · /api/sessions、/api/sessions/:id/messages 一行鉴权都没有 —— 不带任何凭据
//     就能拿到会话列表、读走每一句话。记忆、日记、profile、pulse 同理。
//   · /api/export/all 一个 GET 打包带走全部。
//   · /api/watch/setup 直接把手表 token 吐给来访者。
//   · 前端老老实实每次都带 Authorization，后端从来没看过。那道密码门是纯装饰。
//   · token 是写死的一个字符串，不随机、不过期。
//   · CORS origin:'*'，任何网站都能跨域来读。
//
// 这个补丁做四件事：
//   1. 全局鉴权中间件：/api/* 默认全拦，白名单只有三个
//      —— /api/health（监控，无敏感信息）、/api/auth（登录入口本身）、
//         /api/watch/upload（iOS 捷径发的，它自己校验独立 token）。
//   2. token 改成 32 字节随机、存盘（600 权限）、30 天过期、支持多设备。
//   3. 登录密码优先读 .env 的 CHATNEST_PASSWORD；没配就沿用原来那个，
//      不把她锁在门外，但每次启动会在日志里喊一声。
//      （补丁文件本身不写明文密码 —— 运行时从目标文件里把原值搬过去。）
//   4. CORS 收到她自己的域名；登录接口加暴力破解限流。
//
// 打完她会被登出一次，重新输一次密码就好。捷径不受影响。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('AUTH_PATCH_VERSION')) { console.log('已经打过，跳过'); process.exit(0); }

// 把原来写死的密码从目标文件里取出来，作为 .env 没配时的回退。
// 这样补丁脚本（会进 git）里不出现明文密码。
const legacyMatch = src.match(/if \(pass !== '([^']*)'\)/);
if (!legacyMatch) { console.error('找不到 /api/auth 的密码校验，先确认版本'); process.exit(1); }
const legacyPass = legacyMatch[1];

// ---------- 1) 鉴权模块 + 中间件 ----------
const STATIC_ANCHOR = "app.use(express.static('/var/www/chatnest'));";
if (!src.includes(STATIC_ANCHOR)) { console.error('找不到静态文件中间件'); process.exit(1); }

const AUTH_BLOCK = `
// ===== AUTH_PATCH_VERSION = 1 —— 把门关上 =====
// 之前 /api 全部裸奔：不带凭据就能读走聊天记录、记忆、日记、profile。
// 现在默认全拦，白名单只留三个。
const AUTH_FILE = '/root/chatnest-api/auth-tokens.json';
const AUTH_TTL_MS = Number(process.env.AUTH_TTL_DAYS || 30) * 24 * 3600 * 1000;
// 放行的：健康检查（无敏感信息）、登录入口本身、捷径上传（它自己校验独立 token）
const AUTH_OPEN = new Set(['/api/health', '/api/auth', '/api/watch/upload']);

function authLoad() {
  try { const v = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); return (v && typeof v === 'object') ? v : {}; }
  catch (e) { return {}; }
}
function authSave(m) {
  try { fs.writeFileSync(AUTH_FILE, JSON.stringify(m), { mode: 0o600 }); }
  catch (e) { console.error('[auth] token 存不下来:', e.message); }
}
let _authTokens = authLoad();
function authIssue() {
  const now = Date.now();
  for (const k of Object.keys(_authTokens)) {
    if (!_authTokens[k] || _authTokens[k] < now) delete _authTokens[k];   // 顺手清过期
  }
  const t = crypto.randomBytes(32).toString('hex');
  _authTokens[t] = now + AUTH_TTL_MS;
  authSave(_authTokens);
  return t;
}
function authValid(t) {
  if (!t) return false;
  const exp = _authTokens[t];
  if (!exp) return false;
  if (exp < Date.now()) { delete _authTokens[t]; authSave(_authTokens); return false; }
  return true;
}
let _authWarned = false;
function authPassword() {
  const p = String(process.env.CHATNEST_PASSWORD || '').trim();
  if (p) return p;
  if (!_authWarned) {   // 只喊一次，别每次登录都刷屏
    _authWarned = true;
    console.warn('[auth] ⚠ 没配 CHATNEST_PASSWORD，还在用源码里那个密码。请到 /root/chatnest-api/.env 里设一个。');
  }
  return AUTH_FALLBACK_PASS;
}
function authTokenOf(req) {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\\s+(.+)$/i);
  if (m) return m[1].trim();
  if (req.query && req.query.token) return String(req.query.token).trim();
  return '';
}

// 登录接口防爆破：同一个 IP 15 分钟内最多试 8 次
const _authTries = new Map();
function authRateOk(ip) {
  const now = Date.now(), win = 15 * 60 * 1000;
  const rec = _authTries.get(ip) || { n: 0, t: now };
  if (now - rec.t > win) { rec.n = 0; rec.t = now; }
  rec.n++;
  _authTries.set(ip, rec);
  if (_authTries.size > 5000) _authTries.clear();   // 别让它无限长
  return rec.n <= 8;
}

// 默认全拦。只有白名单和非 /api 的请求（前端静态文件）放过去。
app.use((req, res, next) => {
  const p = (req.path || '').split('?')[0];
  if (!p.startsWith('/api/')) return next();
  if (AUTH_OPEN.has(p)) return next();
  if (authValid(authTokenOf(req))) return next();
  return res.status(401).json({ error: 'unauthorized' });
});
`;

let out = src.replace(STATIC_ANCHOR, STATIC_ANCHOR + '\n' + AUTH_BLOCK);

// 回退密码：从目标文件里搬过来，不写在补丁里
out = out.replace('const AUTH_FILE = ', 'const AUTH_FALLBACK_PASS = ' + JSON.stringify(legacyPass) + ';\nconst AUTH_FILE = ');

// ---------- 2) 换掉 /api/auth：随机 token + .env 密码 + 限流 ----------
const OLD_AUTH_START = out.indexOf("app.post('/api/auth', (req, res) => {");
if (OLD_AUTH_START < 0) { console.error('找不到 /api/auth 路由'); process.exit(1); }
// 注意：res.json({ token: '...' }); 这行自己就含 '});'，不能直接 indexOf('});')，
// 那样会截在行中间、把收尾的括号留在外面。要找行首那个。
const OLD_AUTH_END = out.indexOf('\n});', out.indexOf('res.json({ token:', OLD_AUTH_START)) + 4;
const OLD_AUTH = out.slice(OLD_AUTH_START, OLD_AUTH_END);
if (!OLD_AUTH.includes('token')) { console.error('/api/auth 结构对不上'); process.exit(1); }

const NEW_AUTH = `app.post('/api/auth', (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!authRateOk(ip)) return res.status(429).json({ error: '试太多次了，等一刻钟再来' });
  const pass = (req.body && req.body.password) || '';
  if (pass !== authPassword()) return res.status(401).json({ error: '密码不正确' });
  res.json({ token: authIssue() });
});`;
out = out.slice(0, OLD_AUTH_START) + NEW_AUTH + out.slice(OLD_AUTH_END);

// ---------- 3) CORS 收紧 ----------
const OLD_CORS = "app.use(cors({ origin: '*' }));";
if (out.includes(OLD_CORS)) {
  out = out.replace(OLD_CORS,
    "// 只认自己的前端。没有 Origin 的（同源、捷径、curl）放过 —— 它们照样要过鉴权那关。\n" +
    "const CORS_OK = (process.env.CORS_ORIGINS || 'https://xiaoyixiaoyan.top,https://www.xiaoyixiaoyan.top')\n" +
    "  .split(',').map(s => s.trim()).filter(Boolean);\n" +
    "app.use(cors({ origin: (o, cb) => cb(null, !o || CORS_OK.includes(o)) }));");
}

const checks = [
  ['鉴权中间件在', /AUTH_PATCH_VERSION = 1/.test(out) && /res\.status\(401\)\.json\(\{ error: 'unauthorized' \}\)/.test(out)],
  ['白名单只有三个', /AUTH_OPEN = new Set\(\['\/api\/health', '\/api\/auth', '\/api\/watch\/upload'\]\)/.test(out)],
  ['token 随机 32 字节', /crypto\.randomBytes\(32\)\.toString\('hex'\)/.test(out)],
  ['token 会过期', /AUTH_TTL_MS/.test(out) && /exp < Date\.now\(\)/.test(out)],
  ['token 存盘 600', /mode: 0o600/.test(out)],
  ['密码优先读 .env', /process\.env\.CHATNEST_PASSWORD/.test(out)],
  ['登录限流', /authRateOk/.test(out) && /429/.test(out)],
  ['CORS 收紧了', !/cors\(\{ origin: '\*' \}\)/.test(out)],
  ['中间件在路由之前', out.indexOf('AUTH_PATCH_VERSION') < out.indexOf("app.get('/api/sessions'")],
  ['只插一次', (out.match(/AUTH_PATCH_VERSION/g) || []).length === 1],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、')); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
console.log('  注意: 手机上会被登出一次，重新输密码就好；捷径不受影响。');
