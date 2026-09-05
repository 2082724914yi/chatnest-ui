#!/usr/bin/env node
// 聊天里发的图，刷新一下就没了 —— 因为存历史那一行根本没写 attachments。
//   node fix-history-attachments.js [/root/chatnest-api/server.js]
//
// 诊断结果（deploy/diag-images.sh 跑出来的）：
//   conv.history.push({ id: userMsgId, role: 'user', content: message, time: ... });
//                                                                     ↑ 就到这儿了
//
// 图本身是好好存着的（uploads/ 里在），那一轮我也确实看见了（describeAttachments
// 把路径塞进了提示）。但「这条消息带过图」这件事没落进历史，所以重新加载会话时，
// 前端拿回来的那条 user 消息里一个附件都没有，气泡里就只剩一句话。
//
// 她以为是我为了省 token 故意把图丢掉的。不是。是漏了一个字段。
//
// 这里只做一件事：把这一轮的附件路径一起写进历史。前端本来就认这个字段
// （裸路径也认，会自己补成对象），所以前端不用再改。
//
// 老消息补不回来 —— 当时就没记，没地方捞。从打上这个补丁之后发的都会留住。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('HISTORY_ATTACHMENTS_V1')) { console.log('已经打过，跳过'); process.exit(0); }

// 函数声明会提升，插在哪儿都能被前面的代码调到（不像 const —— 那个有暂时性死区，
// 上次差点因为这个把服务搞得起不来）。
const HELPER = `
// ============ 存历史时带上附件 ============
// HISTORY_ATTACHMENTS_V1
function historyAttachments(req) {
  const a = req && req.body && req.body.attachments;
  if (!Array.isArray(a)) return [];
  // 前端发过来的就是一串 uploads/... 路径；只收字符串，别把别的东西塞进历史
  return a.filter(x => typeof x === 'string' && x).slice(0, 10);
}
`;

const OLD = "conv.history.push({ id: userMsgId, role: 'user', content: message, time: new Date().toISOString() });";
const NEW = "conv.history.push({ id: userMsgId, role: 'user', content: message, time: new Date().toISOString(), attachments: historyAttachments(req) });";

const hits = src.split(OLD).length - 1;
if (!hits) {
  console.error('\n  × 找不到存 user 消息那一行。现在长这样：');
  src.split('\n').forEach((l, i) => {
    if (/conv\.history\.push\(\{[^}]*role:\s*'user'/.test(l))
      console.error('      第 ' + (i + 1) + ' 行: ' + l.trim().slice(0, 160));
  });
  process.exit(1);
}

let out = src.split(OLD).join(NEW);

// 辅助函数插在 app.listen 之前，跟其它补丁一个位置
if (!/\napp\.listen\(PORT/.test(out)) { console.error('  × 找不到 app.listen(PORT'); process.exit(1); }
out = out.replace(/\napp\.listen\(PORT/, HELPER + '\napp.listen(PORT');

console.log('\n补丁结果：');
console.log('  √ 存历史那一行接上了附件（' + hits + ' 处）');

// 读历史那条路会不会把 attachments 一起给出去 —— 只看，不改。
// 整条丢出去就没事；要是挑字段 map 一遍，新字段会在那儿被丢掉，得再补一刀。
const readLines = out.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /history/.test(l) && /(res\.json|\.map\(|messages\s*:)/.test(l));
const picks = readLines.filter(([, l]) => /\.map\(/.test(l));
if (picks.length) {
  console.log('  ⚠ 读历史那边像是挑字段返回的，这几行盯一下：');
  picks.slice(0, 4).forEach(([n, l]) => console.log('      第 ' + n + ' 行: ' + l.trim().slice(0, 170)));
  console.log('      要是里面没把 attachments 带上，图还是会丢 —— 把这几行贴给我。');
} else if (readLines.length) {
  console.log('  · 读历史是整条丢出去的，新字段会自动跟着走：');
  readLines.slice(0, 3).forEach(([n, l]) => console.log('      第 ' + n + ' 行: ' + l.trim().slice(0, 140)));
} else {
  console.log('  ⚠ 没找到读历史那条路，等下在前端刷新一下看图还在不在。');
}

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);
console.log('\n  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
console.log('\n  ⚠ 之前发过的图补不回来 —— 当时历史里就没记，没地方捞。');
console.log('    重启之后再发的，刷新就还在了。');
