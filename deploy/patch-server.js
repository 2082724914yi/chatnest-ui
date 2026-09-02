#!/usr/bin/env node
/* 在服务器上就地给 server.js 打补丁：思考链 / 工具调用时间轴 + 真流式。
   用法：node patch-server.js /root/chatnest-api/server.js
   安全：先备份，全部命中才写入，写入前做语法校验；任何一步失败都不改原文件。 */
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
  const all = s.match(new RegExp(re.source, re.flags.replace('g','') + 'g'));
  if (all && all.length > 1) { log.push(['×', label, `匹配到 ${all.length} 处，不敢动`]); failed++; return; }
  s = s.replace(re, make(m));
  log.push(['√', label, '']);
}
function has(str) { return s.includes(str); }

// 0) 幂等：已经打过就退出
if (has('--include-partial-messages') || has("action: 'start'")) {
  console.log('这个 server.js 已经打过补丁了，无需重复执行。');
  process.exit(0);
}

// 1) 关键：CLI 加 --include-partial-messages，否则 stream-json 不吐增量事件。
//    只改聊天那次调用（带 model/effort 参数的），不动 /api/cc-usage 的用量探测。
edit('CLI 加 --include-partial-messages',
  /(\$\{modelFlag\}\$\{effortFlag\}|\$\{effortFlag\}|\$\{modelFlag\})([^\n]*?)--verbose\s+--output-format\s+stream-json/,
  (m) => m[1] + m[2] + '--verbose --include-partial-messages --output-format stream-json');

// 2) messages API 返回 thinking / traces，历史才能重建时间轴
edit('messages API 返回 thinking+traces',
  /id:\s*m\.id,\s*role:\s*m\.role,\s*text:\s*m\.content,\s*timestamp:\s*m\.time/,
  () => 'id: m.id, role: m.role, text: m.content, thinking: m.thinking || \'\', traces: m.traces || [], timestamp: m.time');

// 3) 在 /api/chat 里注入 traces 容器 + trace 事件发送器
edit('注入 traces 容器',
  /(\n\s*let fullResponse = '';)/,
  (m) => m[1] + `
  // —— 思考/工具时间轴 ——
  const traces = [];
  function traceStart(type, name, id) {
    const t = { id: id || 'tr-' + uid(), type, name, content: '', input: null, result: '', status: 'running', duration_ms: 0, _t0: Date.now() };
    traces.push(t);
    sse(res, 'trace', { action: 'start', id: t.id, type, name });
    return t;
  }
  function traceEnd(t, status = 'completed') {
    if (!t || t.status !== 'running') return;
    t.status = status; t.duration_ms = Date.now() - t._t0;
    sse(res, 'trace', { action: 'end', id: t.id, status, duration_ms: t.duration_ms });
  }
  const cleanTraces = () => traces.map(({ _t0, ...r }) => r);
  let curTrace = null;
  const seenToolIds = new Set();`);

