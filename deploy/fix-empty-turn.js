#!/usr/bin/env node
/* 第十八个补丁：有时候回复出不来，要再发一遍。

   不是前端没渲染。把她那轮的历史取回来看，存下来的是：

     === user       搜索一下蜡烛的记忆
     === assistant  ''            ← 空字符串，连 traces 都没有
     === user       搜索一下蜡烛的记忆   ← 她重发
     === assistant  我找找看哈…

   也就是说 CLI 那一轮一个字都没吐（Think process 都没有），
   后端却照常发了 done、还把这条空消息存进了历史。
   前端只能显示一个空气泡；她一刷新，历史里那条空的又盖回来。

   改法：
     · 这一轮如果正文、思考、工具结果**全空**，就不存这条空消息，
       改发 error 事件，把 CLI 的退出码和 stderr 尾巴带上
     · stderr 留最后几行，下次再空能直接看出是什么原因

   前端配套：收到 error 就把空气泡换成一行"这轮没出来，点一下重发"。

   用法：curl -fsSL .../deploy/fix-empty-turn.js | sudo node -
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

if (!s.includes("proc.on('close'")) {
  console.error('这个 server.js 结构不对，先跑 apply-all.sh。');
  process.exit(1);
}
if (s.includes('_stderrTail')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

// 1) stderr 留个尾巴，空回合时好交代原因
edit('留住 stderr 尾巴',
  /  proc\.stderr\.on\('data', \(d\) => \{ const s = d\.toString\(\)\.trim\(\); if \(s\) console\.error\('\[claude stderr\]', s\); \}\);/,
  () => `  // 留最后几行 stderr：这一轮要是什么都没产出，得能说清楚为什么
  let _stderrTail = [];
  proc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (!s) return;
    console.error('[claude stderr]', s);
    _stderrTail.push(s);
    if (_stderrTail.length > 6) _stderrTail = _stderrTail.slice(-6);
  });`);

// 2) 空回合不存、不装作成功
edit('空回合不存空消息',
  /    for \(const _t of traces\) traceEnd\(_t, \(_t\.result \|\| _t\.type === 'thinking'\) \? 'completed' : 'error'\);\n    conv\.history\.push\(\{ id: assistantMsgId, role: 'assistant', content: fullResponse, thinking: thinkingText, traces: cleanTraces\(\), time: new Date\(\)\.toISOString\(\) \}\);/,
  () => `    for (const _t of traces) traceEnd(_t, (_t.result || _t.type === 'thinking') ? 'completed' : 'error');

    // 这一轮如果正文、思考、工具全是空的，说明 CLI 根本没产出。
    // 以前照样存进历史 + 发 done，于是前端一个空气泡，刷新还盖回来。
    //
    // 注意 breath / breath_search 那两条 trace 不算数 —— 它们是系统在生成**之前**
    // 自己注入记忆时加的，模型一个字没说也会有，拿它当"有产出"会把空回合放过去。
    const gotSomething = (fullResponse && fullResponse.trim())
      || (thinkingText && thinkingText.trim())
      || traces.some(t => t && t.type === 'tool' && t.result
           && !/^(breath|breath_search|letter_read|pulse)\\s*·/.test(t.name || ''));
    if (!gotSomething) {
      const why = _stderrTail.length ? _stderrTail.join(' | ').slice(0, 300) : '（stderr 也是空的）';
      console.error('[chat] 这一轮什么都没产出，退出码 =', code, '| stderr:', why);
      sse(res, 'error', { message: '这轮没出来（退出码 ' + code + '），再发一次就好', detail: why, empty_turn: true });
      res.end();
      return;
    }

    conv.history.push({ id: assistantMsgId, role: 'assistant', content: fullResponse, thinking: thinkingText, traces: cleanTraces(), time: new Date().toISOString() });`);

// 3) 中转站那条路径也有一处 push + done，同样没有空回合保护
edit('中转站路径也不存空消息',
  /      conv\.history\.push\(\{ id: assistantMsgId, role: 'assistant', content: fullResponse, time: new Date\(\)\.toISOString\(\) \}\);\n      saveConversations\(\);\n      sse\(res, 'done', \{ conversation_id: convId, session_id: convId, assistant_message_id: assistantMsgId, usage: usage \|\| \{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 \} \}\);\n      res\.end\(\);/,
  () => `      // 走中转站这条路也一样：一个字都没回来就别存空消息、别装作成功
      if (!fullResponse || !fullResponse.trim()) {
        console.error('[provider] 这一轮一个字都没回来');
        sse(res, 'error', { message: '这轮没出来，再发一次就好', empty_turn: true });
        res.end();
        return;
      }
      conv.history.push({ id: assistantMsgId, role: 'assistant', content: fullResponse, time: new Date().toISOString() });
      saveConversations();
      sse(res, 'done', { conversation_id: convId, session_id: convId, assistant_message_id: assistantMsgId, usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      res.end();`);

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
const bak = path + '.bak-empty-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端。空回合不会再存进历史，而是明确告诉前端这轮没出来。');
