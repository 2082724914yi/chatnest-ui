#!/usr/bin/env node
// 常驻会话那条路也要砍内置工具。
//   node fix-daemon-tools.js [/root/chatnest-api/server.js]
//
// 她开着「常驻会话·持续进程模式」，走的是 handleDaemonChat，那条自己另起一个
// spawn。slim-cli-tools 匹配的是明文命令，而 daemon 那条是
//     const proc = spawn('sh', ['-c', cmd], { env: daemonEnv() });
// 命令拼在变量 cmd 里，锚点根本碰不到 —— 所以她跑完补丁，ToolSearch 还在。
// 是她自己猜出来的：「不会是我设置开着那个持续进程模式的原因吧」。对。
//
// 同一个坑我栽第三次了：add-uploads 的附件、fix-moments 的系统提示，
// 都是 daemon 这条路自己另起炉灶。以后凡是动 CLI 参数或提示词的，先想 daemon。
//
// 这次不去猜 cmd 拼成什么样 —— 包一层函数，运行时往里插。不管命令怎么拼，
// 只要里面有 claude -p 就插得进去；已经有 --tools 的不重复插。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('DAEMON_TOOLS_SLIM')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('builtinToolsFlag')) { console.error('先打 slim-cli-tools.js（要用它那个 flag）'); process.exit(1); }

const HELPER = `
// ============ 常驻会话那条路也砍内置工具 ============
// DAEMON_TOOLS_SLIM
// daemon 的命令是拼在变量里再 spawn 的，没法在源码里按明文改 —— 运行时插。
function slimDaemonCmd(cmd) {
  const s = String(cmd == null ? '' : cmd);
  if (process.env.CHATNEST_KEEP_BUILTIN_TOOLS === '1') return s;
  if (/--tools(\\s|=)/.test(s)) return s;                 // 已经有了，别插两遍
  const out = s.replace(/((?:\\S*\\/)?claude\\s+-p)(?=\\s|$)/, '$1' + builtinToolsFlag());
  if (out === s) console.warn('[daemon] 没找到 claude -p，内置工具没砍成');
  else if (!global.__daemonSlimLogged) { global.__daemonSlimLogged = 1; console.log('[daemon] 已砍内置工具'); }
  return out;
}
`;

let out = src;
const done = [], missed = [];

const FROM = "const proc = spawn('sh', ['-c', cmd], { env: daemonEnv() });";
const TO   = "const proc = spawn('sh', ['-c', slimDaemonCmd(cmd)], { env: daemonEnv() });";
const n = out.split(FROM).length - 1;
if (!n) missed.push('× 找不到 daemon 那条 spawn');
else { out = out.split(FROM).join(TO); done.push('√ daemon 那条 spawn 包了一层（' + n + ' 处）'); }

if (!/\napp\.listen\(PORT/.test(out)) missed.push('× 找不到 app.listen(PORT');
else { out = out.replace(/\napp\.listen\(PORT/, HELPER + '\napp.listen(PORT'); done.push('√ 辅助函数'); }

console.log('\n补丁结果：');
[...done, ...missed].forEach(l => console.log('  ' + l));

// 顺手把 daemon 命令是怎么拼的打出来（脱敏）—— 万一没插进去，看这几行就知道为什么
console.log('\n  daemon 那条命令的拼装（只看结构）：');
src.split('\n').map((l, i) => [i + 1, l])
  .filter(([, l]) => /\bcmd\s*=/.test(l) && /claude|stdbuf|resume/.test(l))
  .slice(0, 5)
  .forEach(([i, l]) => {
    const low = l.toLowerCase();
    console.log('    ' + i + ': ' + (/token|secret|password|api_?key/.test(low) ? '[已隐去]' : l.trim().slice(0, 165)));
  });

if (missed.length) { console.error('\n有锚点没命中，原文件一个字都没动。'); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);
console.log('\n  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
console.log('\n  ⚠ 常驻会话是挂着的进程，--tools 只在起进程那一下生效 ——');
console.log('    重启后一定要「新开一个对话」，续老对话是接上旧进程，看不出变化。');
console.log('\n  验证：pm2 logs chatnest-api --lines 30 | grep daemon');
console.log('    看到「[daemon] 已砍内置工具」就是插进去了。');
