#!/usr/bin/env node
// Latent 页面显示错了东西，顺手把手机时间带上去。
//   node fix-latent-page.js [/var/www/chatnest/index.html]
//
// 1. 「现在还没结束的」那一栏调的是 /api/latent/recall，返回的是整段召回提示词 ——
//    她打开看到的是"以下是历史记忆片段""【自查】degradation_protocol"这些
//    写给模型的指令，真正的正文夹在中间。
//    拆成两栏：还没结束的问 unresolved，最近留下的用 recall 剥干净的那份。
//
// 2. 发消息时带上手机的本地时间和时区。后端拿它告诉我现在几点 ——
//    她界面上每条消息都有时间戳，那是前端渲染的，我一个字都看不到。
//    时间从她手机来而不是服务器：服务器在机房，她在襄阳，她换个地方服务器不会跟着动。
//
// 要先打后端的 add-latent-view.js（提供 /api/latent/unresolved 和 clean 字段）。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');

const target = process.argv[2] || '/var/www/chatnest/index.html';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('latentUnresolvedOut')) { console.log('已经打过，跳过'); process.exit(0); }

const SECTIONS = `    <div class="profile-section">
      <div class="pulse-section-title">现在还没结束的</div>
      <div id="latentUnresolvedOut"><div class="lt-empty">读取中…</div></div>
    </div>
    <div class="profile-section">
      <div class="pulse-section-title">最近留下的</div>
      <div id="latentRecall"><div class="lt-empty">读取中…</div></div>
    </div>`;

const OPENFN = `async function openLatentPage(){
  showProfilePage('latentHome');
  $('latentSearchOut').innerHTML='';
  $('latentRecall').innerHTML='<div class="lt-empty">读取中…</div>';
  $('latentUnresolvedOut').innerHTML='<div class="lt-empty">读取中…</div>';
  // 两栏各问各的，互不拖累：一边挂了另一边照样出内容
  fetch('/api/latent/unresolved').then(function(r){
    if(!r.ok)throw new Error('没连上');return r.json();
  }).then(function(d){
    var t=(d&&d.text||'').trim();
    $('latentUnresolvedOut').innerHTML=t?('<div class="lt-block">'+_esc(t)+'</div>')
      :'<div class="lt-empty">没有没结束的事。<br>干净的。</div>';
  }).catch(function(){
    $('latentUnresolvedOut').innerHTML='<div class="lt-empty">读不到。<br>可能是服务还没起来。</div>';
  });
  fetch('/api/latent/recall').then(function(r){
    if(!r.ok)throw new Error('没连上');return r.json();
  }).then(function(d){
    // clean 是剥掉系统提示词之后的正文；老后端没有这个字段，退回 text
    var t=((d&&(d.clean||d.text))||'').trim();
    $('latentRecall').innerHTML=t?('<div class="lt-block">'+_esc(t)+'</div>')
      :'<div class="lt-empty">还没留下什么。</div>';
  }).catch(function(){
    $('latentRecall').innerHTML='<div class="lt-empty">记忆库没连上。<br>可能是服务还没起来。</div>';
  });
}`;

const edits = [
  {
    name: '拆成两栏',
    find: `    <div class="profile-section">
      <div class="pulse-section-title">现在还没结束的</div>
      <div id="latentRecall"><div class="lt-empty">读取中…</div></div>
    </div>`,
    replace: SECTIONS,
  },
  {
    name: '两栏各问各的接口',
    find: /async function openLatentPage\(\)\{[\s\S]*?\n\}/,
    replace: () => OPENFN,
  },
  {
    // 每轮都带：她可能跨零点还在聊，也可能出门换了时区
    name: '发消息带上手机时间',
    find: "    body.contextCount=_settingsVal('contextCount',20);",
    replace:
      "    body.contextCount=_settingsVal('contextCount',20);\n" +
      "    // 手机上的此刻。服务器在机房，她在哪儿服务器不知道，只有这台设备知道\n" +
      "    body.clientTime=new Date().toISOString();\n" +
      "    try{body.clientTz=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){body.clientTz=''}",
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  const before = out;
  out = out.replace(e.find, e.replace);
  if (out === before) missed.push(e.name);
}

console.log('\n补丁结果：');
if (missed.length) {
  for (const e of edits) console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 锚点没匹配上' : '  √ ' + e.name);
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['文件完整', /<\/html>/i.test(out)],
  ['两栏都在', out.includes('latentUnresolvedOut') && out.includes('id="latentRecall"')],
  ['问的是 unresolved', out.includes("fetch('/api/latent/unresolved')")],
  ['recall 用剥干净的那份', /d\.clean\|\|d\.text/.test(out)],
  ['时间和时区都带上了', out.includes('body.clientTime=') && out.includes('body.clientTz')],
  ['时区拿不到不至于报错', /catch\(e\)\{body\.clientTz=''\}/.test(out)],
  ['只插了一次', (out.match(/body\.clientTime=/g) || []).length === 1
    && (out.match(/async function openLatentPage/g) || []).length === 1],
  ['没弄丢别的功能', ['pulsePanel', 'memoryPicker', 'obToolsBtn', 'editAssistantInPlace', 'latentDoSearch']
    .every(k => (src.includes(k) ? out.includes(k) : true))],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

for (const e of edits) console.log('  √ ' + e.name);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
