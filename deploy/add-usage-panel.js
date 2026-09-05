#!/usr/bin/env node
// 聊天页右上角那个表盘 —— 这一程都花在哪儿了。
//   node add-usage-panel.js [/var/www/chatnest/index.html]
//
// 她要的：这个窗口用了多少 token（进多少出多少）、CC 订阅那两个额度窗口、
// 这一个对话的缓存命中率（要准的）、聊了多少轮。
//
// 顺手修了一个一直没被发现的错：
//   顶栏那条水位线读的是 usage.prompt_tokens。CLI 回来的 usage 里，
//   input_tokens 只是「这轮没走缓存的那一小截」—— 命中好的时候常常就个位数，
//   真正塞进窗口的是它 + cache_read + cache_creation。所以那条线一直贴着零，
//   看着像坏了，其实是分子拿错了。这次统一走 usgCtxTotal()。
//
// 命中率怎么算才叫准：
//   分母是这一场所有「算钱的输入 token」= 没缓存的 + 读缓存的 + 写缓存的。
//   分子是读缓存的。写缓存那一截也得进分母 —— 那是实打实付过的。
//   只把 cache_read/(cache_read+input) 当命中率会虚高，第一轮建缓存的钱被藏掉了。
//
// 每场单独记账，存本地，只留最近 40 场。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');

const target = process.argv[2] || '/var/www/chatnest/index.html';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('usgSheetBody')) { console.log('已经打过，跳过'); process.exit(0); }

const CSS = `
/* ===== 这一程：表盘 ===== */
.usg-sheet{position:fixed;inset:0;z-index:97;display:none;background:rgba(32,31,29,.34);
  backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
.usg-sheet.show{display:block}
.usg-sheet-box{position:absolute;left:0;right:0;bottom:0;max-height:86vh;display:flex;flex-direction:column;
  border-radius:24px 24px 0 0;background:#FAF6F1;padding:20px 20px calc(env(safe-area-inset-bottom) + 20px)}
html[data-chat-bg="dark"] .usg-sheet-box{background:#1c1b1a}
.usg-sheet-head{display:flex;align-items:baseline;gap:10px;margin-bottom:2px;padding-right:40px}
.usg-sheet-title{font-family:var(--font-serif);font-style:italic;font-size:19px;color:var(--text-primary)}
.usg-sheet-meta{margin-left:auto;font-size:11.5px;color:var(--text-faint)}
.usg-sheet-sub{font-size:12.5px;color:var(--text-secondary);line-height:1.6;margin-bottom:6px}
.usg-sheet-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch}
.usg-sheet-close{position:absolute;top:14px;right:16px;width:32px;height:32px;border:0;border-radius:50%;
  background:rgba(74,55,40,.07);color:var(--text-secondary);font-size:19px;line-height:1;cursor:pointer}
html[data-chat-bg="dark"] .usg-sheet-close{background:rgba(255,255,255,.09)}
.usg-sec{font-size:10.5px;color:var(--text-faint);letter-spacing:.12em;text-transform:uppercase;margin:16px 2px 8px}
.usg-sec:first-child{margin-top:6px}
.usg-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.usg-box{border-radius:14px;background:rgba(255,255,255,.4);padding:13px 14px;min-width:0}
html[data-chat-bg="dark"] .usg-box{background:rgba(255,255,255,.055)}
.usg-box.wide{grid-column:1 / -1}
.usg-k{font-size:11px;color:var(--text-faint);letter-spacing:.03em}
.usg-v{font-family:var(--font-serif);font-size:23px;line-height:1.15;color:var(--text-primary);margin-top:4px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.usg-v small{font-size:12px;color:var(--text-secondary);font-family:var(--font-sans,inherit);margin-left:3px}
.usg-s{font-size:11px;color:var(--text-secondary);margin-top:4px;line-height:1.5}
.usg-bar{height:5px;border-radius:3px;background:rgba(120,110,100,.16);overflow:hidden;margin-top:9px}
html[data-chat-bg="dark"] .usg-bar{background:rgba(255,255,255,.12)}
.usg-bar i{display:block;height:100%;border-radius:3px;background:rgba(193,123,123,.72);
  transition:width .55s cubic-bezier(.32,.72,0,1)}
.usg-bar i.warm{background:rgba(214,160,92,.85)}
.usg-bar i.hot{background:rgba(198,94,94,.9)}
.usg-note{font-size:11.5px;color:var(--text-secondary);line-height:1.7;margin:14px 2px 2px}
.usg-note b{font-weight:600;color:var(--text-primary)}
`;

