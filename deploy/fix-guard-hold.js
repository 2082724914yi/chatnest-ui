#!/usr/bin/env node
/* 第八个补丁：拦住会让打标模型失控的内容。

   账单实据：9 月 1 日和 2 日各有一次 hold，输出 655.5K tokens、合计 7.21 元，
   占当月账单的 96.8%；其余 137 次调用加起来才 0.24 元。两次的 token 数几乎
   一模一样（655466 / 655454），说明不是"写得多"，是模型陷入重复生成、
   一路吐到撞上限。两次触发内容都是"测试"这类极短、无信息量的字。
   内容越空洞，打标模型越没依据，越容易开始车轱辘话
   （轻症版就是"测试"两个字被打了 18 个标签）。

   两道闸：
     1) 内容太短或明显是测试字样的，直接不往 OB 写
     2) 写进去的都自带 title/tags/domain，让打标模型少自由发挥

   用法：curl -fsSL .../deploy/fix-guard-hold.js | sudo node -
   安全：先备份，写入前语法校验，可重复执行。 */
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

if (!s.includes('parseOBToolCalls')) {
  console.error('这个 server.js 结构不对，先跑前面的补丁。');
  process.exit(1);
}
if (s.includes('worthRemembering')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

// 1) 判断函数
edit('新增内容价值判断',
  /function parseOBToolCalls\(text\) \{/,
  () => `// 值不值得写进 OB。挡的是会让打标模型失控的空洞内容：
// 账单上两次 655K tokens 的失控输出（7.21 元，占当月 96.8%）都由"测试"这类字触发。
function worthRemembering(content) {
  const t = String(content || '').trim();
  if (t.length < 6) return { ok: false, why: '太短（不足 6 字），打标模型容易空转' };
  // 纯测试字样、纯数字、纯符号，都不值得占一条记忆
  if (/^(测试|test|試し|123|abc|aaa|哈哈|嗯嗯|。。。)[\\s\\d]*$/i.test(t))
    return { ok: false, why: '看着是测试内容' };
  if (!/[\\u4e00-\\u9fa5a-zA-Z]/.test(t)) return { ok: false, why: '没有实际文字' };
  const uniq = new Set(t.replace(/\\s/g, '')).size;
  if (uniq <= 2) return { ok: false, why: '内容重复度过高' };
  return { ok: true };
}

function parseOBToolCalls(text) {`);

// 2) 我主动存的时候过一遍
edit('AI 主动存记忆时把关',
  /        for \(const tc of obCalls\) \{\n          const t = traceStart\('tool', tc\.tool \+ ' · 记忆'\);/,
  () => `        for (const tc of obCalls) {
          // 空洞内容不写 OB —— 打标模型会在这种输入上失控烧钱
          if (/^(hold|grow|plan)$/.test(tc.tool) && tc.args && tc.args.content) {
            const v = worthRemembering(tc.args.content);
            if (!v.ok) { console.log(\`[OB] 跳过写入（\${v.why}）:\`, String(tc.args.content).slice(0, 20)); continue; }
          }
          const t = traceStart('tool', tc.tool + ' · 记忆');`);

// 3) 前端存记忆时也过一遍
edit('前端存记忆时把关',
  /app\.post\('\/api\/profile\/memory', async \(req, res\) => \{\n  const content = String\(\(req\.body && req\.body\.content\) \|\| ''\)\.trim\(\);\n  if \(!content\) return res\.status\(400\)\.json\(\{ error: 'content required' \}\);/,
  () => `app.post('/api/profile/memory', async (req, res) => {
  const content = String((req.body && req.body.content) || '').trim();
  if (!content) return res.status(400).json({ error: 'content required' });
  {
    // 太短/空洞的不同步去 OB（本地照存，只是不触发打标）
    const v = worthRemembering(content);
    if (!v.ok) {
      const item = { id: 'mem-' + uid(), content, enabled: true, source: 'manual', createdAt: Date.now(), updatedAt: Date.now(), obSynced: false, skipOb: true };
      profile.savedMemories.unshift(item);
      profile.updatedAt = Date.now();
      saveProfileFile();
      console.log(\`[profile] 本地已存，不同步 OB（\${v.why}）:\`, content.slice(0, 20));
      return res.json({ ok: true, memory: item, note: v.why });
    }
  }`);

// 4) 补同步时也别捡起这些
edit('补同步跳过被标记的',
  /  const pending = \(profile\.savedMemories \|\| \[\]\)\.filter\(m => !m\.obSynced && m\.content && m\.content\.trim\(\)\);/,
  () => `  const pending = (profile.savedMemories || []).filter(m => !m.obSynced && !m.skipOb && m.content && m.content.trim() && worthRemembering(m.content).ok);`);

// 5) 提示里也说一句
edit('提示补充不存什么',
  /- 不是每句都要存：闲聊、已经记过的、临时的问题，都不存/,
  () => `- 不是每句都要存：闲聊、已经记过的、临时的问题，都不存
- 绝对不要存"测试""1""哈哈"这种没内容的字 —— 打标模型会在这种输入上失控空转烧钱`);

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
const bak = path + '.bak-guard-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端。以后"测试"这类内容不会再写进 OB，也就不会再触发那种失控调用。');
