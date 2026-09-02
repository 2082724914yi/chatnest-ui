#!/usr/bin/env node
/* 第十个补丁：带 feel 的记忆一条都存不进去。

   她那两条感受记忆被 OB 连着拒了两次，报的是：
     「feel 的 domain 固定为 feel，不能显式覆盖。」
   去掉 domain 再试，换来第二条规则：
     「feel 必须指向一条原始记忆（source_bucket 不能为空）。」

   也就是说 OB 的 feel 是"对某条已有记忆的感受"，得先有那条记忆才能挂上去，
   日常聊天里随口记个心情根本给不出 source_bucket —— 这个参数在这条路上用不了。
   上一版提示词把 feel 当成"记情绪"教给我，于是每条感受都卡死在这。

   两层保险：
     1) 提示词：别传 feel，记心情就用普通 hold + domain:"情绪"
     2) 代码兜底：真传了又没 source_bucket，就地降级成普通记忆存下来，
        别让整条记忆因为一个参数丢掉

   用法：curl -fsSL .../deploy/fix-feel-domain.js | sudo node -
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

if (!s.includes('OB_TOOL_PROMPT')) {
  console.error('这个 server.js 里没有 OB_TOOL_PROMPT，先跑 fix-ob-tools.js。');
  process.exit(1);
}
if (s.includes('feel 缺 source_bucket')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

// 1) 提示词：feel 日常用不上，别教了
edit('提示词改掉 feel 用法',
  /  feel           true = 这是一条"感受"，会进 feel 区，以后能用 feel 查回来/,
  () => `                 ⚠ 不要传 feel 参数。OB 的 feel 是"对某条已有记忆的感受"，
                   必须同时给 source_bucket 指向那条记忆，日常聊天里用不上。
                   想记心情就用普通 hold，domain 写"情绪"或"感情"即可。`);

// 1b) 规则那一行也在教 feel:true，一起改掉，不然两边打架
edit('规则行改掉 feel 用法',
  /- 感受用 hold 带 feel:true，不要用 feel（那是查询工具）/,
  () => `- 记感受就是普通 hold，domain 写"情绪"或"感情"；feel 不要传`);

// 2) 代码兜底：feel 不完整就降级成普通记忆，别让整条丢掉
edit('代码兜底 feel 参数',
  /          if \(\/\^\(hold\|grow\|plan\)\$\/\.test\(tc\.tool\) && tc\.args && tc\.args\.content\) \{/,
  () => `          // OB 对 feel 有两条硬规则：domain 会被固定成 feel（显式传就拒收），
          // 且必须带 source_bucket 指向一条已有记忆。日常记心情两条都满足不了，
          // 与其整条被拒、记忆丢掉，不如降级成普通 hold 存下来。
          if (tc.tool === 'hold' && tc.args && tc.args.feel && !tc.args.source_bucket) {
            console.log('[OB] feel 缺 source_bucket，降级为普通记忆:', String(tc.args.content).slice(0, 20));
            delete tc.args.feel;
            if (!tc.args.domain) tc.args.domain = '情绪';
          }
          if (tc.tool === 'hold' && tc.args && tc.args.feel && tc.args.domain) {
            delete tc.args.domain;   // feel 的 domain 由 OB 固定，显式传会被拒
          }
          if (/^(hold|grow|plan)$/.test(tc.tool) && tc.args && tc.args.content) {`);

// 3) REST 端点同理
edit('REST 端点也兜底',
  /  if \(feel\) args\.feel = true;/,
  () => `  // feel 需要 source_bucket 配套，前端这条路给不出来，所以只当普通记忆存
  if (feel && !args.domain) args.domain = '情绪';`);

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
const bak = path + '.bak-feel-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端。感受类记忆不会再被 OB 拒收了。');
