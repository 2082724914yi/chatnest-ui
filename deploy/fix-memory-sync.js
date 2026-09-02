#!/usr/bin/env node
/* 第四个补丁：让"我主动存的记忆"和"她在前端存的记忆"变成同一份东西。
   现状是各存各的：
     · 她在 Saved memories 里存 → profile.json + OB
     · 我在聊天里 hold      → 只进 OB，前端 memory 页面看不见
   补完之后，不管谁存，两边都看得到。

   顺带修一个卡住我存记忆的闸门：那段代码套了 Promise.race(..., 10 秒)，
   而 hold 在 OB 那边要调打标模型，远不止 10 秒 —— 于是每次都被截断成 null，
   记忆没存进去，还显示"完成"。

   用法：curl -fsSL .../deploy/fix-memory-sync.js | sudo node -
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

if (!s.includes('PROFILE_FILE')) {
  console.error('这个 server.js 还没打 fix-memory-think.js，先跑那个。');
  process.exit(1);
}
if (s.includes('rememberIntoProfile')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

// ---- 1. 一个统一的入口：不管谁存，都同时进 profile 和 OB ----
edit('新增双写函数',
  /function saveProfileFile\(\) \{/,
  () => `// 我在聊天里存的记忆，也要落进 profile，这样她在 Saved memories 里能看见。
// 反过来她在前端存的会同步进 OB（见 PUT /api/profile），两边最终是同一份。
function rememberIntoProfile(content, source) {
  const text = String(content || '').trim();
  if (!text) return null;
  // 已经有一模一样的就不重复记
  if ((profile.savedMemories || []).some(m => m.content.trim() === text)) return null;
  const item = {
    id: 'mem-' + uid(), content: text, enabled: true,
    source: source || 'claude', createdAt: Date.now(), updatedAt: Date.now(), obSynced: true
  };
  profile.savedMemories.unshift(item);
  if (profile.savedMemories.length > 200) profile.savedMemories.length = 200;
  profile.updatedAt = Date.now();
  saveProfileFile();
  return item;
}

function saveProfileFile() {`);

// ---- 2. 拆掉那个 10 秒闸门，并把 hold 的内容写进 profile ----
edit('我存记忆时同步进前端 + 解开 10 秒闸门',
  /        for \(const tc of obCalls\) \{\n          const t = traceStart\('tool', tc\.tool \+ ' · 记忆'\);\n          t\.input = tc\.args;\n          sse\(res, 'trace', \{ action: 'input', id: t\.id, input: t\.input \}\);\n          try \{\n            const result = await Promise\.race\(\[obCall\(tc\.tool, tc\.args\), new Promise\(r => setTimeout\(\(\) => r\(null\), 10000\)\)\]\);\n            t\.result = result \|\| '完成';/,
  () => `        for (const tc of obCalls) {
          const t = traceStart('tool', tc.tool + ' · 记忆');
          t.input = tc.args;
          sse(res, 'trace', { action: 'input', id: t.id, input: t.input });
          try {
            // 这里原来卡了 10 秒就当失败，而 hold 在 OB 那边要调打标模型，
            // 根本来不及 —— 记忆没写进去，界面上却显示"完成"。给到 70 秒。
            const result = await Promise.race([obCall(tc.tool, tc.args), new Promise(r => setTimeout(() => r(null), 70000))]);
            t.result = result || '完成';
            // 存成功了就同时落进 profile，她在 Saved memories 里就能看到这条
            if (result && tc.tool === 'hold' && tc.args && tc.args.content) {
              const saved = rememberIntoProfile(tc.args.content, 'claude');
              if (saved) console.log('[memory] 我存的已同步到前端:', saved.content.slice(0, 30));
            }`);

// ---- 2.5 流式阶段就挡住 <ob> 标签，别让它出现在她屏幕上 ----
// 后端最后会 stripOBToolCalls，但那是流结束之后的事，delta 早就发出去了。
// 标签内容仍要留在 fullResponse 里，否则后端解析不到这次工具调用。
edit('流式过滤 ob 标签',
  /      if \(thinkState === 'idle'\) \{\n        const i = thinkBuf\.indexOf\('<think>'\);\n        if \(i >= 0\) \{\n          const before = thinkBuf\.slice\(0, i\);\n          if \(before\) \{ fullResponse \+= before; sse\(res, 'delta', \{ text: before \}\); \}\n          thinkBuf = thinkBuf\.slice\(i \+ 7\);\n          thinkState = 'inside';\n          thinkTrace = traceStart\('thinking', 'Think process'\);\n          continue;\n        \}\n        const keep = tagTail\(thinkBuf, '<think>'\);\n        const out = thinkBuf\.slice\(0, thinkBuf\.length - keep\);\n        if \(out\) \{ fullResponse \+= out; sse\(res, 'delta', \{ text: out \}\); \}\n        thinkBuf = thinkBuf\.slice\(thinkBuf\.length - keep\);\n        return;\n      \}/,
  () => `      if (thinkState === 'idle') {
        const iT = thinkBuf.indexOf('<think>');
        const iO = thinkBuf.indexOf('<ob ');
        let idx = -1, which = '';
        if (iT >= 0 && (iO < 0 || iT < iO)) { idx = iT; which = 'think'; }
        else if (iO >= 0) { idx = iO; which = 'ob'; }
        if (which) {
          const before = thinkBuf.slice(0, idx);
          if (before) { fullResponse += before; sse(res, 'delta', { text: before }); }
          if (which === 'think') {
            thinkBuf = thinkBuf.slice(idx + 7);
            thinkState = 'inside';
            thinkTrace = traceStart('thinking', 'Think process');
          } else {
            thinkBuf = thinkBuf.slice(idx);   // <ob 本身也留着，等收全再一起进 fullResponse
            thinkState = 'ob';
          }
          continue;
        }
        const keep = Math.max(tagTail(thinkBuf, '<think>'), tagTail(thinkBuf, '<ob '));
        const out = thinkBuf.slice(0, thinkBuf.length - keep);
        if (out) { fullResponse += out; sse(res, 'delta', { text: out }); }
        thinkBuf = thinkBuf.slice(thinkBuf.length - keep);
        return;
      }
      if (thinkState === 'ob') {
        const jo = thinkBuf.indexOf('</ob>');
        if (jo >= 0) {
          fullResponse += thinkBuf.slice(0, jo + 5);   // 留给 parseOBToolCalls，但不发给她
          thinkBuf = thinkBuf.slice(jo + 5);
          thinkState = 'idle';
          continue;
        }
        const keepO = tagTail(thinkBuf, '</ob>');
        fullResponse += thinkBuf.slice(0, thinkBuf.length - keepO);
        thinkBuf = thinkBuf.slice(thinkBuf.length - keepO);
        return;
      }`);

edit('收尾时 ob 残留也不外发',
  /  function flushText\(\) \{\n    if \(!thinkBuf\) return;\n    if \(thinkState === 'idle'\) \{ fullResponse \+= thinkBuf; sse\(res, 'delta', \{ text: thinkBuf \}\); \}/,
  () => `  function flushText() {
    if (!thinkBuf) return;
    if (thinkState === 'ob') { fullResponse += thinkBuf; thinkBuf = ''; thinkState = 'idle'; return; }
    if (thinkState === 'idle') { fullResponse += thinkBuf; sse(res, 'delta', { text: thinkBuf }); }`);

// ---- 3. 提示里说清楚：存了两边都看得见 ----
edit('提示补充双向可见',
  /- importance: 3日常 5一般重要 7重要 9非常重要（必须是整数，小数会被拒绝）`;/,
  () => `- importance: 3日常 5一般重要 7重要 9非常重要（必须是整数，小数会被拒绝）
- 用 hold 存的东西，她在设置的 Saved memories 里能直接看到，网页版 OB 那边也有
- 她说"记住这个""别忘了"的时候，就用 hold 存下来\`;`);

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
const bak = path + '.bak-sync-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端。以后不管谁存记忆，前端 Saved memories 和网页版 OB 都看得到。');