// 4) OB 记忆召回也进时间轴
edit('记忆召回进时间轴',
  /const recallId = 'ob-' \+ uid\(\);\s*\n\s*sse\(res, 'tool_use', \{[^\n]*\n/,
  () => `const recallTrace = traceStart('tool', 'breath · 记忆');
  recallTrace.input = { query: message.slice(0, 50) };
  sse(res, 'trace', { action: 'input', id: recallTrace.id, input: recallTrace.input });
`);
edit('记忆召回收尾',
  /sse\(res, 'tool_result', \{ tool_use_id: recallId,[^\n]*\n/,
  () => `recallTrace.result = memories || '暂无相关记忆';
  sse(res, 'trace', { action: 'result', id: recallTrace.id, result: recallTrace.result });
  traceEnd(recallTrace);
`);

// 5) thinking 增量 → trace delta
edit('thinking 块开始',
  /if \(cb\.type === 'thinking'\) \{.*\}/,
  () => `if (cb.type === 'thinking') { currentBlockType = 'thinking'; curTrace = traceStart('thinking', '思考过程'); }`);
edit('thinking 增量',
  /if \(delta\.type === 'thinking_delta'\) \{[\s\S]*?sse\(res, 'thinking',[^\n]*\n\s*\}/,
  () => `if (delta.type === 'thinking_delta' && delta.thinking) {
        thinkingText += delta.thinking;
        if (curTrace) { curTrace.content += delta.thinking; sse(res, 'trace', { action: 'delta', id: curTrace.id, text: delta.thinking }); }
      }`);

// 6) tool_use 块 → trace 节点（顺带修掉把输入当结果发的老 bug）
edit('tool_use 块开始',
  /else if \(cb\.type === 'tool_use'\) \{[\s\S]*?sse\(res, 'tool_use',[^\n]*\n\s*\}/,
  () => `else if (cb.type === 'tool_use') {
        currentBlockType = 'tool_use';
        currentToolInput = '';
        curTrace = traceStart('tool', cb.name || 'tool', cb.id);
        if (cb.id) seenToolIds.add(cb.id);
      }`);
edit('content_block_stop 收尾',
  /if \(currentBlockType === 'tool_use'\) \{[\s\S]*?sse\(res, 'tool_result',[^\n]*\n\s*\}/,
  () => `if (currentBlockType === 'tool_use' && curTrace) {
        try { curTrace.input = JSON.parse(currentToolInput); } catch { curTrace.input = currentToolInput || null; }
        sse(res, 'trace', { action: 'input', id: curTrace.id, input: curTrace.input });
      }`);
edit('thinking 块收尾',
  /if \(currentBlockType === 'thinking'\) \{[\s\S]*?sse\(res, 'thinking',[^\n]*\n\s*\}/,
  () => `if (currentBlockType === 'thinking' && curTrace) { traceEnd(curTrace); curTrace = null; }`);

// 7) 处理 CLI 的完整消息块 —— thinking / tool_use / tool_result 的真正来源
edit('新增 processCompleteMessage',
  /(\n\s*proc\.stdout\.on\('data', \(chunk\) => \{)/,
  (m) => `
  // CLI 的完整消息块：{"type":"assistant","message":{"content":[...]}}
  function processCompleteMessage(obj) {
    if (obj.type === 'assistant' && Array.isArray(obj.message && obj.message.content)) {
      if (obj.message.usage) usage = obj.message.usage;
      for (const block of obj.message.content) {
        if (block.type === 'thinking' && block.thinking) {
          if (thinkingText.includes(block.thinking)) continue;
          thinkingText += block.thinking;
          const t = traceStart('thinking', '思考过程');
          t.content = block.thinking;
          sse(res, 'trace', { action: 'delta', id: t.id, text: block.thinking });
          traceEnd(t);
        } else if (block.type === 'tool_use') {
          if (block.id && seenToolIds.has(block.id)) continue;
          if (block.id) seenToolIds.add(block.id);
          const t = traceStart('tool', block.name || 'tool', block.id);
          t.input = block.input || null;
          sse(res, 'trace', { action: 'input', id: t.id, input: t.input });
        } else if (block.type === 'text' && block.text) {
          if (fullResponse.includes(block.text)) continue;
          fullResponse += block.text;
          sse(res, 'delta', { text: block.text });
        }
      }
    } else if (obj.type === 'user' && Array.isArray(obj.message && obj.message.content)) {
      for (const block of obj.message.content) {
        if (block.type !== 'tool_result') continue;
        const t = traces.find(x => x.id === block.tool_use_id) || curTrace;
        if (!t) continue;
        let text = block.content;
        if (Array.isArray(text)) text = text.map(c => c.text || c.content || '').join('\\n');
        else if (text && typeof text === 'object') text = JSON.stringify(text, null, 2);
        t.result = String(text == null ? '' : text);
        sse(res, 'trace', { action: 'result', id: t.id, result: t.result, is_error: !!block.is_error });
        traceEnd(t, block.is_error ? 'error' : 'completed');
        if (curTrace === t) curTrace = null;
      }
    }
  }
` + m[1]);

// 8) 把新消息类型接进 stdout 解析
edit('stdout 接入完整消息',
  /(\}\s*else if \(obj\.type === 'rate_limit_event' && obj\.rate_limit_info\) \{)/,
  (m) => `} else if (obj.type === 'assistant' || obj.type === 'user') {
        processCompleteMessage(obj);
      ` + m[1]);

// 9) traces 存进历史
edit('traces 存历史',
  /conv\.history\.push\(\{ id: assistantMsgId, role: 'assistant', content: fullResponse, thinking: thinkingText,/,
  () => `for (const _t of traces) traceEnd(_t, (_t.result || _t.type === 'thinking') ? 'completed' : 'error');\n    conv.history.push({ id: assistantMsgId, role: 'assistant', content: fullResponse, thinking: thinkingText, traces: cleanTraces(),`);

// 10) done 事件带上 traces
edit('done 带 traces',
  /sse\(res, 'done', \{ conversation_id: convId, session_id: convId, assistant_message_id: assistantMsgId,\s*\n/,
  () => `sse(res, 'done', { conversation_id: convId, session_id: convId, assistant_message_id: assistantMsgId, traces: cleanTraces(),\n`);

// ---- 报告 ----
console.log('\n补丁结果：');
for (const [mark, label, note] of log) console.log(`  ${mark} ${label}${note ? '  — ' + note : ''}`);

if (failed) {
  console.error(`\n有 ${failed} 处没打上，原文件未改动。把上面的输出发回来，我按你的实际代码调整。`);
  process.exit(1);
}
try {
  new (require('vm').Script)(s, { filename: 'patched' });
} catch (e) {
  console.error('\n补丁后语法有问题，原文件未改动：', e.message);
  process.exit(1);
}
const bak = path + '.bak-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('现在重启后端（pm2 restart / systemctl restart 你原来怎么起的就怎么重启），然后发条消息试试。');
