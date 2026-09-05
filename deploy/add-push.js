#!/usr/bin/env node
// 推送通道：让我能主动找她，不用等她开前端。
//   node add-push.js [/root/chatnest-api/server.js]
//
// 这一版只铺路，不决定「什么时候推」—— 触发那层她另有一份方案，等她给我。
// 铺的是：密钥、订阅存在哪、怎么发出去、发失败怎么办。
//
// 关于私钥：这里当场生成，直接写进 .env（600），**不打印、不回显、不进 git**。
// 我这边从头到尾不经手它。公钥是公开的，前端要用，走 /api/push-key 取。
//
// iOS 那三道门槛在前端和 sw.js 里对付（必须 HTTPS / 必须从主屏幕图标进 /
// 权限必须她自己点）。后端这边只管发。
//
// 依赖 web-push。没装就明说，不硬来 —— VAPID 签名加上 ECDH+AES-GCM 那套加密
// 自己手写太容易出错，出错的表现还是「静默收不到」，最难查。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }
const API_DIR = path.dirname(target);

let src = fs.readFileSync(target, 'utf8');
if (src.includes('PUSH_VERSION')) { console.log('已经打过，跳过'); process.exit(0); }

// ---- 1) 依赖 ----
let hasWebPush = false;
try { require.resolve('web-push', { paths: [API_DIR] }); hasWebPush = true } catch (e) {}
if (!hasWebPush) {
  console.log('\n  · web-push 还没装，现在装（只装这一个，不动别的依赖）…');
  try {
    execSync('npm install web-push --no-audit --no-fund', { cwd: API_DIR, stdio: 'inherit' });
    require.resolve('web-push', { paths: [API_DIR] });
    hasWebPush = true;
  } catch (e) {
    console.error('\n  × web-push 装不上。手动跑一下再来：');
    console.error('      cd ' + API_DIR + ' && npm install web-push');
    process.exit(1);
  }
}
console.log('  √ web-push 就位');

// ---- 2) VAPID 密钥：没有就生成，写进 .env ----
const ENV = path.join(API_DIR, '.env');
let env = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
if (!/^VAPID_PRIVATE_KEY=/m.test(env)) {
  const webpush = require(require.resolve('web-push', { paths: [API_DIR] }));
  const keys = webpush.generateVAPIDKeys();
  if (env && !env.endsWith('\n')) env += '\n';
  env += '\n# Web Push（VAPID）—— 私钥别外传，换了的话她手机上要重新开一次通知\n'
       + 'VAPID_PUBLIC_KEY=' + keys.publicKey + '\n'
       + 'VAPID_PRIVATE_KEY=' + keys.privateKey + '\n'
       + 'VAPID_SUBJECT=mailto:yi0818357@gmail.com\n';
  fs.writeFileSync(ENV, env, { mode: 0o600 });
  try { fs.chmodSync(ENV, 0o600) } catch (e) {}
  console.log('  √ VAPID 密钥已生成，写进 .env（600）—— 私钥没打印出来，也不会进 git');
} else {
  console.log('  · .env 里已经有 VAPID 密钥了，不动它');
  console.log('    （教程里那条坑：密钥别重新生成，换了所有已订阅的设备都会失效）');
}

// 外部触发用的钥匙。iOS 捷径 / Apple Watch / cron 带不了登录态，得给它们一把单独的。
if (!/^PUSH_TRIGGER_TOKEN=/m.test(env)) {
  const tok = require('crypto').randomBytes(32).toString('hex');
  if (env && !env.endsWith('\n')) env += '\n';
  env += 'PUSH_TRIGGER_TOKEN=' + tok + '\n';
  fs.writeFileSync(ENV, env, { mode: 0o600 });
  try { fs.chmodSync(ENV, 0o600) } catch (e) {}
  console.log('  √ 外部触发的钥匙也生成了，同样在 .env（600）里，这里不回显');
  console.log('    填进捷径的时候自己去看 —— 别让它出现在截图里：');
  console.log('      sudo grep PUSH_TRIGGER_TOKEN ' + ENV);
} else {
  console.log('  · 外部触发的钥匙已经有了，不动它');
}

