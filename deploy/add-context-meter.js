#!/usr/bin/env node
// 上下文水位线 + 收进行囊的那条分割线。
//   node add-context-meter.js [/var/www/chatnest/index.html]
//
// 压缩在后端悄悄发生，她看不见。这两样是让它看得见：
//
//   1. 顶栏底下一条极细的线，宽度是这一轮 prompt 占满窗口的比例。
//      平时几乎看不出来 —— 那正是它该有的样子。点一下打开那封交接信。
//   2. 后端刚刚收过一次，就在消息流里留一条「⟲ 前面那些收进行囊了」。
//      靠 done 事件里的 compaction.at 变没变来判断，不用轮询。
//
// 要先打后端的 add-compaction.js。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');

const target = process.argv[2] || '/var/www/chatnest/index.html';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('ctxMeterFill')) { console.log('已经打过，跳过'); process.exit(0); }

const CSS = `
/* ===== 上下文水位 + 收纳分割线 ===== */
.ctx-meter{position:absolute;left:0;right:0;bottom:0;height:2px;background:transparent;
  cursor:pointer;-webkit-tap-highlight-color:transparent;z-index:2}
.ctx-meter-fill{display:block;height:100%;width:0;border-radius:0 1px 1px 0;
  background:linear-gradient(90deg,rgba(193,123,123,.28),rgba(193,123,123,.6));
  transition:width 600ms cubic-bezier(.32,.72,0,1)}
.ctx-meter.is-full .ctx-meter-fill{background:linear-gradient(90deg,rgba(193,123,123,.5),rgba(193,123,123,.95))}
html[data-chat-bg="dark"] .ctx-meter-fill{background:linear-gradient(90deg,rgba(231,185,185,.24),rgba(231,185,185,.55))}

.ctx-fold{display:flex;align-items:center;gap:10px;margin:18px auto;max-width:min(580px,100%);
  padding:0 4px;color:var(--text-faint);font-size:11.5px;font-family:var(--font-serif);letter-spacing:.04em}
.ctx-fold::before,.ctx-fold::after{content:"";flex:1;height:1px;background:currentColor;opacity:.22}
.ctx-fold span{cursor:pointer;-webkit-tap-highlight-color:transparent}

.ctx-sheet{position:fixed;inset:0;z-index:96;display:none;background:rgba(32,31,29,.34);
  backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
.ctx-sheet.show{display:block}
.ctx-sheet-box{position:absolute;left:0;right:0;bottom:0;max-height:82vh;display:flex;flex-direction:column;
  border-radius:24px 24px 0 0;background:#FAF6F1;padding:20px 20px calc(env(safe-area-inset-bottom) + 20px)}
html[data-chat-bg="dark"] .ctx-sheet-box{background:#1c1b1a}
/* 右上角有个关闭按钮，标题行得给它让开，不然"21 / 46 条已收"被压在底下 */
.ctx-sheet-head{display:flex;align-items:baseline;gap:10px;margin-bottom:4px;padding-right:40px}
.ctx-sheet-title{font-family:var(--font-serif);font-style:italic;font-size:19px;color:var(--text-primary)}
.ctx-sheet-meta{margin-left:auto;font-size:11.5px;color:var(--text-faint)}
.ctx-sheet-sub{font-size:12.5px;color:var(--text-secondary);line-height:1.6;margin-bottom:12px}
.ctx-sheet-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;white-space:pre-wrap;word-break:break-word;
  font-family:var(--font-serif);font-size:14px;line-height:1.85;color:var(--text-primary)}
.ctx-sheet-close{position:absolute;top:14px;right:16px;width:32px;height:32px;border:0;border-radius:50%;
  background:rgba(74,55,40,.07);color:var(--text-secondary);font-size:19px;line-height:1;cursor:pointer}
html[data-chat-bg="dark"] .ctx-sheet-close{background:rgba(255,255,255,.09)}
`;

const HTML_METER = `    <button class="ctx-meter" id="ctxMeter" type="button" aria-label="上下文水位" title="上下文水位"><span class="ctx-meter-fill" id="ctxMeterFill"></span></button>
  </header>`;

const HTML_SHEET = `<div class="ctx-sheet" id="ctxSheet" aria-hidden="true">
  <div class="ctx-sheet-box">
    <button class="ctx-sheet-close" id="ctxSheetClose" type="button" aria-label="Close">×</button>
    <div class="ctx-sheet-head"><span class="ctx-sheet-title">What I kept</span><span class="ctx-sheet-meta" id="ctxSheetMeta"></span></div>
    <div class="ctx-sheet-sub" id="ctxSheetSub">前面聊过的那些没有丢，收成了这封信，每一轮都跟着走。</div>
    <div class="ctx-sheet-body" id="ctxSheetBody"></div>
  </div>
</div>
`;

