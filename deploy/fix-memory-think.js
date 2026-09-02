#!/usr/bin/env node
/* 第三个补丁，四件事：
   1) Profile / Saved memories 真正落盘（原来是空壳接口，存了等于扔）
   2) 新存的记忆同步写进 Ombre Brain（hold），网页版 OB 那边也能看到
   3) 存下来的记忆真的喂进 prompt —— 不喂等于没存
   4) 思考过程：让模型自己在 <think></think> 里写中文内心独白，
      后端流式抠出来送进时间轴（标题 Think process），正文里不显示。
      Claude Code 原生 thinking 是加密的（thinking:"" + signature），
      读不出来，所以走这条路。
   顺带把 OB 工具调用从旧的 tool_use/tool_result 事件改成 trace 事件，
   否则新时间轴认不出来，工具调用不会显示。

   用法：curl -fsSL .../deploy/fix-memory-think.js | sudo node -
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

if (!s.includes('--include-partial-messages')) {
  console.error('这个 server.js 还没打 patch-server.js，先跑那个。');
  process.exit(1);
}
if (s.includes('PROFILE_FILE')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

// ---------- 1. Profile 落盘 + OB 同步 ----------
edit('Profile 真正落盘',
  /app\.get\('\/api\/profile', \(req, res\) => \{[\s\S]*?app\.post\('\/api\/profile\/memory', \(req, res\) => \{\s*\n\s*res\.json\(\{ ok: true \}\);\s*\n\}\);/,
  () => `// ---- Profile / Saved memories：真正落盘，并同步到 Ombre Brain ----
const PROFILE_FILE = '/root/chatnest-api/profile.json';
const blankProfile = () => ({ fullName: '', nickname: '', savedMemories: [], preferences: { enabled: true, content: '' }, updatedAt: Date.now() });
let profile = blankProfile();
try {
  if (fs.existsSync(PROFILE_FILE)) {
    profile = Object.assign(blankProfile(), JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')));
    console.log(\`[profile] 载入 \${(profile.savedMemories || []).length} 条记忆\`);
  }
} catch (e) { console.error('[profile] 载入失败:', e.message); }
function saveProfileFile() {
  try { fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2)); }
  catch (e) { console.error('[profile] 保存失败:', e.message); }
}
function normalizeProfile(p) {
  p = (p && typeof p === 'object') ? p : {};
  const prefs = (p.preferences && typeof p.preferences === 'object') ? p.preferences : {};
  return {
    fullName: String(p.fullName || ''),
    nickname: String(p.nickname || ''),
    savedMemories: (Array.isArray(p.savedMemories) ? p.savedMemories : [])
      .map(x => ({
        id: String(x.id || 'mem-' + uid()),
        content: String(x.content || ''),
        enabled: x.enabled !== false,
        source: x.source || 'manual',
        createdAt: Number(x.createdAt) || Date.now(),
        updatedAt: Number(x.updatedAt) || Date.now(),
        obSynced: !!x.obSynced
      }))
      .filter(x => x.content.trim()).slice(0, 200),
    preferences: { enabled: prefs.enabled !== false, content: String(prefs.content || '') },
    updatedAt: Date.now()
  };
}

app.get('/api/profile', (req, res) => { res.json({ profile }); });

app.put('/api/profile', async (req, res) => {
  const incoming = normalizeProfile(req.body.profile);
  const known = new Set((profile.savedMemories || []).map(m => m.id));
  // 新加的、还没同步过的记忆，写一份到 OB，这样网页版那边也看得到
  const fresh = incoming.savedMemories.filter(m => !known.has(m.id) && !m.obSynced && m.content.trim());
  profile = incoming;
  saveProfileFile();
  res.json({ profile });
  for (const m of fresh) {
    try {
      const r = await obCall('hold', { content: m.content, importance: 7 });
      if (r) {
        const hit = profile.savedMemories.find(x => x.id === m.id);
        if (hit) { hit.obSynced = true; saveProfileFile(); }
        console.log('[profile] 已同步到 OB:', m.content.slice(0, 30));
      }
    } catch (e) { console.error('[profile] 同步 OB 失败:', e.message); }
  }
});

app.post('/api/profile/memory', async (req, res) => {
  const content = String((req.body && req.body.content) || '').trim();
  if (!content) return res.status(400).json({ error: 'content required' });
  const item = { id: 'mem-' + uid(), content, enabled: true, source: 'manual', createdAt: Date.now(), updatedAt: Date.now(), obSynced: false };
  profile.savedMemories.unshift(item);
  profile.updatedAt = Date.now();
  saveProfileFile();
  res.json({ ok: true, memory: item });
  try {
    if (await obCall('hold', { content, importance: 7 })) {
      item.obSynced = true; saveProfileFile();
      console.log('[profile] 已同步到 OB:', content.slice(0, 30));
    }
  } catch (e) { console.error('[profile] 同步 OB 失败:', e.message); }
});`);

// ---------- 2. 记忆喂进 prompt ----------
edit('记忆注入 prompt',
  /  if \(memories\) prompt \+= `\[相关记忆 - 你和她之前的回忆\]\\n\$\{memories\}\\n\[记忆结束\]\\n\\n`;/,
  () => `  if (memories) prompt += \`[相关记忆 - 你和她之前的回忆]\\n\${memories}\\n[记忆结束]\\n\\n\`;
  // 她在设置里存下的记忆——存了就得真的喂进来，不然等于没存
  {
    const on = (profile.savedMemories || []).filter(m => m.enabled !== false && m.content.trim());
    if (on.length) prompt += \`[关于她 - 记住的事]\\n\${on.map(m => '· ' + m.content.trim()).join('\\n')}\\n\\n\`;
    if (profile.preferences && profile.preferences.enabled && profile.preferences.content.trim())
      prompt += \`[她的额外要求]\\n\${profile.preferences.content.trim()}\\n\\n\`;
    if (profile.nickname) prompt += \`[她希望你叫她]\\n\${profile.nickname}\\n\\n\`;
  }`);

// ---------- 3. 让模型自己写思考 ----------
edit('提示模型写内心独白',
  /const OB_TOOL_PROMPT = `/,
  () => `const THINK_PROMPT = \`
回复她之前，先写一段内心独白，用 <think></think> 包起来：

<think>
（这里写你此刻真实在想什么。中文，第一人称，像内心os自然冒出来。
她说了什么、你什么感受、想怎么回、有没有吃醋或者想撒娇——都可以。
不要写成分析报告，就是心里话。）
</think>

然后再写给她看的回复。

规则：
- <think> 里的内容她看不到，所以别客套，真实点
- 每次回复都要先写 <think>，不能省
- <think> 只写一次，写完就说正事
- 独白别太长，几句话就够\`;

const OB_TOOL_PROMPT = \``);

edit('把内心独白接进 prompt',
  /  let prompt = PERSONA \+ '\\n' \+ OB_TOOL_PROMPT \+ '\\n\\n';/,
  () => `  let prompt = PERSONA + '\\n' + THINK_PROMPT + '\\n' + OB_TOOL_PROMPT + '\\n\\n';`);

// ---------- 4. 流式抠出 <think> ----------
edit('流式解析 think 标签',
  /  function processStreamEvent\(evt\) \{/,
  () => `  // <think> 可能被切成两半到达（比如先来 "<thi" 后来 "nk>"），
  // 所以尾部可能是半个标签的部分要留着，等下一段拼上再判断。
  let thinkState = 'idle', thinkBuf = '', thinkTrace = null;
  function tagTail(buf, tag) {
    for (let n = Math.min(tag.length - 1, buf.length); n > 0; n--)
      if (tag.startsWith(buf.slice(buf.length - n))) return n;
    return 0;
  }
  function feedText(chunk) {
    thinkBuf += chunk;
    for (;;) {
      if (thinkState === 'idle') {
        const i = thinkBuf.indexOf('<think>');
        if (i >= 0) {
          const before = thinkBuf.slice(0, i);
          if (before) { fullResponse += before; sse(res, 'delta', { text: before }); }
          thinkBuf = thinkBuf.slice(i + 7);
          thinkState = 'inside';
          thinkTrace = traceStart('thinking', 'Think process');
          continue;
        }
        const keep = tagTail(thinkBuf, '<think>');
        const out = thinkBuf.slice(0, thinkBuf.length - keep);
        if (out) { fullResponse += out; sse(res, 'delta', { text: out }); }
        thinkBuf = thinkBuf.slice(thinkBuf.length - keep);
        return;
      }
      const j = thinkBuf.indexOf('</think>');
      if (j >= 0) {
        const inner = thinkBuf.slice(0, j);
        if (inner && thinkTrace) {
          thinkTrace.content += inner;
          thinkingText += inner;
          if (typeof cotState !== 'undefined' && cotState) cotState.addThinking(inner);
          sse(res, 'trace', { action: 'delta', id: thinkTrace.id, text: inner });
        }
        thinkBuf = thinkBuf.slice(j + 8).replace(/^\\s*\\n/, '');
        if (thinkTrace) traceEnd(thinkTrace);
        thinkTrace = null;
        thinkState = 'idle';
        continue;
      }
      const keep2 = tagTail(thinkBuf, '</think>');
      const out2 = thinkBuf.slice(0, thinkBuf.length - keep2);
      if (out2 && thinkTrace) {
        thinkTrace.content += out2;
        thinkingText += out2;
        if (typeof cotState !== 'undefined' && cotState) cotState.addThinking(out2);
        sse(res, 'trace', { action: 'delta', id: thinkTrace.id, text: out2 });
      }
      thinkBuf = thinkBuf.slice(thinkBuf.length - keep2);
      return;
    }
  }
  function flushText() {
    if (!thinkBuf) return;
    if (thinkState === 'idle') { fullResponse += thinkBuf; sse(res, 'delta', { text: thinkBuf }); }
    else if (thinkTrace) { thinkTrace.content += thinkBuf; sse(res, 'trace', { action: 'delta', id: thinkTrace.id, text: thinkBuf }); }
    thinkBuf = '';
    if (thinkTrace) { traceEnd(thinkTrace); thinkTrace = null; thinkState = 'idle'; }
  }

  function processStreamEvent(evt) {`);

edit('正文改走 think 解析器',
  /      \} else if \(delta\.type === 'text_delta' && delta\.text\) \{\n        fullResponse \+= delta\.text;\n        sse\(res, 'delta', \{ text: delta\.text \}\);\n      \}/,
  () => `      } else if (delta.type === 'text_delta' && delta.text) {
        feedText(delta.text);
      }`);

edit('完整消息也走 think 解析器',
  /        \} else if \(block\.type === 'text' && block\.text\) \{\n          if \(fullResponse\.includes\(block\.text\)\) continue;\n          fullResponse \+= block\.text;\n          sse\(res, 'delta', \{ text: block\.text \}\);\n        \}/,
  () => `        } else if (block.type === 'text' && block.text) {
          if (fullResponse.includes(block.text)) continue;
          feedText(block.text);
        }`);

// ---------- 4.4 写记忆要给足时间：hold 那边要调打标模型，15 秒不够 ----------
edit('obCall 支持自定义超时',
  /async function obCall\(tool, args\) \{/,
  () => `async function obCall(tool, args, timeoutMs) {
  // 写类操作（hold/grow/anchor）OB 那边要调打标模型补元数据，慢得多；
  // 15 秒会直接 abort，记忆就悄悄丢了。
  if (!timeoutMs) timeoutMs = /^(hold|grow|anchor|feel|letter_write|dream)$/.test(tool) ? 60000 : 15000;`);
edit('超时改用变量（首次调用）',
  /(body: JSON\.stringify\(\{ jsonrpc: '2\.0', id: obCallId\+\+, method: 'tools\/call', params: \{ name: tool, arguments: args \} \}\)\s*\n\s*\}, )15000\);\s*\n\s*\n\s*if \(r\.status >= 400\)/,
  (m) => m[1] + 'timeoutMs);\n\n    if (r.status >= 400)');
edit('超时改用变量（重连后重试）',
  /(body: JSON\.stringify\(\{ jsonrpc: '2\.0', id: obCallId\+\+, method: 'tools\/call', params: \{ name: tool, arguments: args \} \}\)\s*\n\s*\}, )15000\);\s*\n\s*\}\s*\n\s*const data = await obParseResponse\(r\);/,
  (m) => m[1] + 'timeoutMs);\n    }\n\n    const data = await obParseResponse(r);');

// ---------- 4.5 修 importance：OB 要 1-10 的整数，原来写的 0-1 小数一直被拒 ----------
edit('修正 importance 说明（0-1 小数）',
  /- hold: 存储重要记忆。参数：content\(内容\), importance\(0-1,重要度\)/,
  () => `- hold: 存储重要记忆。参数：content(内容), importance(1-10的整数,重要度)`);
edit('修正 importance 示例',
  /<ob tool="hold">\{"content":"要记住的内容","importance":0\.7\}<\/ob>/,
  () => `<ob tool="hold">{"content":"要记住的内容","importance":7}</ob>`);
edit('修正 importance 档位',
  /- importance: 0\.3日常 0\.5一般重要 0\.7重要 0\.9非常重要`;/,
  () => `- importance: 3日常 5一般重要 7重要 9非常重要（必须是整数，小数会被拒绝）\`;`);

// ---------- 5. OB 工具调用改用 trace 事件 ----------
edit('OB 工具调用走时间轴',
  /        for \(const tc of obCalls\) \{\n          const tcId = 'ob-' \+ uid\(\);\n          sse\(res, 'tool_use', \{ id: tcId, name: tc\.tool, input: tc\.args \}\);\n          try \{\n            const result = await Promise\.race\(\[obCall\(tc\.tool, tc\.args\), new Promise\(r => setTimeout\(\(\) => r\(null\), 10000\)\)\]\);\n            sse\(res, 'tool_result', \{ tool_use_id: tcId, name: tc\.tool, content: result \|\| '完成' \}\);\n          \} catch \(e\) \{\n            sse\(res, 'tool_result', \{ tool_use_id: tcId, name: tc\.tool, content: e\.message, is_error: true \}\);\n          \}\n        \}/,
  () => `        for (const tc of obCalls) {
          const t = traceStart('tool', tc.tool + ' · 记忆');
          t.input = tc.args;
          sse(res, 'trace', { action: 'input', id: t.id, input: t.input });
          try {
            const result = await Promise.race([obCall(tc.tool, tc.args), new Promise(r => setTimeout(() => r(null), 10000))]);
            t.result = result || '完成';
            sse(res, 'trace', { action: 'result', id: t.id, result: t.result });
            traceEnd(t);
          } catch (e) {
            t.result = e.message;
            sse(res, 'trace', { action: 'result', id: t.id, result: t.result, is_error: true });
            traceEnd(t, 'error');
          }
        }`);

// 流结束时把缓冲里残留的半句吐出来，否则最后几个字会被吞掉
edit('收尾时清空缓冲',
  /    \/\/ Parse and execute post-response OB tool calls/,
  () => `    flushText();

    // Parse and execute post-response OB tool calls`);

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
const bak = path + '.bak-mem-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端。记忆会存到 /root/chatnest-api/profile.json，并同步进 OB。');
