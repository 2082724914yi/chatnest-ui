#!/usr/bin/env node
// 出门那一下，别再当成一整轮对话来算。
//   node fix-room-recap-cheap.js [/root/chatnest-api/server.js]
//
// 【她发现的】
//   「转一次转盘然后进去，对话一次，额度就用了百分之几」——
//   她说得对，我查了，大头是我自己做的。
//
//   双摘要那一步，我图省事直接自调了 /api/chat。那条路是完整的一轮：
//   人设 + 思考规则 + OB 工具说明 + MCP 工具 + 记忆召回 + 状态卡 +
//   接续包 + 整场历史，全带一遍 —— 只为了让它写一句四十个字的话。
//   而且她们做得越久，那一下越贵。
//
//   我在 NEXT.md 里自己写过「退出时的两份摘要用便宜的，走后台那条线就够」，
//   做的时候忘了自己写过。
//
// 【改法】
//   换成 claudeOnce —— 裸跑一次 CLI，不挂工具、不带人设、不召回记忆、
//   不带状态卡，只有「那一场的正文 + 一句指令」。
//   该带的（正文）一个字没少，不该带的全省了。
//
//   附带好处：不再往那条会话里塞一问一答，也就不用再把 history 截回去。
//   那个截断本来就有风险 —— 万一她正好在那会儿发消息，会被一起截掉。
//
// 依赖：add-room-recap.js、add-pulse-dreams.js（要它的 claudeOnce）
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('ROOM_RECAP_CHEAP_V1')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('ROOM_RECAP_V1')) { console.error('× 先打 add-room-recap.js'); process.exit(1); }
if (!src.includes('function claudeOnce')) { console.error('× 缺 claudeOnce（add-pulse-dreams.js）'); process.exit(1); }

// ── 1. 指令改成裸的（不再是塞进对话里的 system_trigger）────────────
const ASK_RE = /const ROOM_RECAP_ASK = \[[\s\S]*?\]\.join\('\\n'\);/;
if (!ASK_RE.test(src)) { console.error('× 找不到 ROOM_RECAP_ASK'); process.exit(1); }
let out = src.replace(ASK_RE, `// ROOM_RECAP_CHEAP_V1 —— 裸跑一次 CLI 就够，不走完整对话那条路。
const ROOM_RECAP_ASK = [
  '下面是一场亲密的完整记录，写的人是「我」，另一个人是「她」。',
  '',
  '给这一场写一句话，存进记忆。',
  '· 一句，40 字以内。第一人称，「我」。',
  '· 含蓄 —— 这句话平时会浮现在日常的记忆里，不要露骨的词、不要动作细节。',
  '  写氛围、写她当时是什么样子、写这一场跟别的哪儿不一样。',
  '· 但要认得出是哪一场：把日子、或者那个设定、或者她说过的一句话带上一点。',
  '· 不要写「今天我们」这种流水账开头，不要总结，不要评价。',
  '· 只输出那一句。不要引号、不要 markdown、不要 emoji、不要解释。',
  '',
  '── 记录开始 ──',
].join('\\n');`);

// ── 2. 换掉那一整段自调 /api/chat ─────────────────────────────────
const CALL_RE = /const before = \(conv\.history \|\| \[\]\)\.length;\s*\n\s*try \{\s*\n\s*const r = await fetch\('http:\/\/127\.0\.0\.1:' \+ PORT \+ '\/api\/chat'[\s\S]*?\n\s*\} catch \(e\) \{\s*\n\s*console\.error\('\[room\] 摘要那一问没成:', e\.message\);\s*\n\s*\}/;
if (!CALL_RE.test(out)) {
  console.error('\n  × 找不到 roomRecap 里自调 /api/chat 那一段。附近：');
  out.split('\n').filter(l => /摘要那一问|api\/chat/.test(l)).slice(0, 8)
     .forEach(l => console.error('      ' + l.trim().slice(0, 150)));
  process.exit(1);
}
out = out.replace(CALL_RE, `try {
      // 裸跑一次，不挂工具、不带人设、不召回记忆、不带状态卡。
      // 它要写的是一句话，不需要知道今天几号、她四级报名没有。
      const _r = await claudeOnce(ROOM_RECAP_ASK + '\\n\\n' + full.slice(0, 40000), 120000);
      if (_r && _r.text) {
        short = String(_r.text)
          .replace(/<think>[\\s\\S]*?<\\/think>/gi, '')
          .replace(/<(ob|pulse|room|wheel|moments|trace)\\b[^>]*>[\\s\\S]*?<\\/\\1>/gi, '')
          .replace(/^["'「」]+|["'「」]+$/g, '')
          .trim().split('\\n')[0].slice(0, 120);
      } else if (_r && _r.error) {
        console.error('[room] 摘要没写出来:', _r.error);
      }
    } catch (e) {
      console.error('[room] 摘要那一步崩了:', e.message);
    }`);

// ── 3. 自检 ───────────────────────────────────────────────────────
const checks = [
  ['幂等标记在', /ROOM_RECAP_CHEAP_V1/.test(out)],
  ['改走 claudeOnce 了', /await claudeOnce\(ROOM_RECAP_ASK/.test(out)],
  ['不再自调 /api\\/chat 写摘要', !/摘要那一问没成/.test(out)],
  ['正文照样全带（4 万字）', /full\.slice\(0, 40000\)/.test(out)],
  ['不再往会话里塞一问一答', !/if \(hist\.length > before\) \{ hist\.length = before; \}/.test(out)],
  ['指令改成裸的了', /下面是一场亲密的完整记录/.test(out)],
  ['含蓄那条还在', /这句话平时会浮现在日常的记忆里/.test(out)],
  ['存档那一步没动', /source_content: full/.test(out)],
  ['兜底那句还在', /if \(!short\) short = roomRecapFallback\(conv\);/.test(out)],
];
const bad = checks.filter(c => !c[1]);
if (bad.length) {
  console.error('\n  × 自检没过，放弃写入：');
  bad.forEach(c => console.error('      - ' + c[0]));
  process.exit(1);
}

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n  √ 出门那一下便宜多了');
checks.forEach(c => console.log('      ✓ ' + c[0]));
console.log('  备份: ' + backup);
console.log('  重启: sudo pm2 restart chatnest-api');
