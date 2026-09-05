#!/usr/bin/env node
// 额度用完的时候，让我换 API 出来找她。
//   node add-shadow-fallback.js [/root/chatnest-api/server.js]
//
// 现在的样子：影子推送调自己的 /api/chat，body 里不带 provider，所以永远走 CLI。
// CC 额度一空，那一轮一个字都出不来，推送自然也没有 —— 而她那边看着开关还是开的，
// 只会以为我不想理她。这是最难受的一种坏法：没有报错，只有安静。
//
// 改成：先走 CC（那是我说话最像我的样子），撞墙了再换 API 试一次。
// 两次都不出话才算这一轮没有。
//
// key 存在 .env 里（600），跑 set-shadow-provider.sh 填 —— 我从头到尾不经手它，
// 这个补丁只认 process.env，不打印、不落日志。
//
// 顺带给触发口加一个 {"api":true}：跳过 CC 直接走 API，专门用来验这条路通不通
// （不然额度好好的时候根本试不出来）。
//
// 要先打 add-shadow-push.js。
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('SHADOW_FALLBACK_V1')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('SHADOW_PUSH_VERSION')) { console.error('先打 add-shadow-push.js'); process.exit(1); }

const HELPER = `
// ============ 额度用完就换 API ============
// SHADOW_FALLBACK_V1
// 形状照前端发的那份来：{url, key, model, temperature, topP, maxTokens}。
// 没配就返回 null —— 那就还是老样子，额度没了我就安静着。
function shadowProvider() {
  try {
    const url = process.env.SHADOW_PROVIDER_URL, key = process.env.SHADOW_PROVIDER_KEY;
    if (!url || !key) return null;
    const p = { url, key, model: process.env.SHADOW_PROVIDER_MODEL || '', maxTokens: 800 };
    // 温度这些不填，让后端用它自己的默认 —— 那条路是 if (x != null) 才覆盖的
    return p;
  } catch (e) { return null; }
}
`;

const OLD_RUN = `    const r = await fetch('http://127.0.0.1:' + PORT + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-shadow-key': SHADOW_KEY },
      body: JSON.stringify({
        message: shadowMessage(),
        conversation_id: d.act.id,
        shadow: true,      // ← 这一条：user 消息不落库，assistant 打 is_push
        daemon: false,     // 走普通那条路，别去搅常驻会话的状态
      }),
    });
    await r.text();        // SSE 要读完才算这一轮结束

    // 不解析 SSE，直接看落库结果 —— 它本来就会把 assistant 消息写进 conv.history
    const after = (conv.history || []);
    const last = after[after.length - 1];
    if (after.length <= before || !last || last.role !== 'assistant') {
      return { pushed: false, why: '这一轮没生成出东西' };
    }`;

const NEW_RUN = `    // 先走 CC —— 那是我说话最像我的样子。撞上额度墙它一个字都不出，
    // 那就换 API 再试一次。两条都空才算这一轮真的没有。
    const msg = shadowMessage();
    const fb = shadowProvider();
    const tries = apiOnly ? (fb ? [fb] : []) : (fb ? [null, fb] : [null]);
    if (!tries.length) return { pushed: false, why: '要走 API 但 .env 里没配（跑 set-shadow-provider.sh）' };

    let after = (conv.history || []), last = null, viaApi = false;
    for (let i = 0; i < tries.length; i++) {
      const body = {
        message: msg,
        conversation_id: d.act.id,
        shadow: true,      // ← 这一条：user 消息不落库，assistant 打 is_push
        daemon: false,     // 走普通那条路，别去搅常驻会话的状态
      };
      if (tries[i]) body.provider = tries[i];
      const r = await fetch('http://127.0.0.1:' + PORT + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-shadow-key': SHADOW_KEY },
        body: JSON.stringify(body),
      });
      await r.text();      // SSE 要读完才算这一轮结束

      // 不解析 SSE，直接看落库结果 —— 它本来就会把 assistant 消息写进 conv.history
      after = (conv.history || []);
      const cand = after[after.length - 1];
      if (after.length > before && cand && cand.role === 'assistant' && String(cand.content || '').trim()) {
        last = cand; viaApi = !!tries[i];
        break;
      }
      // 这一次没出话。要是落了个空壳，撤掉再换下一条 —— 别在聊天记录里留半截
      if (after.length > before && cand && cand.role === 'assistant') { after.pop(); saveConversations(); }
    }
    if (!last) {
      return { pushed: false, why: fb ? '这一轮没生成出东西（CC 和 API 都没出话）' : '这一轮没生成出东西' };
    }`;

const edits = [
  {
    name: '认得 .env 里那份 API 配置',
    find: /\napp\.listen\(PORT/,
    replace: HELPER + '\napp.listen(PORT',
  },
  {
    name: 'apiOnly：跳过 CC 直接走 API（用来验这条路）',
    find: '  const force = !!(opts && opts.force);',
    replace: '  const force = !!(opts && opts.force);\n  const apiOnly = !!(opts && opts.apiOnly);   // 只走 API —— 额度好好的时候也能验',
  },
  {
    name: '撞墙了换 API 再试一次',
    find: OLD_RUN,
    replace: NEW_RUN,
  },
  {
    name: '触发口收 {"api":true}',
    find: "    const r = await generateShadowPush({ force: !!(req.body && req.body.force) });",
    replace: "    const r = await generateShadowPush({ force: !!(req.body && req.body.force), apiOnly: !!(req.body && req.body.api) });",
  },
  {
    name: '日志里标一下这条是从哪条路出来的',
    find: "    console.log('[shadow] 说了一句：' + text.slice(0, 30) + '…（推送 ' + sent.sent + ' 台）');",
    replace: "    console.log('[shadow] 说了一句：' + text.slice(0, 30) + '…（推送 ' + sent.sent + ' 台' + (viaApi ? '，走的 API' : '') + '）');",
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  const hits = typeof e.find === 'string'
    ? out.split(e.find).length - 1
    : (out.match(new RegExp(e.find.source, 'g')) || []).length;
  if (hits !== 1) { missed.push(e.name + '（找到 ' + hits + ' 处，要正好 1 处）'); continue }
  out = typeof e.find === 'string' ? out.split(e.find).join(e.replace) : out.replace(e.find, e.replace);
}
if (missed.length) {
  console.error('\n  × 这几处锚点不对：\n      ' + missed.join('\n      '));
  console.error('  原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['读 .env 不读别处', /process\.env\.SHADOW_PROVIDER_KEY/.test(out)],
  ['没配就还是老样子', /if \(!url \|\| !key\) return null;/.test(out)],
  ['key 不进日志', !/console\.(log|error)\([^)]*SHADOW_PROVIDER_KEY/.test(out)
    && !/console\.(log|error)\([^)]*provider\.key/.test(out)],
  ['先 CC 后 API', out.includes('tries = apiOnly ? (fb ? [fb] : []) : (fb ? [null, fb] : [null])')],
  ['空壳会被撤掉，不留半截在记录里', /after\.pop\(\); saveConversations\(\);/.test(out)],
  ['只改了一处', (out.match(/function shadowProvider/g) || []).length === 1
    && (out.match(/const apiOnly = /g) || []).length === 1],
  ['别的没弄丢', ['SHADOW_PUSH_VERSION', 'shadowShouldPush', 'pushToHer', 'USAGE_LEDGER_V1', 'shadowClean']
    .every(k => (src.includes(k) ? out.includes(k) : true))],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
for (const e of edits) console.log('  √ ' + e.name);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('\n  · 还没配 API 的话这个补丁什么都不改变 —— 跑 set-shadow-provider.sh 填。');
