#!/usr/bin/env node
/* 第六个补丁：同一段回复被处理两遍。

   CLI 对同一段内容会发两次：
     · stream_event → content_block_delta → text_delta   （流式增量，边生成边来）
     · assistant → message.content[] → {type:'text'}      （整段结束后再来一份完整的）
   两条我都接了，于是正文重复一遍，里面的 <think> 也被重新解析，
   时间轴上多长出一个 Think process。

   原来那句 fullResponse.includes(block.text) 拦不住：流式时 <think> 的内容
   进的是思考节点、没进 fullResponse，所以完整消息比对时并不"包含"，照样放行。

   改法：记一下这轮有没有走过流式文本，走过就不再吃完整消息里的 text/thinking。
   （CLI 若某次只发完整消息不发增量，标志为假，仍然照常处理，不会漏。）

   用法：curl -fsSL .../deploy/fix-dup-text.js | sudo node -
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

if (!s.includes('processCompleteMessage')) {
  console.error('这个 server.js 还没打 patch-server.js，先跑那个。');
  process.exit(1);
}
if (s.includes('sawStreamText')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

// 1) 加标志
edit('新增流式文本标志',
  /  let thinkState = 'idle', thinkBuf = '', thinkTrace = null;/,
  () => `  let thinkState = 'idle', thinkBuf = '', thinkTrace = null;
  // 这轮有没有走过流式文本。走过的话，结束后 CLI 再发的那份完整消息就是重复的。
  let sawStreamText = false;`);

// 2) 流式收到文本时打标
edit('流式文本处打标',
  /      \} else if \(delta\.type === 'text_delta' && delta\.text\) \{\n        feedText\(delta\.text\);\n      \}/,
  () => `      } else if (delta.type === 'text_delta' && delta.text) {
        sawStreamText = true;
        feedText(delta.text);
      }`);

// 3) 完整消息里的 text：流式已收过就跳过
edit('完整消息 text 去重',
  /        \} else if \(block\.type === 'text' && block\.text\) \{\n          if \(fullResponse\.includes\(block\.text\)\) continue;\n          feedText\(block\.text\);\n        \}/,
  () => `        } else if (block.type === 'text' && block.text) {
          // 流式已经收过这段了，这份是 CLI 收尾时重发的同一段，再吃一遍就成了说两遍
          if (sawStreamText) continue;
          if (fullResponse.includes(block.text)) continue;
          feedText(block.text);
        }`);

// 4) 完整消息里的 thinking 同理
edit('完整消息 thinking 去重',
  /        if \(block\.type === 'thinking' && block\.thinking\) \{\n          if \(thinkingText\.includes\(block\.thinking\)\) continue;/,
  () => `        if (block.type === 'thinking' && block.thinking) {
          if (sawStreamText) continue;
          if (thinkingText.includes(block.thinking)) continue;`);

// 5) 原生 thinking 块永远是空的（CLI 只给签名不给明文），
//    在时间轴上就是一个点开什么都没有的"思考过程"，白占一行。
//    真正有内容的是我们自己解析的 Think process，所以这个不再建节点。
edit('不再为空的原生思考建节点',
  /if \(cb\.type === 'thinking'\) \{ currentBlockType = 'thinking'; curTrace = traceStart\('thinking', '思考过程'\); \}/,
  () => `if (cb.type === 'thinking') {
        // CLI 的原生 thinking 是加密的（thinking:"" + signature），点开永远是空的，
        // 所以不建节点；有内容的思考走 <think> 那条路（Think process）。
        currentBlockType = 'thinking'; curTrace = null;
      }`);

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
const bak = path + '.bak-dup-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端。正文不会再说两遍，Think process 也只剩一个。');
