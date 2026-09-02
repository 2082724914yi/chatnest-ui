#!/usr/bin/env node
// memory 页开两个门：一边 Ombre Brain，一边 Latent，各进各的。
//   node add-memory-gates.js [/var/www/chatnest/index.html]
//
// 为什么是补丁不是换文件：仓库里的 index.html 会落后于线上，整份覆盖会把线上
// 才有的功能弄丢（工具台就差点这么没的）。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');

const target = process.argv[2] || '/var/www/chatnest/index.html';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('memoryPicker')) { console.log('已经打过，跳过'); process.exit(0); }

const CSS = `
/* ── 记忆两道门：液态玻璃 ── */
.mem-gates{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-top:4px}
.mem-gate{position:relative;overflow:hidden;isolation:isolate;border:0;text-align:left;
  border-radius:26px;padding:22px 17px 19px;min-height:196px;display:flex;flex-direction:column;
  color:inherit;font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent;
  background:linear-gradient(148deg,rgba(255,255,255,.34) 0%,rgba(255,255,255,.13) 52%,rgba(255,255,255,.20) 100%);
  backdrop-filter:blur(22px) saturate(185%);-webkit-backdrop-filter:blur(22px) saturate(185%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.72),inset 0 -1px 0 rgba(255,255,255,.20),
             inset 0 0 0 1px rgba(255,255,255,.26),0 10px 28px rgba(74,55,40,.10),0 2px 6px rgba(74,55,40,.05);
  transition:transform 160ms cubic-bezier(.2,.8,.3,1),box-shadow 160ms ease}
/* 斜向扫过的那道折射光，玻璃感全靠它 */
.mem-gate::before{content:"";position:absolute;inset:-40% -10%;pointer-events:none;z-index:0;
  background:linear-gradient(112deg,transparent 34%,rgba(255,255,255,.40) 47%,transparent 58%);
  opacity:.55;transition:transform 420ms ease,opacity 220ms ease}
.mem-gate:active{transform:scale(.972);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.55),inset 0 0 0 1px rgba(255,255,255,.20),0 4px 14px rgba(74,55,40,.10)}
.mem-gate:active::before{transform:translateX(14%);opacity:.75}
.mem-gate>*{position:relative;z-index:1}
.mem-gate-mark{width:34px;height:34px;border-radius:12px;display:grid;place-items:center;font-size:16px;
  margin-bottom:auto;background:rgba(255,255,255,.30);box-shadow:inset 0 0 0 1px rgba(255,255,255,.34)}
.mem-gate-name{margin-top:14px;font:600 17px/1.2 var(--font-sans);letter-spacing:.01em}
.mem-gate-sub{margin-top:5px;color:#8B7263;font-size:12.5px;line-height:1.45}
.mem-gate-meta{margin-top:9px;font-size:11.5px;letter-spacing:.03em;color:#aaa49c;display:flex;align-items:center;gap:6px}
.mem-gate-dot{width:6px;height:6px;border-radius:50%;background:#c8c2b8;flex:none}
.mem-gate-dot.on{background:#7BA05B;box-shadow:0 0 0 3px rgba(123,160,91,.18)}
.mem-gate-dot.off{background:#C17B7B;box-shadow:0 0 0 3px rgba(193,123,123,.16)}
.mem-gate-ob::after,.mem-gate-lt::after{content:"";position:absolute;z-index:0;pointer-events:none;
  width:130px;height:130px;border-radius:50%;filter:blur(26px);opacity:.34}
.mem-gate-ob::after{right:-38px;bottom:-46px;background:radial-gradient(circle,#C17B7B,transparent 68%)}
.mem-gate-lt::after{right:-38px;bottom:-46px;background:radial-gradient(circle,#7B93C1,transparent 68%)}
.mem-hint{color:#aaa49c;font-size:12px;line-height:1.75;text-align:center;padding:26px 20px 4px}

/* Latent 页 */
.lt-block{white-space:pre-wrap;word-break:break-word;font-size:14.5px;line-height:1.72;color:#4A3728;
  background:rgba(255,255,255,.14);box-shadow:inset 0 0 0 1px rgba(0,0,0,.07);border-radius:22px;padding:16px 17px;
  backdrop-filter:blur(1px) saturate(1.05);-webkit-backdrop-filter:blur(1px) saturate(1.05)}
.lt-empty{padding:22px;border-radius:22px;border:1px solid rgba(32,31,29,.10);color:#77736c;text-align:center;
  font-size:14.5px;line-height:1.6}
.lt-search{display:flex;gap:9px;align-items:center}
.lt-search input{flex:1;min-width:0;border:0;outline:0;border-radius:999px;padding:12px 16px;font:400 15px/1.3 var(--font-sans);
  color:#201f1d;background:rgba(255,255,255,.20);box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
.lt-search button{flex:none;border:0;border-radius:999px;padding:12px 17px;font-size:14px;
  background:rgba(255,255,255,.24);box-shadow:inset 0 0 0 1px rgba(0,0,0,.08);color:#4A3728}

html[data-chat-bg="dark"] .mem-gate,body.dark .mem-gate{
  background:linear-gradient(148deg,rgba(255,255,255,.16) 0%,rgba(255,255,255,.05) 52%,rgba(255,255,255,.10) 100%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.24),inset 0 0 0 1px rgba(255,255,255,.12),0 10px 28px rgba(0,0,0,.28)}
html[data-chat-bg="dark"] .mem-gate::before,body.dark .mem-gate::before{opacity:.30}
html[data-chat-bg="dark"] .mem-gate-mark,body.dark .mem-gate-mark{background:rgba(255,255,255,.12);box-shadow:inset 0 0 0 1px rgba(255,255,255,.16)}
html[data-chat-bg="dark"] .mem-gate-name,body.dark .mem-gate-name,
html[data-chat-bg="dark"] .lt-block,body.dark .lt-block{color:#F4F3EF}
html[data-chat-bg="dark"] .mem-gate-sub,body.dark .mem-gate-sub{color:rgba(244,243,239,.56)}
html[data-chat-bg="dark"] .mem-gate-meta,body.dark .mem-gate-meta,
html[data-chat-bg="dark"] .mem-hint,body.dark .mem-hint{color:rgba(244,243,239,.42)}
html[data-chat-bg="dark"] .lt-empty,body.dark .lt-empty{border-color:rgba(255,255,255,.12);color:rgba(244,243,239,.56)}
html[data-chat-bg="dark"] .lt-search input,body.dark .lt-search input,
html[data-chat-bg="dark"] .lt-search button,body.dark .lt-search button{color:#F4F3EF;background:rgba(255,255,255,.10);box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}
`;