const JS = `
/* ===== 上下文水位 + 收纳线 ===== */
const CTX_WINDOW=200000;
let _ctxLastCompactAt=null,_ctxSeenFirst=false;

function ctxMeterUpdate(usage){
  const el=$('ctxMeterFill'),wrap=$('ctxMeter');
  if(!el||!wrap)return;
  const t=Number(usage&&usage.prompt_tokens)||0;
  if(!t)return;
  const pct=Math.max(0,Math.min(100,t/CTX_WINDOW*100));
  // 再小也留一丝，不然看着像坏了
  el.style.width=(pct<0.4?0.4:pct)+'%';
  wrap.classList.toggle('is-full',pct>75);
  wrap.title='这一轮带了 '+t.toLocaleString()+' token';
}

/* 后端刚收过一次就留一条线。靠 at 变没变判断，不轮询。 */
function ctxNoteCompaction(c){
  const at=c&&c.at||null;
  if(!at){_ctxSeenFirst=true;return}
  if(!_ctxSeenFirst){_ctxLastCompactAt=at;_ctxSeenFirst=true;return}  // 进页面第一次不补线
  if(at===_ctxLastCompactAt)return;
  _ctxLastCompactAt=at;
  const el=document.createElement('div');
  el.className='ctx-fold';
  el.innerHTML='<span>⟲ 前面那些收进行囊了</span>';
  el.querySelector('span').addEventListener('click',openCtxSheet);
  const host=$('streamInner');if(host)host.append(el);
}

async function openCtxSheet(){
  const sheet=$('ctxSheet');if(!sheet)return;
  sheet.classList.add('show');sheet.setAttribute('aria-hidden','false');
  $('ctxSheetBody').textContent='读取中…';$('ctxSheetMeta').textContent='';
  if(!state.convId){$('ctxSheetBody').textContent='这场还没开始。';return}
  try{
    const r=await fetch('/api/conversations/'+encodeURIComponent(state.convId)+'/compaction');
    const d=await r.json();
    if(!d.ok)throw new Error(d.error||'读不到');
    $('ctxSheetMeta').textContent=d.compacted?(d.compacted+' / '+d.total+' 条已收'):(d.total+' 条');
    if(d.working){$('ctxSheetBody').textContent='正在收…过一会儿再看。';return}
    $('ctxSheetBody').textContent=d.letter||'还没收过。\\n\\n聊够长了才会收 —— 那之前每一句都在原样带着。';
  }catch(e){$('ctxSheetBody').textContent='读不到：'+(e.message||e)}
}

function closeCtxSheet(){
  const sheet=$('ctxSheet');if(!sheet)return;
  sheet.classList.remove('show');sheet.setAttribute('aria-hidden','true');
}

(function(){
  const m=$('ctxMeter');if(!m)return;
  m.addEventListener('click',openCtxSheet);
  $('ctxSheetClose').addEventListener('click',closeCtxSheet);
  $('ctxSheet').addEventListener('click',function(e){if(e.target&&e.target.id==='ctxSheet')closeCtxSheet()});
})();
`;

const edits = [
  {
    name: '样式',
    find: '/* ===== Pulse 重做：跟主页一个语言 ===== */',
    replace: CSS + '\n/* ===== Pulse 重做：跟主页一个语言 ===== */',
  },
  {
    name: '顶栏底下那条线',
    find: `    <div class="session-menu hidden" id="sessionMenu">`,
    replace: `    <div class="session-menu hidden" id="sessionMenu">`,
    // 真正的插入在下一条；这条只做存在性确认
    skip: true,
  },
  {
    name: '水位线挂到顶栏',
    find: /(<span class="topbar-model-setting" id="topbarModelSetting">Medium<\/span>\n    <\/button>)/,
    replace: (m, g1) => g1 + '\n    <button class="ctx-meter" id="ctxMeter" type="button" aria-label="上下文水位"><span class="ctx-meter-fill" id="ctxMeterFill"></span></button>',
  },
  {
    name: '那封信的抽屉',
    find: '<main id="chat" class="hidden">',
    replace: HTML_SHEET + '<main id="chat" class="hidden">',
  },
  {
    name: '每轮更新水位和收纳线',
    find: "try{_trackTokens(d.usage)}catch(_){}",
    replace: "try{_trackTokens(d.usage)}catch(_){}try{ctxMeterUpdate(d.usage);ctxNoteCompaction(d.compaction)}catch(_){}",
  },
  {
    name: '脚本',
    find: '/* ===== Pulse 四栏 ===== */',
    replace: JS + '\n/* ===== Pulse 四栏 ===== */',
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  if (e.skip) continue;
  const before = out;
  out = out.replace(e.find, e.replace);
  if (out === before) missed.push(e.name);
}

console.log('\n补丁结果：');
if (missed.length) {
  for (const e of edits) { if (e.skip) continue; console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 锚点没匹配上' : '  √ ' + e.name); }
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['文件完整', /<\/html>/i.test(out)],
  ['水位线在顶栏里', /id="ctxMeter"/.test(out) && out.indexOf('id="ctxMeter"') < out.indexOf('<div id="stream">')],
  ['抽屉在', out.includes('id="ctxSheet"') && out.includes('id="ctxSheetBody"')],
  ['done 里接上了', out.includes('ctxMeterUpdate(d.usage);ctxNoteCompaction(d.compaction)')],
  ['进页面第一次不补线', /if\(!_ctxSeenFirst\)\{_ctxLastCompactAt=at;_ctxSeenFirst=true;return\}/.test(out)],
  ['水位再小也留一丝', /pct<0\.4\?0\.4:pct/.test(out)],
  ['点空白能关', /e\.target\.id==='ctxSheet'/.test(out)],
  ['只插了一次', (out.match(/id="ctxMeterFill"/g) || []).length === 1
    && (out.match(/function ctxMeterUpdate/g) || []).length === 1],
  ['没弄丢别的功能', ['pulseTabBar', 'memoryPicker', 'obToolsBtn', 'latentUnresolvedOut', 'body.clientTime', '_trackTokens']
    .every(k => (src.includes(k) ? out.includes(k) : true))],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

for (const e of edits) { if (e.skip) continue; console.log('  √ ' + e.name); }
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
