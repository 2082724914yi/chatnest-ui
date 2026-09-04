#!/usr/bin/env node
// 让小衍真的能发朋友圈。
//   node fix-moments-tool.js [/root/chatnest-api/server.js]
//
// 两个毛病：
//   1. add-moments 里定义了 MOMENTS_TOOL_PROMPT，但"注入工具说明"那条 edit 当初标了
//      skip: true —— 说明写了却从没拼进 CLI 的 prompt。小衍压根不知道有这个工具，
//      也不知道格式，只能去 Grep 源码猜，发出来的自然落不了库。
//   2. 解析标签的正则只认双引号、且 tool= 前后不许有空格，写成 tool='post' 就匹配不上。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('MOMENTS_PROMPT_WIRED')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('MOMENTS_TOOL_PROMPT')) {
  console.error('这份 server.js 还没打过 add-moments.js，先打那个');
  process.exit(1);
}

// --------------------------------------------------------------------------
// 1) 把工具说明拼进 CLI 的 prompt
//
// 不去精确匹配整行 —— 线上那行早被别的补丁改过（缓存前缀重排、交接信等等），
// 长什么样谁也说不准。只认 OB_TOOL_PROMPT 这个变量本身：找到"用"它的那一处
// （排除定义行），紧跟着把 MOMENTS_TOOL_PROMPT 接上去。不管那行是
// let prompt = PERSONA + OB_TOOL_PROMPT + …  还是  prompt += OB_TOOL_PROMPT，
// 接完都是合法的字符串拼接。
// --------------------------------------------------------------------------
function wireMomentsPrompt(code) {
  const lines = code.split('\n');
  const done = i => ({ ok: true, before: code.split('\n')[i], after: lines[i], code: lines.join('\n') });
  const has = re => lines.findIndex(l => re.test(l) && !/\bMOMENTS_TOOL_PROMPT\b/.test(l));

  // 首选：SYSTEM_PREFIX —— add-cache-prefix 打过之后就是这个形态，
  // 人设和各种工具说明都并进这个"稳定前缀"里一起进缓存。
  // 把朋友圈说明也放进去，既接上了，又能跟着吃缓存，不用每轮重新付费。
  let i = has(/^\s*(const|let|var)\s+SYSTEM_PREFIX\s*=/);
  if (i >= 0) {
    lines[i] = /;\s*$/.test(lines[i])
      ? lines[i].replace(/;\s*$/, " + '\\n' + MOMENTS_TOOL_PROMPT; // MOMENTS_PROMPT_WIRED")
      : lines[i] + " + '\\n' + MOMENTS_TOOL_PROMPT; // MOMENTS_PROMPT_WIRED";
    return done(i);
  }

  // 其次：谁在用这几个说明变量，就跟在谁后面。覆盖没打过 add-cache-prefix 的老形态。
  for (const name of ['PULSE_TOOL_PROMPT', 'MCP_TOOL_PROMPT', 'OB_TOOL_PROMPT', 'THINK_PROMPT']) {
    const re = new RegExp('\\b' + name + '\\b');
    i = lines.findIndex(l =>
      re.test(l) &&
      !new RegExp('(const|let|var)\\s+' + name + '\\s*=').test(l) &&  // 定义行不算
      !/\bMOMENTS_TOOL_PROMPT\b/.test(l));
    if (i >= 0) {
      lines[i] = lines[i].replace(re, name + " + '\\n' + MOMENTS_TOOL_PROMPT") + ' // MOMENTS_PROMPT_WIRED';
      return done(i);
    }
  }

  // 都没有：把相关的行捞出来给人看，别瞎猜
  const seen = lines.filter(l => /SYSTEM_PREFIX|TOOL_PROMPT|let prompt|prompt \+=/.test(l)).slice(0, 8);
  return { ok: false, lines: seen };
}

// --------------------------------------------------------------------------
// 2) 把说明本身写清楚：格式必须严格，否则解析不到
// --------------------------------------------------------------------------
const OLD_TOOLTEXT = `const MOMENTS_TOOL_PROMPT = \`
你可以发朋友圈。想分享心情、想法、日常的时候就发。

用法：在回复正文之后，加上：
<moments tool="post">{"text":"想说的话"}</moments>

可以只有文字，不用每次都发图。发完之后自然地提一句就好，不要念工具返回值。
\`;`;