const PICKER_HTML = `  <div class="profile-page active" id="memoryPicker">
    <header class="profile-header">
      <button class="profile-round-button" id="closeMemoryPicker" type="button" aria-label="Close">×</button>
      <div class="profile-title">记忆</div>
      <span></span>
    </header>
    <div class="mem-gates">
      <button class="mem-gate mem-gate-ob" id="gateOB" type="button">
        <span class="mem-gate-mark">◈</span>
        <span class="mem-gate-name">Ombre Brain</span>
        <span class="mem-gate-sub">该记住的那些<br>每次开窗自己浮上来</span>
        <span class="mem-gate-meta"><i class="mem-gate-dot" id="gateOBDot"></i><span id="gateOBMeta">连接中…</span></span>
      </button>
      <button class="mem-gate mem-gate-lt" id="gateLatent" type="button">
        <span class="mem-gate-mark">◇</span>
        <span class="mem-gate-name">Latent</span>
        <span class="mem-gate-sub">完整的那些<br>问到了才翻出来</span>
        <span class="mem-gate-meta"><i class="mem-gate-dot" id="gateLTDot"></i><span id="gateLTMeta">连接中…</span></span>
      </button>
    </div>
    <div class="mem-hint">一边是浮现，一边是显影。<br>该主动想起的走左边，要一字不差翻出来的走右边。</div>
  </div>

  <div class="profile-page" id="latentHome">
    <header class="profile-header">
      <button class="profile-back-button" id="latentBack" type="button" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
      <div class="profile-title">Latent</div>
      <button class="profile-round-button" id="latentRefresh" type="button" aria-label="Refresh">↻</button>
    </header>
    <div class="profile-section">
      <div class="pulse-section-title">翻一段</div>
      <div class="lt-search">
        <input id="latentQuery" type="text" placeholder="想不起来的那件事…" autocomplete="off" spellcheck="false">
        <button id="latentGo" type="button">查</button>
      </div>
      <div id="latentSearchOut"></div>
    </div>
    <div class="profile-section">
      <div class="pulse-section-title">现在还没结束的</div>
      <div id="latentRecall"><div class="lt-empty">读取中…</div></div>
    </div>
  </div>

`;

