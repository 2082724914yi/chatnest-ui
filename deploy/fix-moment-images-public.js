#!/usr/bin/env node
// 朋友圈的图读不出来 —— 把图片那条路放行。
//   node fix-moment-images-public.js [/root/chatnest-api/server.js]
//
// 病根（2026.9.11 查的）：
//   add-moments 把图片存成文件，地址是 /api/moment-images/<16位随机>.jpg，
//   靠 express.static 提供。可 add-auth 之后 /api/* 默认全拦，白名单只有
//   health / auth / watch/upload 三个 —— 图片那条不在里面。
//
//   而且就算把它塞进 AUTH_OPEN 也没用：网页里显示图走的是 <img src="...">，
//   那是浏览器自己发的请求，不会带 Authorization 头。前端只有 api() 才带 token。
//   所以传得进去、读不出来，她看到的是一个破图方块（一次 401）。
//   线上实测：/api/health 200，/api/moments 401，/api/moment-images/x.jpg 401。
//
// 修法（她选的方案一）：给中间件加一条「只读前缀白名单」，放行 GET/HEAD 的图片请求。
//   文件名是 crypto.randomBytes(8).toString('hex') —— 16 位十六进制，2^64 种，
//   猜不到。跟主流图床一个路子：知道确切链接的人能看，猜是猜不着的。
//   代价她知道并同意：链接泄露出去，拿到的人不登录也能看那一张图。
//
// 收紧的几处，别删：
//   - 只放行 GET / HEAD（POST/DELETE 照样要登录）
//   - 正则只认「一段文件名」，带斜杠的进不来
//   - 额外挡掉含 .. 的路径（双保险，express.static 自己也防）
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('MOMENT_IMAGES_PUBLIC_V1')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('AUTH_OPEN')) { console.error('先打 add-auth.js（没有鉴权中间件，本来就不拦，不用修）'); process.exit(1); }
if (!src.includes('/api/moment-images')) { console.error('先打 add-moments.js（还没有朋友圈图片这条路）'); process.exit(1); }

// ---------- 1) 定义只读前缀白名单 ----------
const DEF_OLD = "const AUTH_OPEN = new Set(['/api/health', '/api/auth', '/api/watch/upload']);";
const DEF_NEW = DEF_OLD + "\n" +
  "// MOMENT_IMAGES_PUBLIC_V1 —— 只读放行：<img> 拿不到 Bearer token，走 api() 又会让朋友圈滚起来卡。\n" +
  "// 文件名是 16 位随机十六进制，猜不到；只认一段文件名，带斜杠和 .. 的进不来。\n" +
  "const AUTH_OPEN_READ_RE = [/^\\/api\\/moment-images\\/[A-Za-z0-9._-]+$/];";

if (!src.includes(DEF_OLD)) {
  console.error('\n  × 找不到 AUTH_OPEN 那一行。相关的行：');
  src.split('\n').filter(l => /AUTH_OPEN/.test(l)).slice(0, 6)
     .forEach(l => console.error('      ' + l.trim().slice(0, 150)));
  process.exit(1);
}

// ---------- 2) 中间件里加一条 ----------
const MW_OLD = "  if (AUTH_OPEN.has(p)) return next();";
const MW_NEW = MW_OLD + "\n" +
  "  if ((req.method === 'GET' || req.method === 'HEAD') && !p.includes('..')\n" +
  "      && AUTH_OPEN_READ_RE.some(re => re.test(p))) return next();";

if (!src.includes(MW_OLD)) {
  console.error('\n  × 找不到鉴权中间件里 AUTH_OPEN.has(p) 那一行。相关的行：');
  src.split('\n').filter(l => /AUTH_OPEN\.has|unauthorized/.test(l)).slice(0, 6)
     .forEach(l => console.error('      ' + l.trim().slice(0, 150)));
  process.exit(1);
}

let out = src.replace(DEF_OLD, DEF_NEW).replace(MW_OLD, MW_NEW);

// ---------- 3) 自检：要的都在，不该动的没动 ----------
const checks = [
  ['幂等标记写进去了', /MOMENT_IMAGES_PUBLIC_V1/.test(out)],
  ['前缀白名单定义在', /const AUTH_OPEN_READ_RE = \[/.test(out)],
  ['中间件里用上了', /AUTH_OPEN_READ_RE\.some\(re => re\.test\(p\)\)/.test(out)],
  ['只放行 GET/HEAD', /req\.method === 'GET' \|\| req\.method === 'HEAD'/.test(out)],
  ['挡了 ..', /!p\.includes\('\.\.'\)/.test(out)],
  ['原来那三个白名单没动', /AUTH_OPEN = new Set\(\['\/api\/health', '\/api\/auth', '\/api\/watch\/upload'\]\)/.test(out)],
  ['401 那条还在', /res\.status\(401\)\.json\(\{ error: 'unauthorized' \}\)/.test(out)],
];
const bad = checks.filter(c => !c[1]);
if (bad.length) {
  console.error('\n  × 自检没过，放弃写入：');
  bad.forEach(c => console.error('      - ' + c[0]));
  process.exit(1);
}

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n  √ 朋友圈图片放行了（只读、只认一段文件名、只认 GET/HEAD）');
checks.forEach(c => console.log('      ✓ ' + c[0]));
console.log('  备份: ' + backup);
console.log('  重启: sudo pm2 restart chatnest-api');
console.log('  验：curl -s -o /dev/null -w "%{http_code}\\n" https://api.xiaoyixiaoyan.top/api/moment-images/zzz.jpg');
console.log('     应该是 404（放行了，只是没这个文件），不再是 401。');
