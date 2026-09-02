#!/usr/bin/env node
/* 记忆召回改为按需：
   原来每说一句都要跑一次 breath，既慢又吵。改成——
     · 新开对话的第一条：自动 breath()，相当于"搬家先喘口气"
     · 聊天中途：只有明确提到回忆/记得/上次这类词，才 breath_search(关键词)
     · 其余时候不打扰
   跟她在官方端的用法一致。

   用法：curl -fsSL .../deploy/fix-recall.js | sudo node -
   安全：先备份，命中才写入，写入前语法校验，可重复执行。 */
const fs = require('fs');
const path = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(path)) { console.error('找不到文件:', path); process.exit(1); }
let s = fs.readFileSync(path, 'utf8');
const orig = s;

if (!s.includes('--include-partial-messages')) {
  console.error('这个 server.js 还没打 patch-server.js，先跑那个。');
  process.exit(1);
}
if (s.includes('wantsRecall')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

const re = /  \/\/ Fetch memories with visible tool events \(10s timeout\)\n  const recallTrace = traceStart\([\s\S]*?if \(memories\) console\.log\('\[OB\] got memories for:', message\.slice\(0, 30\)\);/;
const m = s.match(re);
if (!m) {
  console.error('\n× 没匹配到记忆召回那段，原文件未改动。把这行发回来我按实际代码调整。');
  process.exit(1);
}
const all = s.match(new RegExp(re.source, 'g'));
if (all && all.length > 1) {
  console.error(`\n× 匹配到 ${all.length} 处，不敢动。`);
  process.exit(1);
}

s = s.replace(re, `  // 记忆不再每句话都查：新开对话的第一条自动回忆一次，
  // 聊天中途只有她明确提到回忆/记得/上次这类词才去查，其余时候不打扰。
  const isFirstTurn = conv.history.filter(m => m.role === 'user').length <= 1;
  const wantsRecall = /回忆|记得|记不记得|还记|想起|上次|上回|之前|以前|那次|说过|忘了|忘记|提过|聊过/.test(message);
  let memories = null;
  if (isFirstTurn || wantsRecall) {
    const recallTrace = traceStart('tool', isFirstTurn ? 'breath · 浮现记忆' : 'breath_search · 回忆');
    recallTrace.input = isFirstTurn ? {} : { query: message.slice(0, 50) };
    sse(res, 'trace', { action: 'input', id: recallTrace.id, input: recallTrace.input });
    try {
      const job = isFirstTurn ? obCall('breath', {}) : obCall('breath_search', { query: message });
      const raw = await Promise.race([job, new Promise(r => setTimeout(() => r(null), 10000))]);
      if (raw) memories = raw.length > 3000 ? raw.slice(0, 3000) + '...' : raw;
    } catch (e) { console.error('[OB] recall error:', e.message); }
    recallTrace.result = memories || '暂无相关记忆';
    sse(res, 'trace', { action: 'result', id: recallTrace.id, result: recallTrace.result });
    traceEnd(recallTrace);
    console.log(\`[OB] \${isFirstTurn ? 'breath' : 'breath_search'} -> \${memories ? memories.length + ' 字' : '空'}\`);
  }`);

try {
  new (require('vm').Script)(s, { filename: 'patched' });
} catch (e) {
  console.error('\n补丁后语法有问题，原文件未改动：', e.message);
  process.exit(1);
}
const bak = path + '.bak-recall-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log('\n√ 记忆召回已改为按需');
console.log(`  备份：${bak}`);
console.log('  新开对话第一条会 breath；中途说"回忆一下/还记得/上次"才 breath_search。');