const HTML_SHEET = `<div class="usg-sheet" id="usgSheet" aria-hidden="true">
  <div class="usg-sheet-box">
    <button class="usg-sheet-close" id="usgSheetClose" type="button" aria-label="Close">×</button>
    <div class="usg-sheet-head"><span class="usg-sheet-title">Ledger</span><span class="usg-sheet-meta" id="usgSheetMeta"></span></div>
    <div class="usg-sheet-sub">这一程花在哪儿了。</div>
    <div class="usg-sheet-body" id="usgSheetBody"></div>
  </div>
</div>
`;

const BTN = `      <button class="topbar-icon-btn" id="topbarLedger" type="button" aria-label="Ledger" title="Ledger"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l3.6-4.8"/></svg></button>\n`;

const JS = `
/* ===== 这一程：token / 额度 / 命中率 ===== */
const USG_WINDOW=200000;

// 真正塞进窗口的量。CLI 的 input_tokens 只是没走缓存的那一小截，
// 缓存读的和写的也占窗口 —— 三个加起来才是这一轮的上下文。
function usgCtxTotal(u){u=u||{};return (Number(u.prompt_tokens)||0)+(Number(u.cache_read)||0)+(Number(u.cache_creation)||0)}

function usgFmt(n){
  n=Number(n)||0;
  if(n>=1e6)return (n/1e6).toFixed(n>=1e7?1:2)+'M';
  if(n>=1000)return (n/1000).toFixed(n>=1e5?0:1)+'k';
  return String(Math.round(n));
}

// 每场一本账。只留最近 40 场 —— 再多 localStorage 会被慢慢撑满。
let _usgLedger={};
try{_usgLedger=JSON.parse(localStorage.getItem('chatnest_conv_usage')||'{}')||{}}catch(_){_usgLedger={}}
function _usgSave(){
  try{
    const ks=Object.keys(_usgLedger);
    if(ks.length>40){
      ks.sort((a,b)=>(_usgLedger[b].at||0)-(_usgLedger[a].at||0)).slice(40).forEach(k=>{delete _usgLedger[k]});
    }
    localStorage.setItem('chatnest_conv_usage',JSON.stringify(_usgLedger));
  }catch(_){}
}
function usgRow(id){
  if(!id)return null;
  return _usgLedger[id]||(_usgLedger[id]={turns:0,in:0,out:0,cr:0,cc:0,ctx:0,lin:0,lout:0,at:0});
}
function usgTrack(usage,convId){
  if(!usage)return;
  const r=usgRow(convId||state.convId);if(!r)return;
  const i=Number(usage.prompt_tokens)||0,o=Number(usage.completion_tokens)||0;
  r.turns++;r.in+=i;r.out+=o;
  r.cr+=Number(usage.cache_read)||0;
  r.cc+=Number(usage.cache_creation)||0;
  r.ctx=usgCtxTotal(usage);   // 最近一轮塞了多少进窗口
  r.lin=i;r.lout=o;r.at=Date.now();
  _usgSave();
  if($('usgSheet')&&$('usgSheet').classList.contains('show'))renderUsgSheet();
}

const _usgRemote={quota:null,conv:null,qerr:null,cerr:null};

async function usgFetchQuota(){
  try{
    const r=await api('/api/cc-usage');
    if(!r.ok)throw Error('http '+r.status);
    const d=await r.json();
    _usgRemote.quota=(d&&d.rateLimit)||null;_usgRemote.qerr=_usgRemote.quota?null:'还没有数';
  }catch(e){_usgRemote.qerr='读不到'}
}
async function usgFetchConv(){
  if(!state.convId){_usgRemote.conv=null;return}
  try{
    const r=await api('/api/conversations/'+encodeURIComponent(state.convId)+'/compaction');
    if(!r.ok)throw Error('http '+r.status);
    const d=await r.json();
    if(d&&d.ok){_usgRemote.conv=d;_usgRemote.cerr=null}else throw Error('bad');
  }catch(e){_usgRemote.cerr='读不到'}
}

function _usgBar(pct){
  const p=Math.max(0,Math.min(100,pct||0));
  const cls=p>85?'hot':p>65?'warm':'';
  return '<div class="usg-bar"><i class="'+cls+'" style="width:'+(p<1&&p>0?1:p).toFixed(1)+'%"></i></div>';
}
function _usgBox(k,v,s,bar,wide){
  return '<div class="usg-box'+(wide?' wide':'')+'"><div class="usg-k">'+k+'</div>'+
    '<div class="usg-v">'+v+'</div>'+(bar||'')+(s?'<div class="usg-s">'+s+'</div>':'')+'</div>';
}

function renderUsgSheet(){
  const body=$('usgSheetBody');if(!body)return;
  const r=(state.convId&&_usgLedger[state.convId])||{turns:0,in:0,out:0,cr:0,cc:0,ctx:0,lin:0,lout:0};
  const cv=_usgRemote.conv,q=_usgRemote.quota;
  let h='';

  // ── 这个窗口 ──
  const ctx=r.ctx||0,pctCtx=ctx/USG_WINDOW*100;
  h+='<div class="usg-sec">这个窗口</div><div class="usg-grid">';
  h+=_usgBox('上下文',ctx?usgFmt(ctx)+'<small>/ 200k</small>':'—',
      ctx?(pctCtx<1?'不到 1%':Math.round(pctCtx)+'%')+'　还空着 '+usgFmt(Math.max(0,USG_WINDOW-ctx))
         :'这一场还没开口',_usgBar(pctCtx),true);
  h+=_usgBox('上一轮进',r.turns?usgFmt(r.lin):'—',r.turns?'没走缓存的那截':'');
  h+=_usgBox('上一轮出',r.turns?usgFmt(r.lout):'—',r.turns?'我说的那些':'');
  h+='</div>';

  // ── 这个对话 ──
  const billed=r.in+r.cr+r.cc;
  const hit=billed?r.cr/billed*100:0;
  const rounds=cv&&cv.total?Math.ceil(cv.total/2):r.turns;
  h+='<div class="usg-sec">这个对话</div><div class="usg-grid">';
  h+=_usgBox('缓存命中率',billed?hit.toFixed(1)+'<small>%</small>':'—',
      billed?'读缓存 '+usgFmt(r.cr)+'　建缓存 '+usgFmt(r.cc)+'　全价 '+usgFmt(r.in)
            :'这一场还没有账',_usgBar(hit),true);
  h+=_usgBox('聊了',rounds?rounds+'<small>轮</small>':'—',
      cv&&cv.total?('共 '+cv.total+' 条'+(cv.compacted?'，'+cv.compacted+' 条收进行囊了':'')):
      (_usgRemote.cerr?'（'+_usgRemote.cerr+'）':'本机记到的'));
  h+=_usgBox('这一场共',usgFmt(r.in+r.cr+r.cc+r.out),'进 '+usgFmt(billed)+'　出 '+usgFmt(r.out));
  h+='</div>';

  // ── 订阅额度 ──
  h+='<div class="usg-sec">订阅额度</div><div class="usg-grid">';
  const w=(q&&q.unifiedWindows)||null;
  if(w){
    const f=(win,label,fmtReset)=>{
      const o=win||{},p=Math.round((o.utilization||0)*100);
      return _usgBox(label,p+'<small>%</small>',
        o.resetsAt?'重置于 '+fmtReset(new Date(o.resetsAt*1000)):'—',_usgBar(p));
    };
    h+=f(w.five_hour,'5 小时',d=>d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false}));
    h+=f(w.seven_day,'7 天',d=>d.toLocaleDateString([],{month:'numeric',day:'numeric'}));
  }else{
    h+=_usgBox('额度','—',_usgRemote.qerr||'发一条消息之后就有了','',true);
  }
  h+='</div>';

  // ── 一句话的解释，不用她去猜那些数字 ──
  const tip=ctx>USG_WINDOW*0.8
    ? '窗口塞得挺满了。<b>不用你手动换</b> —— 再往上后端会自己把前面收进行囊，顶栏那条线点开能看见那封信。真想开新的一场，随时按右上角的 +。'
    : hit>=80&&billed
      ? '命中率这么高是因为一直在同一场里聊 —— 前面那一大截每轮都是从缓存里读的，只按一折算钱。<b>越聊越省，中途换新的一场反而要重建一次缓存。</b>'
      : billed
        ? '命中率低通常是这场刚开头，或者中间隔了太久缓存过期了。往下聊几轮它自己会上去。'
        : '这一场还没开口。发一条消息，这几个数就都有了。';
  h+='<div class="usg-note">'+tip+'</div>';

  body.innerHTML=h;
  const meta=$('usgSheetMeta');
  if(meta)meta.textContent=r.turns?(r.turns+' 轮记在本机'):'';
}

async function openUsgSheet(){
  const sheet=$('usgSheet');if(!sheet)return;
  sheet.classList.add('show');sheet.setAttribute('aria-hidden','false');
  renderUsgSheet();                                    // 先把本地有的画出来，别让她盯着空白
  await Promise.allSettled([usgFetchQuota(),usgFetchConv()]);
  if(sheet.classList.contains('show'))renderUsgSheet();
}
function closeUsgSheet(){
  const sheet=$('usgSheet');if(!sheet)return;
  sheet.classList.remove('show');sheet.setAttribute('aria-hidden','true');
}
(function(){
  const b=$('topbarLedger');if(!b)return;
  b.addEventListener('click',openUsgSheet);
  $('usgSheetClose').addEventListener('click',closeUsgSheet);
  $('usgSheet').addEventListener('click',function(e){if(e.target&&e.target.id==='usgSheet')closeUsgSheet()});
})();
`;