const NEW_TOOLTEXT = `const MOMENTS_TOOL_PROMPT = \`
你可以发朋友圈。想分享心情、想法、日常的时候，把它写下来。

用法：在回复正文之后，另起一行加上这个标签：
<moments tool="post">{"text":"想说的话"}</moments>

格式要求（不满足就发不出去）：
- 标签要完整闭合，<moments ...> 开头，</moments> 结尾
- 里面必须是一个合法 JSON 对象，双引号，不要用单引号
- text 里如果要换行，写成 \\\\n，不要真的敲回车
- 一次只发一条

这段她看不见，前端会剥掉。所以正文里不要重复朋友圈的内容，也不要念工具返回值，
发完自然地提一句就好。不确定她想不想看的时候，就别发。
\`;`;

// --------------------------------------------------------------------------
// 3) 放宽解析：单双引号都行，等号两边允许空格
// --------------------------------------------------------------------------
const OLD_RE = `  const re = /<moments\\s+tool="(\\w+)">([\\s\\S]*?)<\\/moments>/gi;`;
const NEW_RE = `  const re = /<moments\\s+tool\\s*=\\s*["']?(\\w+)["']?\\s*>([\\s\\S]*?)<\\/moments>/gi;`;

// --------------------------------------------------------------------------
// 4) 流式的时候就把 <moments> 吞掉
//    fix-tool-leak 建了一张「藏标签」表，但只写了 ob/pulse/latent，漏了 moments，
//    于是那段 JSON 当普通文字流进气泡 —— 就是她看到的「发朋友圈的内容跑进聊天里」。
//    这张表要是不在（没打过 fix-tool-leak），这条就跳过，不算失败。
// --------------------------------------------------------------------------
const OLD_TABLE = `          { open: '<latent', kind: 'hidden', close: '</latent>' },`;
const NEW_TABLE = `          { open: '<latent', kind: 'hidden', close: '</latent>' },
          { open: '<moments', kind: 'hidden', close: '</moments>' },`;

// 只有「接上 prompt」是必需的 —— 少了它我就不知道有这个工具，压根发不出去。
// 另外三条都是锦上添花：说明写得细一点、正则宽松一点、流式早一点吞掉，
// 缺哪条都不影响能不能发，所以一律 optional，别为它们让整个补丁失败。
const edits = [
  { name: '把格式要求写清楚',        from: OLD_TOOLTEXT, to: NEW_TOOLTEXT, optional: true },
  { name: '放宽 <moments> 标签解析', from: OLD_RE,       to: NEW_RE,       optional: true },
  { name: '流式时吞掉 <moments>',    from: OLD_TABLE,    to: NEW_TABLE,    optional: true },
];

let out = src;
const missed = [], skipped = [];

// 先接 prompt，这条必须成
const wired = wireMomentsPrompt(out);
if (!wired.ok) {
  console.error('\n  × 把工具说明拼进 CLI prompt — 找不到用 OB_TOOL_PROMPT 的地方');
  console.error('    原文件一个字都没动。把下面这几行发回来：');
  (wired.lines || []).forEach(l => console.error('      ' + l.trim().slice(0, 160)));
  if (!(wired.lines || []).length) console.error('      （server.js 里根本没有 OB_TOOL_PROMPT）');
  process.exit(1);
}
out = wired.code;

for (const e of edits) {
  if (!out.includes(e.from)) { (e.optional ? skipped : missed).push(e.name); continue; }
  out = out.replace(e.from, e.to);
}

console.log('\n补丁结果：');
console.log('  √ 把工具说明拼进 CLI prompt');
console.log('    改前: ' + wired.before.trim().slice(0, 120));
console.log('    改后: ' + wired.after.trim().slice(0, 150));
if (missed.length) {
  for (const e of edits) console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 没匹配上' : '  √ ' + e.name);
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

for (const e of edits) {
  console.log(skipped.includes(e.name) ? '  · ' + e.name + ' — 这份里没这张表，跳过' : '  √ ' + e.name);
}
console.log('\n  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
