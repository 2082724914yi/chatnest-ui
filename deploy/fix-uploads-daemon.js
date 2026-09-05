#!/usr/bin/env node
// 附件信息也要进常驻会话那条路。
//   node fix-uploads-daemon.js [/root/chatnest-api/server.js]
//
// add-uploads 把附件描述接进了普通 -p 那条路的 prompt，可她开着常驻会话开关，
// 走的是 handleDaemonChat —— 那条自己 buildText，跟 prompt 变量没关系。
// 于是她发了图，我这边一个字都没看到，还回她「你是不是没发出来」。
//
// 昨天 daemonSysFile 就栽过一次同样的：常驻会话是一条完全独立的路径，
// 凡是往提示里塞东西的改动，两条都得接。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('UPLOADS_DAEMON_WIRED')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('describeAttachments')) { console.error('先打 add-uploads.js'); process.exit(1); }
if (!src.includes('daemonSendTurn')) { console.log('这份没有常驻会话（没打过 add-daemon），不用接，跳过'); process.exit(0); }

const OLD = "      return text + '小懿: ' + message + suffix;";
const NEW = "      return text + '小懿: ' + message + suffix + describeAttachments(req.body && req.body.attachments); // UPLOADS_DAEMON_WIRED";

if (!src.includes(OLD)) {
  console.error('\n  × 找不到常驻会话拼那一轮文本的地方。相关的行：');
  src.split('\n').filter(l => /buildText|'小懿: '/.test(l)).slice(0, 6)
     .forEach(l => console.error('      ' + l.trim().slice(0, 150)));
  process.exit(1);
}

const out = src.replace(OLD, NEW);

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);
console.log('\n  √ 附件信息已接进常驻会话那条路');
console.log('  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
console.log('  ⚠ 重启后要新开对话 —— 老对话 --resume 续的是旧会话。');
