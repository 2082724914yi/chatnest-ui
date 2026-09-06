#!/usr/bin/env node
// 「现在还没结束的」那一栏，从第一天起就在显示一句报错。
//   node fix-latent-unresolved.js [/root/chatnest-api/server.js]
//
// add-latent-view.js 给 /api/latent/unresolved 的 GET 写的是
// latentCall('latent_unresolved', { action: 'list' })。
// 但 latent_unresolved 是**只写工具**，上游 schema 里 action 只有
// open / update / close —— 没有 list。于是每次调用都被打回来一句
//   「unresolvedStatus=blocked；失败类型=request_invalid：action 只能是 open / update / close / none」
// 前端把这句报错原样当成「还没结束的事」显示出来了。
//
// 库里没有脏数据要清 —— 那句是每次实时返回的错误，不是存进去的内容。
// 要修的是这个接口本身。
//
// 未解决清单其实是语料目录下的一个文件（上游 unresolved_state.FILENAME = "未解决.md"，
// --doctor 也会检查它）。所以改成直接读那个文件，跟 windows 那三个口子一样走文件不走 MCP。
// 文件不存在是正常的 —— 上游说「第一次 open 时才创建」。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
const VERSION_LINE = '// LATENT_UNRESOLVED_FIX = 1';
if (src.includes('LATENT_UNRESOLVED_FIX')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes("app.get('/api/latent/unresolved'")) {
  console.error('要先打 add-latent-view.js'); process.exit(1);
}
if (!src.includes('LATENT_TIMELINE_DIR')) {
  console.error('要先打 add-latent-windows.js（要用它那个语料目录常量）'); process.exit(1);
}

// 整段换掉 GET 路由的实现
const OLD_ROUTE = /app\.get\('\/api\/latent\/unresolved',[\s\S]*?\n\}\);\n/;
const NEW_ROUTE = `${VERSION_LINE}
// 未解决清单是语料目录下的「未解决.md」，直接读它。
// 不能调 latent_unresolved —— 那是只写工具，action 只有 open/update/close，
// 传 list 会被打回一句报错，而这一栏以前就是在显示那句报错。
app.get('/api/latent/unresolved', async (req, res) => {
  try {
    const p = LATENT_CORPUS_DIR.replace(/\\/+$/, '') + '/未解决.md';
    if (!fs.existsSync(p)) {
      // 上游：第一次 open 时才创建。没有 = 没有没结束的事，不是错。
      return res.json({ ok: true, text: '', note: '还没有未解决清单（正常）' });
    }
    res.json({ ok: true, text: fs.readFileSync(p, 'utf8') });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
`;

if (!OLD_ROUTE.test(src)) {
  console.error('没匹配到原来那个 GET 路由，原文件一个字都没动。');
  process.exit(1);
}
let out = src.replace(OLD_ROUTE, NEW_ROUTE);

const checks = [
  ['版本戳写进去了', out.includes(VERSION_LINE)],
  ['GET 路由还在', /app\.get\('\/api\/latent\/unresolved'/.test(out)],
  ['不再调 latent_unresolved 的 list', !/latentCall\('latent_unresolved',\s*\{\s*action:\s*'list'/.test(out)],
  ['POST 路由没被动', /app\.post\('\/api\/latent\/unresolved'/.test(out)],
  ['只改了一处', (out.match(/LATENT_UNRESOLVED_FIX/g) || []).length === 1],
  ['windows 那三个口子还在', /app\.get\('\/api\/latent\/windows'/.test(out)],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

try {
  new vm.Script(out, { filename: target });
} catch (e) {
  console.error('  × 改完之后语法不对，放弃写入:', e.message);
  process.exit(1);
}

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
