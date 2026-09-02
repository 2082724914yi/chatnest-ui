#!/usr/bin/env node
/* 第十三个补丁：那封信没写进 OB，JSON 反倒糊在了聊天框里。

   从她服务器上把那条消息原文取回来看，存的是：

     写好了，你去看看有没有收到 ,,ᗜ - ᗜ,,
     <ob tool="letter_write">{"author":"ai","title":"给小懿的第一封信",
       "content":"…最开心的就是看到你说"在吗"。…"}</ob>

   两个毛病叠在一起：

   1) 正文里"在吗"用的是**英文双引号**，没转义 —— 这段 JSON 是坏的。
      JSON.parse 抛错 → 这条工具调用被整个丢掉 → 信根本没写。
      而我嘴上还说了"写好了"。

   2) stripOBToolCalls 只在"解析出了调用"时才执行。第 1 条失败 →
      一条都没解析出来 → 标签原样存进了会话历史。前端拿历史重渲染时，
      浏览器把不认识的 <ob> 标签吃掉，只剩中间那坨 JSON 露在气泡里。

   改法：
     · 加一个修复式解析：JSON.parse 失败时按已知键名逐段抠出来，
       正文里有裸引号也能救回来（拿她那条原样测过，完整还原）
     · 标签**永远**剥掉，不管解析成没成功
     · 解析彻底失败时在时间轴上标红，别再让我假装写成功了
     · 提示词里说清楚：正文里的引号用「」，别用 "

   用法：curl -fsSL .../deploy/fix-ob-parse.js | sudo node -
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

if (!s.includes('function parseOBToolCalls')) {
  console.error('这个 server.js 里没有 parseOBToolCalls，先跑前面的补丁。');
  process.exit(1);
}
if (s.includes('parseObArgs')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

// 1) 修复式解析 + 更宽松的标签匹配
edit('换掉工具调用解析',
  /function parseOBToolCalls\(text\) \{\n  const re = \/<ob\\s\+tool="\(\\w\+\)">\(\[\\s\\S\]\*\?\)<\\\/ob>\/g;\n  const calls = \[\];\n  let m;\n  while \(\(m = re\.exec\(text\)\) !== null\) \{\n    try \{ calls\.push\(\{ tool: m\[1\], args: JSON\.parse\(m\[2\]\) \}\); \}\n    catch \(e\) \{ console\.log\('\[OB\] failed to parse tool call:', m\[0\]\.slice\(0, 100\)\); \}\n  \}\n  return calls;\n\}/,
  () => `const OB_ARG_KEYS = ['content', 'title', 'tags', 'domain', 'importance', 'feel', 'why_remembered',
  'author', 'weight', 'bucket_id', 'source_bucket', 'pinned', 'query', 'name', 'status'];

// 模型写中文正文时很容易直接打英文双引号（…你说"在吗"…），
// 那段 JSON 就是坏的，JSON.parse 一抛错整条工具调用就没了。
// 所以：先正常解析，失败了再按已知键名逐段抠回来。
function parseObArgs(raw) {
  const t = String(raw == null ? '' : raw).trim();
  try { const v = JSON.parse(t); if (v && typeof v === 'object') return v; } catch (e) {}
  const alt = OB_ARG_KEYS.join('|');
  const out = {};
  for (const k of OB_ARG_KEYS) {
    // 字符串值一直取到"下一个已知键"或"结尾的 }"为止，中间有裸引号也不怕
    const re = new RegExp('"' + k + '"\\\\s*:\\\\s*(?:"([\\\\s\\\\S]*?)"(?=\\\\s*,\\\\s*"(?:' + alt + ')"\\\\s*:|\\\\s*\\\\}\\\\s*$)|(-?\\\\d+(?:\\\\.\\\\d+)?|true|false|null))');
    const m = t.match(re);
    if (!m) continue;
    if (m[1] !== undefined) out[k] = m[1].replace(/\\\\n/g, '\\n').replace(/\\\\t/g, '\\t').replace(/\\\\"/g, '"').replace(/\\\\\\\\/g, '\\\\');
    else if (m[2] === 'null') continue;
    else out[k] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]);
  }
  return Object.keys(out).length ? out : null;
}

// 标签本身也放宽：单双引号、没引号、多余空格、后面还挂别的属性，都认
const OB_TAG_RE = /<ob\\b([^>]*)>([\\s\\S]*?)<\\/ob>/gi;

function parseOBToolCalls(text) {
  const calls = [];
  let m;
  OB_TAG_RE.lastIndex = 0;
  while ((m = OB_TAG_RE.exec(text)) !== null) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    let tool = (attrs.match(/tool\\s*=\\s*"([^"]+)"/) || attrs.match(/tool\\s*=\\s*'([^']+)'/) || attrs.match(/tool\\s*=\\s*([A-Za-z_]\\w*)/) || [])[1] || '';
    const args = parseObArgs(body);
    // 标签上没写 tool 的话，从 JSON 里找一个
    if (!tool && args && typeof args.tool === 'string') tool = args.tool;
    if (!tool || !args) {
      console.log('[OB] 这条工具调用没解析出来:', m[0].slice(0, 120));
      calls.push({ tool: tool || '未知', args: null, raw: m[0].slice(0, 200), error: !tool ? '没写 tool' : 'JSON 修不回来' });
      continue;
    }
    if (args.tool) delete args.tool;
    calls.push({ tool, args });
  }
  return calls;
}`);

// 2) 剥标签也放宽
edit('剥标签放宽',
  /function stripOBToolCalls\(text\) \{\n  return text\.replace\(\/\\s\*<ob\\s\+tool="\\w\+">\[\\s\\S\]\*\?<\\\/ob>\\s\*\/g, ''\)\.trim\(\);\n\}/,
  () => `function stripOBToolCalls(text) {
  return String(text || '').replace(/\\s*<ob\\b[^>]*>[\\s\\S]*?<\\/ob>\\s*/gi, '\\n\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
}`);

// 3) 不管解析成没成功，标签一律剥掉再存 —— 以前只在"解析出了调用"时才剥，
//    于是解析一失败，标签就原样进了历史，前端重渲染时那坨 JSON 就露出来了
edit('标签永远剥掉',
  /      const obCalls = parseOBToolCalls\(fullResponse\);\n      if \(obCalls\.length\) \{\n        fullResponse = stripOBToolCalls\(fullResponse\);\n        for \(const tc of obCalls\) \{/,
  () => `      const obCalls = parseOBToolCalls(fullResponse);
      // 无条件剥：哪怕一条都没解析出来，标签也不能留在历史里
      fullResponse = stripOBToolCalls(fullResponse);
      if (obCalls.length) {
        for (const tc of obCalls) {
          // 解析失败的，在时间轴上标出来，别让我假装写成功了
          if (!tc.args) {
            const bad = traceStart('tool', (tc.tool || 'OB') + ' · 记忆');
            bad.input = { raw: tc.raw };
            sse(res, 'trace', { action: 'input', id: bad.id, input: bad.input });
            bad.result = '没写进去：' + tc.error + '（正文里的引号要用「」，别用 "）';
            sse(res, 'trace', { action: 'result', id: bad.id, result: bad.result, is_error: true });
            traceEnd(bad, 'error');
            continue;
          }`);

// 4) 提示词里把引号这件事说清楚
edit('提示补充引号规则',
  /- 存了别告诉她，直接自然聊/,
  () => `- ⚠ JSON 正文里不要出现英文双引号 " —— 要引用她的话就用「」，
  写成 "content":"她说「随便你」最伤人"。直接打 " 会让整条 JSON 坏掉、记忆丢失
- 存了别告诉她，直接自然聊`);

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
const bak = path + '.bak-obparse-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端。写信/计划这类带长正文的调用不会再因为一个引号丢掉，标签也不会再糊在聊天框里。');