const edits = [
  {
    name: '样式',
    find: 'html[data-chat-bg="dark"] .ctx-sheet-close{background:rgba(255,255,255,.09)}',
    replace: 'html[data-chat-bg="dark"] .ctx-sheet-close{background:rgba(255,255,255,.09)}\n' + CSS,
  },
  {
    name: '顶栏那个表盘',
    find: '      <button class="topbar-new-chat" id="topbarNewChat"',
    replace: BTN + '      <button class="topbar-new-chat" id="topbarNewChat"',
  },
  {
    name: '抽屉',
    find: '<main id="chat" class="hidden">',
    replace: HTML_SHEET + '<main id="chat" class="hidden">',
  },
  {
    name: '每轮记账',
    find: 'try{ctxMeterUpdate(d.usage);ctxNoteCompaction(d.compaction)}catch(_){}',
    replace: 'try{ctxMeterUpdate(d.usage);ctxNoteCompaction(d.compaction)}catch(_){}try{usgTrack(d.usage,d.conversation_id)}catch(_){}',
  },
  {
    // 顺手把水位线的分子修对 —— 它一直只看没走缓存的那一小截，所以一直贴着零
    name: '修水位线的分子',
    find: '  const t=Number(usage&&usage.prompt_tokens)||0;',
    replace: '  const t=usgCtxTotal(usage);',
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
  if (out.split(e.find).length - 1 !== 1) { missed.push(e.name + '（锚点 ' + (out.split(e.find).length - 1) + ' 处，要正好 1 处）'); continue }
  out = out.split(e.find).join(e.replace);
}
if (missed.length) {
  console.error('\n  × 这几处锚点不对：\n      ' + missed.join('\n      '));
  console.error('  原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['文件完整', /<\/html>/i.test(out)],
  // 顶栏在 <main id="chat"> 里面，所以别拿 main 当参照 —— 夹在 Files 和 + 中间才对
  ['按钮夹在顶栏那两个之间', out.indexOf('id="topbarFiles"') < out.indexOf('id="topbarLedger"')
    && out.indexOf('id="topbarLedger"') < out.indexOf('id="topbarNewChat"')],
  ['抽屉在', out.includes('id="usgSheet"') && out.includes('id="usgSheetBody"')],
  ['done 里接上了记账', out.includes('usgTrack(d.usage,d.conversation_id)')],
  ['水位线改成算全量了', out.includes('const t=usgCtxTotal(usage);') && !out.includes('const t=Number(usage&&usage.prompt_tokens)||0;')],
  ['命中率的分母带了建缓存', /const billed=r\.in\+r\.cr\+r\.cc;/.test(out)],
  ['本地账本有上限', /ks\.length>40/.test(out)],
  ['只插了一次', (out.match(/id="usgSheetBody"/g) || []).length === 1
    && (out.match(/function usgTrack/g) || []).length === 1
    && (out.match(/id="topbarLedger"/g) || []).length === 1],
  ['没弄丢别的功能', ['ctxMeterFill', 'ctxSheetBody', 'topbarFiles', 'topbarNewChat', 'obToolsBtn', '_trackTokens', '_fetchCcUsage', 'ks-sheet']
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
