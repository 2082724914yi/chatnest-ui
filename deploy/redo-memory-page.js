#!/usr/bin/env node
// 记忆页改成一层：点进去直接是 OB，顶上切到 Latent。顺带把标题调成主页那个调子。
//   node redo-memory-page.js [/var/www/chatnest/index.html]
//
// 她说的：「不要这种点进去又点进去，一点进去就是 ob，然后顶上切换成 latent」。
// 现在是两层：先一个二选一的门（两张卡），点完才进内容。门整个不要了。
//
// 还有一件必须一起做的 —— 样式的位置。
//   前面那个压缩块里有一堆同名规则（.profile-title / #memoryPanel …），
//   同权重时后来者赢。我之前把新样式写在样式表前半段，被压得一条都没生效：
//   「标题走衬线」丢过一次，「容器颜色」丢过一次，两次都不是权重不够，是位置不对。
//   所以这次所有新样式一律追加到样式表最末尾，不再跟谁抢先后。
//
// 标题：中文的走衬线轻字重，英文的走斜体衬线 —— 跟主页那句引言一个调子。
// 记忆页的标题统一叫 Memory。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');

const target = process.argv[2] || '/var/www/chatnest/index.html';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('mem-tabs')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('--font-serif-cn')) { console.error('先打 fix-memory-pulse-type.js'); process.exit(1); }

const CSS = `

/* ===== 记忆页改成一层 + 标题跟主页一个调子 ===== */
/* 这一整块特意放在样式表最末尾。前面那个压缩块里有一堆同名规则，同权重时
   后来者赢 —— 之前写在前半段的那几条被压得一条都没生效。放这儿就不用抢。 */

/* 中文标题：衬线、轻字重、拉开一点字距。
   前面加个 body 是为了把权重顶到 (1,1,2) —— 页面里藏着一条
   html[data-chat-bg] #memoryPanel 混在一长串选择器里，权重跟不加 body 时
   正好打平、位置又在后面，所以上一版是被它压住的。是在浏览器里把所有匹配规则
   列出来才看见的，光读源码找不到。 */
html:not([data-chat-bg="dark"]) body .profile-title,
html:not([data-chat-bg="dark"]) body #memoryPanel .profile-title{
  font:500 22px/1.18 var(--font-serif-cn);font-style:normal;letter-spacing:.04em;color:#3b332b}
/* 英文标题：斜体衬线 —— 跟主页那句引言一个调子。必须比上面那条更 specific，
   不然上面的 font: 简写会把 italic 重置掉（这个坑刚踩过一次）。 */
html:not([data-chat-bg="dark"]) body .profile-title.is-en,
html:not([data-chat-bg="dark"]) body #memoryPanel .profile-title.is-en{
  font:italic 500 23px/1.15 var(--font-serif);letter-spacing:.02em;color:#3b332b}
/* 容器那条：加 body 顶过那串选择器 */
html:not([data-chat-bg="dark"]) body #memoryPanel{color:#3b332b}

/* 顶上那条切换：OB / Latent */
.mem-tabs{display:flex;gap:8px;margin:2px 2px 14px}
.mem-tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;
  padding:11px 8px;border:1px solid rgba(74,55,40,.14);border-radius:16px;
  background:rgba(255,255,255,.26);color:#77736c;font-size:15px;line-height:1.25;
  cursor:pointer;-webkit-tap-highlight-color:transparent;
  transition:background .2s,border-color .2s,color .2s}
.mem-tab small{font:italic 400 11.5px/1.2 var(--font-serif);letter-spacing:.02em;opacity:.72}
.mem-tab.active{border-color:rgba(155,90,90,.42);background:rgba(255,255,255,.52);color:#3b332b}
.mem-tab:active{opacity:.75}
html[data-chat-bg="dark"] .mem-tab{border-color:rgba(255,255,255,.14);
  background:rgba(255,255,255,.06);color:rgba(244,243,239,.62)}
html[data-chat-bg="dark"] .mem-tab.active{border-color:rgba(231,185,185,.4);
  background:rgba(255,255,255,.12);color:#F4F3EF}
@media(prefers-color-scheme:dark){
  html[data-chat-bg="dark"] .mem-tab small{opacity:.8}
}
`;

const tabs = (active) => `    <div class="mem-tabs" role="tablist">
      <button class="mem-tab${active === 'ob' ? ' active' : ''}" data-mem-tab="obHome" type="button" role="tab"><span>记忆库</span><small>Ombre Brain</small></button>
      <button class="mem-tab${active === 'lt' ? ' active' : ''}" data-mem-tab="latentHome" type="button" role="tab"><span>全文</span><small>Latent</small></button>
    </div>
`;