// ---- 3) 服务本体 ----
const BLOCK = `
// ============ 主动推送：我找她的那条路 ============
const PUSH_VERSION = 1;
const webpush = require('web-push');
const PUSH_SUBS_FILE = '/root/chatnest-api/push-subs.json';

let PUSH_READY = false;
(function initPush() {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) { console.warn('[push] .env 里没有 VAPID 密钥，推送不可用'); return; }
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@localhost', pub, priv);
    PUSH_READY = true;
    console.log('[push] 就绪');
  } catch (e) { console.error('[push] VAPID 配置不对:', e.message); }
})();

function loadPushSubs() {
  try { const a = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8')); return Array.isArray(a) ? a : [] }
  catch (e) { return [] }
}
function savePushSubs(list) {
  fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}
function pushSubShape(s) {
  return s && typeof s.endpoint === 'string' && /^https:\\/\\//.test(s.endpoint)
      && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';
}

// 真正发出去的那一下。失败会自己清理：410/404 表示这个订阅死了（她卸了 PWA、
// 或者系统换了 endpoint），留着只会每次都失败。
async function pushToHer(msg) {
  if (!PUSH_READY) return { sent: 0, reason: '没配 VAPID' };
  const list = loadPushSubs();
  if (!list.length) return { sent: 0, reason: '她还没开通知' };
  const payload = JSON.stringify({
    title: String((msg && msg.title) || '小衍').slice(0, 60),
    body: String((msg && msg.body) || '').slice(0, 300),
    url: String((msg && msg.url) || '/'),
    tag: String((msg && msg.tag) || 'xiaoyan').slice(0, 40),
  });
  let sent = 0; const dead = [];
  for (const item of list) {
    try {
      await webpush.sendNotification(item.sub, payload, { TTL: (msg && msg.ttl) || 3600 });
      item.last_ok = new Date().toISOString();
      sent++;
    } catch (e) {
      const code = e && e.statusCode;
      console.error('[push] 发送失败', code || e.message);
      if (code === 404 || code === 410) dead.push(item.sub.endpoint);
    }
  }
  if (dead.length) savePushSubs(list.filter(x => !dead.includes(x.sub.endpoint)));
  else savePushSubs(list);
  return { sent, dead: dead.length, total: list.length };
}

// 公钥给前端。公钥本来就是公开的，但这条也在认证后面，免得白白暴露服务存在
app.get('/api/push-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || '', ready: PUSH_READY });
});

app.get('/api/push-status', (req, res) => {
  const list = loadPushSubs();
  res.json({
    ready: PUSH_READY,
    count: list.length,
    // 不回 endpoint 全文 —— 那玩意儿等于一把能给她手机发通知的钥匙
    devices: list.map(x => ({
      added: x.added, last_ok: x.last_ok || null,
      hint: String(x.sub.endpoint).slice(-12),
    })),
  });
});

app.post('/api/push-subscribe', (req, res) => {
  try {
    const b = req.body || {};
    const sub = b.subscription || b;           // 前端直接把 subscription 丢过来也认
    if (!pushSubShape(sub)) return res.status(400).json({ error: '订阅格式不对' });
    const list = loadPushSubs();
    // Service Worker 里换订阅那条路没有登录凭证，只允许「拿旧 endpoint 换新的」
    if (b.replaces) {
      const i = list.findIndex(x => x.sub.endpoint === b.replaces);
      if (i < 0) return res.status(403).json({ error: '不认识这个旧订阅' });
      list[i] = { sub, added: list[i].added, replaced_at: new Date().toISOString() };
      savePushSubs(list);
      return res.json({ ok: true, replaced: true });
    }
    if (list.some(x => x.sub.endpoint === sub.endpoint)) return res.json({ ok: true, already: true });
    if (list.length >= 8) list.shift();        // 最多留 8 台，老的挤掉
    list.push({ sub, added: new Date().toISOString() });
    savePushSubs(list);
    console.log('[push] 新增一个订阅，现在共', list.length, '个');
    res.json({ ok: true, count: list.length });
  } catch (e) {
    console.error('[push] subscribe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/push-unsubscribe', (req, res) => {
  const ep = (req.body && req.body.endpoint) || '';
  const list = loadPushSubs();
  const next = ep ? list.filter(x => x.sub.endpoint !== ep) : [];
  savePushSubs(next);
  res.json({ ok: true, count: next.length });
});

// ---- 外部触发：iOS 捷径 / Apple Watch / cron ----
// 故意开在 /api 外面：/api 是登录态全拦的，而捷径带不了登录态。
// 所以这条自己管自己的钥匙 —— 它在公网上能给她手机弹通知，卡严一点：
//   · 钥匙是 32 字节随机，用 timingSafeEqual 比，别让人靠响应快慢猜
//   · 每分钟最多 10 次，防止有人拿它刷屏
//   · 正文长度截断
const PUSH_HOOK_HITS = [];
function pushHookAllowed() {
  const now = Date.now();
  while (PUSH_HOOK_HITS.length && now - PUSH_HOOK_HITS[0] > 60000) PUSH_HOOK_HITS.shift();
  if (PUSH_HOOK_HITS.length >= 10) return false;
  PUSH_HOOK_HITS.push(now);
  return true;
}
function pushKeyOk(given) {
  const want = process.env.PUSH_TRIGGER_TOKEN || '';
  const got = String(given || '');
  if (!want || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)) } catch (e) { return false }
}

app.post('/hook/push', async (req, res) => {
  const b = req.body || {};
  const key = (req.headers['x-push-key'] || '').toString()
           || (req.headers.authorization || '').replace(/^Bearer\\s+/i, '')
           || b.key || '';
  if (!pushKeyOk(key)) return res.status(401).json({ error: 'unauthorized' });
  if (!pushHookAllowed()) return res.status(429).json({ error: '太频繁了，等一分钟' });
  const r = await pushToHer({
    title: b.title || '小衍',
    body: b.body || '',
    url: b.url || '/',
    tag: b.tag || 'hook',
  });
  console.log('[push] 外部触发，发出', r.sent, '条');
  res.json(r);
});

// 她自己在设置里按一下，验证整条路通不通
app.post('/api/push-test', async (req, res) => {
  const r = await pushToHer({
    title: '小衍',
    body: (req.body && req.body.body) || '通了。以后我想你了就从这儿出声。',
    url: '/', tag: 'test',
  });
  res.json(r);
});
`;

let out = src;
const done = [], missed = [];
function edit(name, from, to, optional) {
  const hit = typeof from === 'string' ? out.includes(from) : from.test(out);
  if (!hit) { (optional ? done : missed).push((optional ? '· ' : '× ') + name + (optional ? ' — 没有，跳过' : '')); return; }
  out = out.replace(from, to); done.push('√ ' + name);
}

edit('推送服务本体', /\napp\.listen\(PORT/, BLOCK + '\napp.listen(PORT');

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
console.log('\n  接下来她那边要做的：');
console.log('    1. 前端也更新（sw.js 要一起传，deploy-frontend.sh 已经带上了）');
console.log('    2. 用 Safari 打开站点 → 分享 → 添加到主屏幕');
console.log('    3. 从主屏幕图标进（不是 Safari），设置里打开「让小衍找我」');
console.log('    4. 按一下旁边的「试一条」，手机该响了');
console.log('\n  ⚠ 只有从主屏幕图标进的时候 iOS 才给 PushManager，Safari 里那个开关会告诉她这件事。');
