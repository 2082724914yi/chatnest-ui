#!/usr/bin/env node
// 朋友圈说明要接进「所有」拼系统提示的地方，不是只接第一处。
//   node fix-moments-allpaths.js [/root/chatnest-api/server.js]
//
// 前一版只接了 SYSTEM_PREFIX，可她开着常驻会话开关，走的是另一条路：
//   function daemonSysFile() {
//     fs.writeFileSync(p, PERSONA + THINK_PROMPT + MCP_TOOL_PROMPT + PULSE_TOOL_PROMPT);
//   }
// 这条自己把系统提示重拼了一遍，硬编码那几个变量，根本不看 SYSTEM_PREFIX。
// 于是部署全绿、文件也确实写了，我却一个字都没看到 —— 一直在 ToolSearch 里
// 翻不存在的 moments 工具。
//
// 这里改成：凡是把 PULSE_TOOL_PROMPT / MCP_TOOL_PROMPT / OB_TOOL_PROMPT / THINK_PROMPT
// 拼在一起的地方（排除它们自己的定义行、以及已经接过的），统统在末尾接上
// MOMENTS_TOOL_PROMPT。接了几处会报出来。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('MOMENTS_ALL_PATHS')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('MOMENTS_TOOL_PROMPT')) {
  console.error('这份 server.js 还没打过 add-moments.js，先打那个');
  process.exit(1);
}

const NAMES = ['PULSE_TOOL_PROMPT', 'MCP_TOOL_PROMPT', 'OB_TOOL_PROMPT', 'THINK_PROMPT'];
const isDef = (ln, n) => new RegExp('(const|let|var)\\s+' + n + '\\s*=').test(ln);

const lines = src.split('\n');
const touched = [];

lines.forEach((ln, i) => {
  if (/\bMOMENTS_TOOL_PROMPT\b/.test(ln)) return;          // 这行已经有了
  // 找这行里最后出现的那个提示词变量，接在它后面
  let last = null, lastAt = -1;
  for (const n of NAMES) {
    if (isDef(ln, n)) return;                              // 是某个变量的定义行，别碰
    const at = ln.lastIndexOf(n);
    if (at > lastAt) { lastAt = at; last = n; }
  }
  if (!last) return;
  // 只认「拼接」语境：后面得跟着 ; 或 ) 或 , 才像是拼完了
  const rest = ln.slice(lastAt + last.length);
  if (!/^\s*(\)|;|,|\+\s*['"`])/.test(rest) && rest.trim() !== '') return;
  lines[i] = ln.slice(0, lastAt + last.length) +
             " + '\\n' + MOMENTS_TOOL_PROMPT" +
             ln.slice(lastAt + last.length);
  touched.push({ no: i + 1, before: ln.trim(), after: lines[i].trim() });
});

console.log('\n补丁结果：');
if (!touched.length) {
  console.error('  × 一处都没接上 —— 找不到拼系统提示的地方');
  console.error('    相关的行长这样：');
  src.split('\n').filter(l => NAMES.some(n => l.includes(n))).slice(0, 8)
     .forEach(l => console.error('      ' + l.trim().slice(0, 150)));
  process.exit(1);
}

let out = lines.join('\n');
// 打个记号，方便 apply-all 判断
out = out.replace(/\n/, '\n// MOMENTS_ALL_PATHS\n');

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('  √ 接上了 ' + touched.length + ' 处：');
touched.forEach(t => {
  console.log('    第 ' + t.no + ' 行');
  console.log('      改后: ' + t.after.slice(0, 150));
});
console.log('\n  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
console.log('\n  ⚠ 你要是开着「常驻会话」开关，这次务必新开一个对话再试 ——');
console.log('    老对话会 --resume 续上旧会话，旧的系统提示还留在里面。');