const JS = `
/* ── 记忆两道门：OB / Latent ── */
function openMemoryPicker(){
  var p=$('memoryPanel');
  p.classList.add('show');p.setAttribute('aria-hidden','false');
  showProfilePage('memoryPicker');
  refreshMemoryGates();
}
function closeMemoryPanel(){
  var p=$('memoryPanel');
  p.classList.remove('show');p.setAttribute('aria-hidden','true');
}
async function refreshMemoryGates(){
  // OB
  try{
    var r=await fetch('/api/ombre-dashboard/status');var d=await r.json();
    var n=(d&&(d.bucket_count||d.buckets||d.count));
    $('gateOBDot').className='mem-gate-dot '+(d&&d.ok!==false?'on':'off');
    $('gateOBMeta').textContent=(n||n===0)?(n+' 条'):(d&&d.ok!==false?'已连接':'没连上');
  }catch(e){$('gateOBDot').className='mem-gate-dot off';$('gateOBMeta').textContent='没连上'}
  // Latent
  try{
    var r2=await fetch('/api/latent/status');var d2=await r2.json();
    if(!d2.enabled){$('gateLTDot').className='mem-gate-dot';$('gateLTMeta').textContent='还没接'}
    else{
      $('gateLTDot').className='mem-gate-dot '+(d2.alive?'on':'off');
      $('gateLTMeta').textContent=d2.alive?((d2.tools&&d2.tools.length||0)+' 个工具'):'没连上';
    }
  }catch(e){$('gateLTDot').className='mem-gate-dot off';$('gateLTMeta').textContent='没连上'}
}
async function openLatentPage(){
  showProfilePage('latentHome');
  $('latentSearchOut').innerHTML='';
  $('latentRecall').innerHTML='<div class="lt-empty">读取中…</div>';
  try{
    var r=await fetch('/api/latent/recall');
    if(!r.ok){$('latentRecall').innerHTML='<div class="lt-empty">记忆库没连上。<br>可能是服务还没起来。</div>';return}
    var d=await r.json();
    $('latentRecall').innerHTML=d.text?('<div class="lt-block">'+_esc(d.text)+'</div>')
      :'<div class="lt-empty">现在没有没结束的事。<br>干净的。</div>';
  }catch(e){$('latentRecall').innerHTML='<div class="lt-empty">'+_esc(String(e.message||e))+'</div>'}
}
async function latentDoSearch(){
  var q=($('latentQuery').value||'').trim();
  if(!q){$('latentSearchOut').innerHTML='';return}
  $('latentSearchOut').innerHTML='<div class="lt-empty">翻找中…</div>';
  try{
    var r=await fetch('/api/latent/search?q='+encodeURIComponent(q));
    if(!r.ok){$('latentSearchOut').innerHTML='<div class="lt-empty">记忆库没连上</div>';return}
    var d=await r.json();
    $('latentSearchOut').innerHTML=d.text?('<div class="lt-block">'+_esc(d.text)+'</div>')
      :'<div class="lt-empty">没找到。<br>换个更具体的说法再试试。</div>';
  }catch(e){$('latentSearchOut').innerHTML='<div class="lt-empty">'+_esc(String(e.message||e))+'</div>'}
}
(function(){
  var c=$('closeMemoryPicker'); if(!c)return;
  c.addEventListener('click',closeMemoryPanel);
  $('gateOB').addEventListener('click',function(){showProfilePage('obHome');loadOBData()});
  $('gateLatent').addEventListener('click',openLatentPage);
  $('latentBack').addEventListener('click',function(){showProfilePage('memoryPicker');refreshMemoryGates()});
  $('latentRefresh').addEventListener('click',openLatentPage);
  $('latentGo').addEventListener('click',latentDoSearch);
  $('latentQuery').addEventListener('keydown',function(e){if(e.key==='Enter')latentDoSearch()});
})();
`;

const edits = [
  { name: '玻璃门样式', find: '/* ── Pulse：身体状态', replace: CSS + '\n/* ── Pulse：身体状态' },
  {
    name: '两道门 + Latent 页',
    find: '  <div class="profile-page active" id="obHome">',
    replace: PICKER_HTML + '  <div class="profile-page" id="obHome">',
  },
  {
    name: 'showProfilePage 认得新页面',
    find: "function showProfilePage(id){if(id!=='obHome')renderProfile();['obHome','profileHome','savedMemoriesPage','memorySummaryPage','preferencesPage']",
    replace: "function showProfilePage(id){if(id!=='obHome'&&id!=='memoryPicker'&&id!=='latentHome')renderProfile();['memoryPicker','latentHome','obHome','profileHome','savedMemoriesPage','memorySummaryPage','preferencesPage']",
  },
  {
    name: '首页 Memory 卡片先进门厅',
    find: "if(page==='memory'){enterChat();setTimeout(function(){$('memoryPanel').classList.add('show');$('memoryPanel').setAttribute('aria-hidden','false');showProfilePage('obHome');loadOBData()},200);return}",
    replace: "if(page==='memory'){enterChat();setTimeout(openMemoryPicker,200);return}",
  },
  { name: '门厅脚本', find: '\n/* ── Pulse：小衍的身体状态 ──', replace: '\n' + JS + '\n/* ── Pulse：小衍的身体状态 ──' },
];

let out = src;
const missed = [];
for (const e of edits) {
  if (!out.includes(e.find)) { missed.push(e.name); continue; }
  out = out.replace(e.find, e.replace);
}

console.log('\n补丁结果：');
if (missed.length) {
  for (const e of edits) console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 锚点没匹配上' : '  √ ' + e.name);
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['文件完整', /<\/html>/i.test(out)],
  ['两道门在', out.includes('gateOB') && out.includes('gateLatent')],
  ['Latent 页在', out.includes('latentHome') && out.includes('openLatentPage')],
  ['没弄丢记忆页', out.includes('id="obHome"') && out.includes('loadOBData')],
  ['没弄丢 Pulse', src.includes('pulsePanel') ? out.includes('pulsePanel') : true],
  ['没弄丢工具台', src.includes('obToolsBtn') ? out.includes('obToolsBtn') : true],
  ['obHome 不再抢默认页', !out.includes('<div class="profile-page active" id="obHome">')],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

for (const e of edits) console.log('  √ ' + e.name);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  ' + src.length + ' → ' + out.length + ' 字符');
console.log('  备份: ' + backup);