const edits = [
  // ---- 样式追加到最末尾 ----
  {
    name: '新样式追加到样式表末尾',
    find: `@media(max-width:760px){
  body{background:var(--claude-sidebar-bg)}
  .topbar{padding-left:max(env(safe-area-inset-left),var(--topbar-side-inset));padding-right:max(env(safe-area-inset-right),var(--topbar-side-inset))}
}`,
    replace: `@media(max-width:760px){
  body{background:var(--claude-sidebar-bg)}
  .topbar{padding-left:max(env(safe-area-inset-left),var(--topbar-side-inset));padding-right:max(env(safe-area-inset-right),var(--topbar-side-inset))}
}` + CSS,
  },

  // ---- 落地页从「门」换成 OB ----
  {
    name: '那个二选一的门不再是落地页',
    find: '<div class="profile-page active" id="memoryPicker">',
    replace: '<div class="profile-page" id="memoryPicker">',
  },
  {
    name: 'OB 变成落地页',
    find: '<div class="profile-page" id="obHome">',
    replace: '<div class="profile-page active" id="obHome">',
  },

  // ---- 两个页的标题都叫 Memory，头下面挂切换条 ----
  {
    name: 'OB 页：标题 Memory + 切换条',
    find: `      <div class="profile-title is-en">Ombre Brain</div>
      <div class="ob-header-actions"><button class="profile-round-button ob-refresh-btn" id="obToolsBtn" aria-label="Tools">🧰</button><button class="profile-round-button ob-refresh-btn" id="obRefreshBtn" aria-label="Refresh">↻</button></div>
    </header>
`,
    replace: `      <div class="profile-title is-en">Memory</div>
      <div class="ob-header-actions"><button class="profile-round-button ob-refresh-btn" id="obToolsBtn" aria-label="Tools">🧰</button><button class="profile-round-button ob-refresh-btn" id="obRefreshBtn" aria-label="Refresh">↻</button></div>
    </header>
` + tabs('ob'),
  },
  {
    name: 'Latent 页：标题 Memory + 切换条，左上角那个返回改成关闭',
    find: `      <button class="profile-back-button" id="latentBack" type="button" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
      <div class="profile-title is-en">Latent</div>
      <button class="profile-round-button" id="latentRefresh" type="button" aria-label="Refresh">↻</button>
    </header>
`,
    replace: `      <button class="profile-round-button" id="latentBack" type="button" aria-label="Close">×</button>
      <div class="profile-title is-en">Memory</div>
      <button class="profile-round-button" id="latentRefresh" type="button" aria-label="Refresh">↻</button>
    </header>
` + tabs('lt'),
  },

  // ---- 打开就是 OB ----
  {
    name: '打开记忆页直接进 OB',
    find: `  showProfilePage('memoryPicker');
  refreshMemoryGates();`,
    replace: `  // 直接落在 OB —— 那个二选一的门不走了（DOM 还留着，没人再进）
  showProfilePage('obHome');
  loadOBData();`,
  },

  // ---- 返回键改成关掉整个面板；切换条接上 ----
  {
    name: '返回改成关闭 + 切换条接上',
    find: `  $('latentBack').addEventListener('click',function(){showProfilePage('memoryPicker');refreshMemoryGates()});`,
    replace: `  // 以前这个是「退回那个门」。门没了，就让它直接关掉整个记忆页。
  $('latentBack').addEventListener('click',closeMemoryPanel);
  // 顶上那条切换。两个页各有一条，各自的 active 是写死在 HTML 里的，不用同步。
  document.querySelectorAll('[data-mem-tab]').forEach(function(btn){
    btn.addEventListener('click',function(){
      var id=btn.getAttribute('data-mem-tab');
      if(id==='latentHome'){openLatentPage()}
      else{showProfilePage('obHome');loadOBData()}
    });
  });`,
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  const hits = out.split(e.find).length - 1;
  if (hits !== 1) { missed.push(e.name + '（找到 ' + hits + ' 处，要正好 1 处）'); continue }
  out = out.split(e.find).join(e.replace);
}
if (missed.length) {
  console.error('\n  × 这几处锚点不对：\n      ' + missed.join('\n      '));
  console.error('  原文件一个字都没动。');
  process.exit(1);
}

const styleEnd = out.indexOf('</style>', out.indexOf('.usg-note b{font-weight:600'));
const checks = [
  ['文件完整', /<\/html>/i.test(out)],
  ['新样式在样式表里，没跑进 SVG', out.indexOf('.mem-tabs{display:flex') < styleEnd
    && out.indexOf('.mem-tabs{display:flex') > out.indexOf('.usg-note b{font-weight:600')],
  ['新样式排在那个压缩块后面（不然又会被压掉）',
    out.indexOf('html:not([data-chat-bg="dark"]) body #memoryPanel{color:#3b332b}')
    > out.lastIndexOf('#memoryPanel{position:fixed')],
  ['英文标题那条排在中文那条后面（保住斜体）',
    out.indexOf('.profile-title.is-en{\n  font:italic') > out.indexOf('.profile-title{\n  font:500')],
  ['权重顶过了那串藏着的选择器', /html:not\(\[data-chat-bg="dark"\]\) body #memoryPanel\{color:#3b332b\}/.test(out)],
  ['落地页是 OB', /<div class="profile-page active" id="obHome">/.test(out)
    && !/<div class="profile-page active" id="memoryPicker">/.test(out)],
  ['两个页都叫 Memory', (out.match(/<div class="profile-title is-en">Memory<\/div>/g) || []).length === 2],
  ['两条切换条各一份', (out.match(/data-mem-tab="obHome"/g) || []).length === 2
    && (out.match(/data-mem-tab="latentHome"/g) || []).length === 2],
  ['每页只有一个 active 的 tab', (out.match(/class="mem-tab active"/g) || []).length === 2],
  ['打开就是 OB', out.includes("showProfilePage('obHome');\n  loadOBData();")],
  ['返回键改成关闭', out.includes("$('latentBack').addEventListener('click',closeMemoryPanel);")],
  ['没弄丢别的', ['obToolsBtn', 'obSearchInput', 'latentRefresh', 'obRefreshBtn', 'usgSheetBody', 'ctxMeterFill', 'ks-sheet', 'openLatentPage', 'loadOBData']
    .every(k => (src.includes(k) ? out.includes(k) : true))],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
for (const e of edits) console.log('  √ ' + e.name);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
