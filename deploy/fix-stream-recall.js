#!/usr/bin/env node
/* 第二个补丁：
   1) 不再探测 CLI 是否支持 --include-partial-messages，直接带上。
      原来的探测跑 `claude --help` 只等 10 秒，而这台机器 CLI 启动要 16 秒，
      每次都超时被 kill，于是判定"不支持"，流式参数从来没加上过。
   2) breath 不再每句话都调：新开对话的第一条自动回忆一次；
      聊天中途只有明确提到回忆/记得/上次这类词才查，平时不打扰。

   用法：curl -fsSL .../deploy/fix-stream-recall.js | sudo node -
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
  console.error('这个 server.js 还没打第一个补丁，先跑 patch-server.js');
  process.exit(1);
}
if (s.includes('CHATNEST_NO_PARTIAL')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

// ---- 1. 流式参数：去掉探测，直接带上 ----
edit('流式参数直接启用',
  /const partialFlag = cliSupportsPartial \? ' --include-partial-messages' : '';/,
  () => `// CLI 启动本身就要十几秒，用 --help 探测必然超时误判，所以不再探测直接带上。
  // 万一将来 CLI 不认这个参数，设环境变量 CHATNEST_NO_PARTIAL=1 可临时关掉。
  const partialFlag = process.env.CHATNEST_NO_PARTIAL ? '' : ' --include-partial-messages';`);

// 探测函数留着但不再决定行为，只打印信息；顺便把超时放宽
edit('探测超时放宽到 45 秒',
  /setTimeout\(\(\) => \{ if \(!p\.killed\) p\.kill\('SIGTERM'\); \}, 10000\);\s*\n\s*\} catch \(e\) \{ console\.error\('\[CLI\] detect error:', e\.message\); \}/,
  () => `setTimeout(() => { if (!p.killed) p.kill('SIGTERM'); }, 45000);
  } catch (e) { console.error('[CLI] detect error:', e.message); }`);

// ---- 2. 记忆召回：只在开窗第一条 / 明确提到回忆时 ----
edit('记忆召回改为按需',
  /  \/\/ Fetch memories with visible tool events \(10s timeout\)\n  const recallTrace = traceStart\([\s\S]*?if \(memories\) console\.log\('\[OB\] got memories for:', message\.slice\(0, 30\)\);/,
  () => `  // 记忆不再每句话都查：新开对话的第一条自动回忆一次（相当于"搬家先 breath"），
  // 聊天中途只有她明确提到回忆/记得/上次这类词才去查，其余时候不打扰。
  const isFirstTurn = conv.history.filter(m => m.role === 'user').length <= 1;
  const wantsRecall = /回忆|记得|记不记得|还记|想起|上次|上回|之前|以前|那次|说过|忘了|忘记|提过|聊过/.test(message);
  let memories = null;
  if (isFirstTurn || wantsRecall) {
    const recallTrace = traceStart('tool', isFirstTurn ? 'breath · 浮现记忆' : 'breath_search · 回忆');
    recallTrace.input = isFirstTurn ? {} : { query: message.slice(0, 50) };
    sse(res, 'trace', { action: 'input', id: recallTrace.id, input: recallTrace.input });
    try {
      // 开窗第一条只取浮现记忆；她主动提回忆时才按关键词检索
      const job = isFirstTurn ? obCall('breath', {}) : obCall('breath_search', { query: message });
      const raw = await Promise.race([job, new Promise(r => setTimeout(() => r(null), 10000))]);
      if (raw) memories = raw.length > 3000 ? raw.slice(0, 3000) + '...' : raw;
    } catch (e) { console.error('[OB] recall error:', e.message); }
    recallTrace.result = memories || '暂无相关记忆';
    sse(res, 'trace', { action: 'result', id: recallTrace.id, result: recallTrace.result });
    traceEnd(recallTrace);
    console.log(\`[OB] \${isFirstTurn ? 'breath' : 'breath_search'} -> \${memories ? memories.length + ' 字' : '空'}\`);
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
const bak = path + '.bak2-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端后，发条长一点的消息试试（比如"跟我说说今天"），字应该边生成边出来。');
