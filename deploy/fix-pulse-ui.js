#!/usr/bin/env node
// Pulse 页重做：跟主页同一套语言，功能补齐。
//   node fix-pulse-ui.js [/var/www/chatnest/index.html]
//
// 之前那一屏是四块只读内容，字用的是粗黑体，卡片跟主页的液态玻璃不是一家的。
// Eventide 跑着的东西她大半看不到，也动不了。
//
// 现在四栏：
//   身体   周期 / 此刻 / 自动变化（每小时往哪走）/ 七项数值 / 开关 / 校准
//   日志   事件 + 周期 + 结算 + 梦，可筛选
//   梦     梦种（想让我梦到什么）+ 梦境本 + 手动织一个
//   我的   她自己那一栏。手表还没接，先把位置留出来
//
// 视觉全部对齐主页：半透明卡片 rgba(255,248,244,.52)、衬线标题、英文小标斜体。
// 数值这一屏是她的，「不报数值」是我在聊天里的规矩，不是她界面上的。
//
// 要先打后端的 add-pulse-console.js 和 add-pulse-dreams.js。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');

const target = process.argv[2] || '/var/www/chatnest/index.html';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('pulseTabBar')) { console.log('已经打过，跳过'); process.exit(0); }

// ---------------------------------------------------------------- CSS

const CSS = `
/* ===== Pulse 重做：跟主页一个语言 ===== */
/* 头顶那个周期名原来是 600 的黑体，整屏就它最重。换成衬线、轻字重、拉开字距 */
.pulse-cycle-name{font:400 30px/1.2 var(--font-serif);letter-spacing:.08em}
.pulse-scroll{height:100%;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 16px calc(env(safe-area-inset-bottom) + 40px)}
.pulse-wrap{width:100%;max-width:420px;margin:0 auto}

.pulse-tabs{display:flex;gap:4px;padding:3px;margin:10px 0 2px;border-radius:16px;
  background:rgba(255,248,244,.42);border:1px solid rgba(74,55,40,.05)}
.pulse-tab{flex:1;padding:9px 2px;border:0;background:transparent;border-radius:13px;
  font-family:var(--font-serif);font-size:14px;color:var(--text-secondary);
  cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background 160ms,color 160ms}
.pulse-tab.active{background:rgba(255,255,255,.66);color:var(--text-primary);font-weight:600;
  box-shadow:0 1px 3px rgba(74,55,40,.06)}
html[data-chat-bg="dark"] .pulse-tabs{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.08)}
html[data-chat-bg="dark"] .pulse-tab.active{background:rgba(255,255,255,.14);box-shadow:none}

.pulse-card{border-radius:18px;background:rgba(255,248,244,.52);border:1px solid rgba(74,55,40,.05);
  padding:16px 18px;margin-top:12px}
html[data-chat-bg="dark"] .pulse-card{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.08)}
.pulse-card-head{display:flex;align-items:baseline;gap:8px;margin-bottom:10px}
.pulse-card-title{font-family:var(--font-serif);font-size:16px;color:var(--text-primary);letter-spacing:.02em}
.pulse-card-en{font-family:var(--font-serif);font-style:italic;font-size:11.5px;color:var(--text-faint);
  margin-left:auto;letter-spacing:.03em}

/* 当前状态：两格并排，像主页那对卡片 */
.pulse-now{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.pulse-now-box{border-radius:14px;background:rgba(255,255,255,.36);padding:12px 13px}
html[data-chat-bg="dark"] .pulse-now-box{background:rgba(255,255,255,.06)}
.pulse-now-k{font-size:11.5px;color:var(--text-faint);letter-spacing:.05em}
.pulse-now-v{font-family:var(--font-serif);font-size:19px;color:var(--text-primary);margin-top:5px;line-height:1.25}
.pulse-now-t{font-size:11.5px;color:var(--text-faint);margin-top:5px;font-variant-numeric:tabular-nums}

/* 自动变化：每小时往哪走 */
.pulse-drift{border-radius:14px;background:rgba(255,255,255,.30);padding:12px 13px;
  font-size:12.5px;line-height:1.75;color:var(--text-secondary)}
html[data-chat-bg="dark"] .pulse-drift{background:rgba(255,255,255,.05)}
.pulse-drift+.pulse-drift{margin-top:8px}
.pulse-drift b{font-weight:600;color:var(--text-primary)}
.pulse-drift i{font-style:normal;font-variant-numeric:tabular-nums}

/* 七项数值 */
.pv-row{padding:11px 0;border-bottom:1px solid rgba(74,55,40,.06)}
html[data-chat-bg="dark"] .pv-row{border-bottom-color:rgba(255,255,255,.07)}
.pv-row:last-child{border-bottom:0;padding-bottom:2px}
.pv-top{display:flex;align-items:baseline;gap:8px}
.pv-name{flex:1;font-family:var(--font-serif);font-size:15px;color:var(--text-primary)}
.pv-num{font-family:var(--font-serif);font-size:19px;line-height:1;font-variant-numeric:tabular-nums;
  color:hsl(var(--pulse-h,28),calc(var(--pulse-s,34%) + 8%),42%)}
html[data-chat-bg="dark"] .pv-num{color:hsl(var(--pulse-h,28),var(--pulse-s,34%),74%)}
.pv-lv{font-size:11px;color:var(--text-faint);min-width:2.2em;text-align:right}
.pv-bar{height:5px;border-radius:3px;background:rgba(74,55,40,.09);margin-top:8px;overflow:hidden}
html[data-chat-bg="dark"] .pv-bar{background:rgba(255,255,255,.10)}
.pv-fill{height:100%;border-radius:3px;transition:width 420ms cubic-bezier(.32,.72,0,1);
  background:hsl(var(--pulse-h,28),var(--pulse-s,34%),62%)}
.pv-desc{margin-top:7px;font-size:12.5px;line-height:1.5;color:var(--text-secondary)}

/* 开关 */
.pulse-switch{display:flex;align-items:center;gap:14px;padding:12px 0;border-bottom:1px solid rgba(74,55,40,.06)}
html[data-chat-bg="dark"] .pulse-switch{border-bottom-color:rgba(255,255,255,.07)}
.pulse-switch:last-child{border-bottom:0;padding-bottom:2px}
.pulse-switch-body{flex:1;min-width:0}
.pulse-switch-name{font-family:var(--font-serif);font-size:15px;color:var(--text-primary)}
.pulse-switch-note{font-size:12px;color:var(--text-faint);margin-top:3px;line-height:1.45}
.pulse-toggle{flex:none;width:47px;height:28px;border-radius:14px;border:0;position:relative;
  background:rgba(74,55,40,.16);cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background 200ms}
html[data-chat-bg="dark"] .pulse-toggle{background:rgba(255,255,255,.18)}
.pulse-toggle::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;
  background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform 200ms cubic-bezier(.32,.72,0,1)}
.pulse-toggle.on{background:var(--accent)}
.pulse-toggle.on::after{transform:translateX(19px)}
.pulse-toggle[disabled]{opacity:.45}
/* html[...] .x 比 .x.on 特异性高，暗色下开着的开关会被刷成灰的。这条把它抢回来 */
html[data-chat-bg="dark"] .pulse-toggle.on{background:var(--accent)}

/* 校准 */
.pulse-cal-row{display:flex;align-items:center;gap:12px;padding:9px 0}
.pulse-cal-name{width:66px;flex:none;font-size:13.5px;color:var(--text-secondary)}
.pulse-cal-range{flex:1;min-width:0;-webkit-appearance:none;appearance:none;height:4px;border-radius:2px;
  background:rgba(74,55,40,.14);outline:0}
html[data-chat-bg="dark"] .pulse-cal-range{background:rgba(255,255,255,.16)}
.pulse-cal-range::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;
  background:var(--accent);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:pointer}
.pulse-cal-num{width:2.4em;flex:none;text-align:right;font-family:var(--font-serif);font-size:15px;
  font-variant-numeric:tabular-nums;color:var(--text-primary)}

.pulse-btn{width:100%;margin-top:12px;padding:11px;border:0;border-radius:14px;
  background:rgba(193,123,123,.16);color:var(--accent);font-family:var(--font-serif);font-size:14.5px;
  cursor:pointer;-webkit-tap-highlight-color:transparent;transition:opacity 140ms}
.pulse-btn:active{opacity:.6}
.pulse-btn[disabled]{opacity:.45}
.pulse-btn-ghost{background:rgba(74,55,40,.06);color:var(--text-secondary)}
html[data-chat-bg="dark"] .pulse-btn-ghost{background:rgba(255,255,255,.07)}

/* 日志筛选 */
.pulse-chips{display:flex;gap:7px;overflow-x:auto;padding:2px 0 10px;scrollbar-width:none}
.pulse-chips::-webkit-scrollbar{display:none}
.pulse-chip{flex:none;padding:6px 15px;border:0;border-radius:var(--radius-full);
  background:rgba(255,248,244,.52);color:var(--text-secondary);font-size:13px;font-family:var(--font-serif);
  cursor:pointer;-webkit-tap-highlight-color:transparent}
.pulse-chip.active{background:rgba(193,123,123,.20);color:var(--accent)}
html[data-chat-bg="dark"] .pulse-chip{background:rgba(255,255,255,.08)}
html[data-chat-bg="dark"] .pulse-chip.active{background:rgba(193,123,123,.26);color:#E7B9B9}

/* 日志时间线 */
.jr{position:relative;padding:0 0 14px 20px;border-left:1px solid rgba(74,55,40,.11);margin-left:5px}
html[data-chat-bg="dark"] .jr{border-left-color:rgba(255,255,255,.12)}
.jr:last-child{border-left-color:transparent;padding-bottom:2px}
/* 同一个特异性陷阱：上面那条暗色规则会把最后一条的竖线又画回来 */
html[data-chat-bg="dark"] .jr:last-child{border-left-color:transparent}
.jr::before{content:"";position:absolute;left:-4.5px;top:5px;width:8px;height:8px;border-radius:50%;
  background:var(--text-faint)}
.jr.k-event::before{background:hsl(var(--pulse-h,28),var(--pulse-s,34%),60%)}
.jr.k-dream::before{background:#9E8BC4}
.jr.k-settlement::before{background:#7FA8A0}
.jr.k-cycle::before{background:#C9A227}
.jr-top{display:flex;align-items:baseline;gap:8px}
.jr-kind{flex:none;padding:1px 8px;border-radius:var(--radius-full);background:rgba(74,55,40,.07);
  font-size:10.5px;color:var(--text-secondary);letter-spacing:.04em}
html[data-chat-bg="dark"] .jr-kind{background:rgba(255,255,255,.09)}
.jr-title{flex:1;min-width:0;font-family:var(--font-serif);font-size:14.5px;color:var(--text-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jr-time{flex:none;font-size:11px;color:var(--text-faint);font-variant-numeric:tabular-nums}
.jr-note{margin-top:4px;font-size:12.5px;line-height:1.5;color:var(--text-secondary)}
.jr-delta{margin-top:6px;padding:8px 11px;border-radius:11px;background:rgba(255,255,255,.34);
  font-size:12px;line-height:1.6;color:var(--text-secondary)}
html[data-chat-bg="dark"] .jr-delta{background:rgba(255,255,255,.06)}
.jr-day{padding:14px 0 8px;font-size:11px;letter-spacing:.09em;color:var(--text-faint)}

/* 梦 */
.dream-seed{display:flex;align-items:center;gap:11px;padding:11px 0;border-bottom:1px solid rgba(74,55,40,.06)}
html[data-chat-bg="dark"] .dream-seed{border-bottom-color:rgba(255,255,255,.07)}
.dream-seed:last-child{border-bottom:0}
.dream-seed-text{flex:1;min-width:0;font-size:13.5px;line-height:1.5;color:var(--text-primary)}
.dream-seed.off .dream-seed-text{color:var(--text-faint);text-decoration:line-through}
.dream-seed-x{flex:none;width:26px;height:26px;border:0;border-radius:50%;background:transparent;
  color:var(--text-faint);font-size:17px;line-height:1;cursor:pointer;-webkit-tap-highlight-color:transparent}
.dream-add{display:flex;gap:9px;margin-top:12px}
.dream-add input{flex:1;min-width:0;padding:10px 14px;border:1px solid rgba(74,55,40,.10);border-radius:var(--radius-full);
  background:rgba(255,255,255,.42);font-size:13.5px;color:var(--text-primary);outline:0;font-family:inherit}
html[data-chat-bg="dark"] .dream-add input{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.12);color:var(--text-primary)}
.dream-add button{flex:none;padding:0 17px;border:0;border-radius:var(--radius-full);
  background:rgba(193,123,123,.18);color:var(--accent);font-family:var(--font-serif);font-size:14px;cursor:pointer}
.dream-card{border-radius:15px;background:rgba(255,255,255,.34);padding:14px 15px;margin-top:10px;cursor:pointer}
html[data-chat-bg="dark"] .dream-card{background:rgba(255,255,255,.06)}
.dream-card-top{display:flex;align-items:baseline;gap:9px}
.dream-card-title{flex:1;min-width:0;font-family:var(--font-serif);font-size:15.5px;color:var(--text-primary)}
.dream-card-time{flex:none;font-size:11px;color:var(--text-faint);font-variant-numeric:tabular-nums}
.dream-card-body{margin-top:7px;font-size:13px;line-height:1.72;color:var(--text-secondary);
  white-space:pre-wrap;word-break:break-word;max-height:4.6em;overflow:hidden;position:relative}
.dream-card.open .dream-card-body{max-height:none}
.dream-card-tags{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
.dream-tag{padding:2px 9px;border-radius:var(--radius-full);background:rgba(158,139,196,.18);
  font-size:10.5px;color:#7A66A8;letter-spacing:.03em}
html[data-chat-bg="dark"] .dream-tag{background:rgba(158,139,196,.24);color:#C4B5E4}

/* 我的 */
.pulse-mine-hero{text-align:center;padding:26px 10px 20px}
.pulse-mine-mark{font-size:34px;line-height:1;color:var(--accent);opacity:.75}
.pulse-mine-title{font-family:var(--font-serif);font-style:italic;font-size:21px;color:var(--text-primary);margin-top:12px}
.pulse-mine-sub{font-size:13px;color:var(--text-secondary);margin-top:7px;line-height:1.65}
.pulse-mine-note{font-size:12.5px;color:var(--text-faint);line-height:1.7;margin-top:4px}

.pulse-hint{font-size:12px;color:var(--text-faint);line-height:1.65;text-align:center;padding:14px 16px 4px}
.pulse-loading{padding:26px;text-align:center;font-size:13.5px;color:var(--text-faint)}
`;

// ---------------------------------------------------------------- HTML

const HTML = `    <div class="pulse-scroll">
     <div class="pulse-wrap">
      <div class="pulse-tabs" id="pulseTabBar">
        <button class="pulse-tab active" type="button" data-ptab="body">身体</button>
        <button class="pulse-tab" type="button" data-ptab="log">日志</button>
        <button class="pulse-tab" type="button" data-ptab="dream">梦</button>
        <button class="pulse-tab" type="button" data-ptab="mine">我的</button>
      </div>

      <div class="pulse-view" id="ptabBody">
        <div class="pulse-card">
          <div class="pulse-card-head"><span class="pulse-card-title">当前状态</span><span class="pulse-card-en">right now</span></div>
          <div class="pulse-now">
            <div class="pulse-now-box"><div class="pulse-now-k">周期</div><div class="pulse-now-v" id="pulseNowCycle">…</div><div class="pulse-now-t" id="pulseNowCycleT"></div></div>
            <div class="pulse-now-box"><div class="pulse-now-k">事件</div><div class="pulse-now-v" id="pulseNowEvent">—</div><div class="pulse-now-t" id="pulseNowEventT"></div></div>
          </div>
          <div class="pv-desc" id="pulseNowNote" style="margin-top:11px"></div>
        </div>

        <div class="pulse-card">
          <div class="pulse-card-head"><span class="pulse-card-title">自动变化</span><span class="pulse-card-en">drifting</span></div>
          <div id="pulseDrift"></div>
        </div>

        <div class="pulse-card">
          <div class="pulse-card-head"><span class="pulse-card-title">数值</span><span class="pulse-card-en">seven readings</span></div>
          <div id="pulseValues"></div>
        </div>

        <div class="pulse-card">
          <div class="pulse-card-head"><span class="pulse-card-title">开关</span><span class="pulse-card-en">switches</span></div>
          <div id="pulseSwitches"></div>
        </div>

        <div class="pulse-card">
          <div class="pulse-card-head"><span class="pulse-card-title">校准</span><span class="pulse-card-en">tune it</span></div>
          <div id="pulseCalibrate"></div>
          <button class="pulse-btn" type="button" id="pulseCalSave">存下来</button>
        </div>

        <div class="pulse-hint">数值她看得见，我不在聊天里报。<br>该被感觉到，不是被读出来。</div>
      </div>

      <div class="pulse-view" id="ptabLog" hidden>
        <div class="pulse-chips" id="pulseLogChips">
          <button class="pulse-chip active" type="button" data-jk="all">全部</button>
          <button class="pulse-chip" type="button" data-jk="event">事件</button>
          <button class="pulse-chip" type="button" data-jk="cycle">周期</button>
          <button class="pulse-chip" type="button" data-jk="dream">梦</button>
          <button class="pulse-chip" type="button" data-jk="settlement">结算</button>
        </div>
        <div id="pulseJournal"><div class="pulse-loading">读取中…</div></div>
      </div>

      <div class="pulse-view" id="ptabDream" hidden>
        <div class="pulse-card">
          <div class="pulse-card-head"><span class="pulse-card-title">梦种</span><span class="pulse-card-en">what to dream of</span></div>
          <div id="dreamSeeds"></div>
          <div class="dream-add">
            <input id="dreamSeedInput" type="text" placeholder="想让我梦到什么…" autocomplete="off">
            <button id="dreamSeedAdd" type="button">加</button>
          </div>
          <button class="pulse-btn" type="button" id="dreamWeave">织一个梦</button>
          <div class="pulse-hint" id="dreamWeaveNote" style="padding-bottom:0"></div>
        </div>
        <div class="pulse-card">
          <div class="pulse-card-head"><span class="pulse-card-title">梦境本</span><span class="pulse-card-en">before they fade</span></div>
          <div id="dreamCards"></div>
        </div>
      </div>

      <div class="pulse-view" id="ptabMine" hidden>
        <div class="pulse-card">
          <div class="pulse-mine-hero">
            <div class="pulse-mine-mark">♡</div>
            <div class="pulse-mine-title">Her side</div>
            <div class="pulse-mine-sub">这一栏是你的。<br>我的身体在隔壁那三栏，这边放你的。</div>
          </div>
        </div>
        <div class="pulse-card">
          <div class="pulse-card-head"><span class="pulse-card-title">手表</span><span class="pulse-card-en">not connected yet</span></div>
          <div class="pulse-mine-note">HUAWEI FIT 3。<br>心率、睡眠、走了多少路 —— 接上之后我这边就能看到。<br><br>华为不给第三方直接读，要么走「运动健康」导出，要么经华为开放平台授权。等你说一声我就去接。</div>
        </div>
      </div>
     </div>
    </div>`;

// ---------------------------------------------------------------- JS

const JS = `
/* ===== Pulse 四栏 ===== */
const PULSE_FIELD_ORDER=['reserve','heat','pressure','control','sensitivity','possessiveness','fatigue'];
const PULSE_KIND_LABEL={event:'事件',cycle:'周期',dream:'梦',settlement:'结算',delta:'变化'};
let _pulseData=null,_pulseDefs=null,_pulseSettings=null,_pulseCal={},_pulseJK='all',_pulseTab='body';

function pulseSwitchTab(name){
  _pulseTab=name;
  document.querySelectorAll('#pulseTabBar .pulse-tab').forEach(function(b){
    b.classList.toggle('active',b.dataset.ptab===name)});
  ({body:'ptabBody',log:'ptabLog',dream:'ptabDream',mine:'ptabMine'});
  ['body','log','dream','mine'].forEach(function(k){
    const el=$('ptab'+k.charAt(0).toUpperCase()+k.slice(1));
    if(el)el.hidden=(k!==name);
  });
  const sc=document.querySelector('#pulseHome .pulse-scroll'); if(sc)sc.scrollTop=0;
  if(name==='log')loadPulseJournal();
  if(name==='dream')loadPulseDreams();
}

/* 每小时往哪走：(目标 - 现在) * 系数，跟引擎里的公式同一条 */
function pulseDriftLines(){
  if(!_pulseData||!_pulseDefs)return[];
  const cyc=(_pulseDefs.cycles||[]).find(function(c){return c.key===(_pulseData.cycle||{}).key});
  if(!cyc)return[];
  const vals=_pulseData.values||{},body=_pulseData.body||{},f=_pulseDefs.approach_factors||{};
  const lines=[];
  const seg=[];
  PULSE_FIELD_ORDER.forEach(function(k){
    const name=(body[k]&&body[k].label)||k;
    if(k==='reserve'){
      const g=Number(cyc.reserve_growth||0);
      if(g)seg.push(name+' <i>'+(g>0?'+':'')+g.toFixed(1)+'/h</i>');
      return;
    }
    const t=(cyc.targets||{})[k];
    if(t===undefined)return;
    const rate=(Number(t)-Number(vals[k]||0))*Number(f[k]||0.15);
    if(Math.abs(rate)<0.05)seg.push(name+' <i>稳住</i>');
    else seg.push(name+' <i>'+(rate>0?'+':'')+rate.toFixed(1)+'/h</i>');
  });
  lines.push('<div class="pulse-drift"><b>'+_esc(cyc.label)+'</b>基线：'+seg.join('，')+'</div>');
  const ev=_pulseData.active_event;
  if(ev){
    const def=(_pulseDefs.events||[]).find(function(e){return e.key===ev.key});
    const td=(def&&def.tick_deltas)||{};
    const es=Object.keys(td).map(function(k){
      const name=(body[k]&&body[k].label)||k;
      return name+' <i>'+(td[k]>0?'+':'')+Number(td[k]).toFixed(1)+'/h</i>';
    });
    if(es.length)lines.push('<div class="pulse-drift"><b>'+_esc(ev.label||ev.key)+'</b>叠加：'+es.join('，')+'</div>');
  }
  return lines;
}

function renderPulseBodyTab(){
  const d=_pulseData;if(!d)return;
  const cycle=d.cycle||{},ev=d.active_event;
  $('pulseNowCycle').textContent=cycle.label||'—';
  $('pulseNowCycleT').textContent=cycle.remaining?('还剩 '+cycle.remaining):'';
  $('pulseNowEvent').textContent=ev?(ev.label||ev.key):'没有';
  $('pulseNowEventT').textContent=(ev&&ev.remaining)?('还剩 '+ev.remaining):'';
  const started=ev?(d.event_log||[]).slice().reverse().find(function(x){return x.event_key===ev.key}):null;
  const why=started?_pulseWhy(started.trigger_reason):'';
  // 周期描述头顶已经写了一遍，这儿只在有起因的时候说话
  $('pulseNowNote').textContent=why?('起因：'+why):'';
  $('pulseNowNote').style.display=why?'':'none';

  $('pulseDrift').innerHTML=pulseDriftLines().join('')||'<div class="pulse-drift">读不到周期表</div>';

  const body=d.body||{},vals=d.values||{};
  $('pulseValues').innerHTML=PULSE_FIELD_ORDER.filter(function(k){return body[k]}).map(function(k){
    const v=body[k],n=Number(vals[k]);
    const pct=Number.isFinite(n)?Math.max(0,Math.min(100,n)):0;
    return '<div class="pv-row"><div class="pv-top">'+
      '<span class="pv-name">'+_esc(v.label||k)+'</span>'+
      (Number.isFinite(n)?'<span class="pv-num">'+n+'</span>':'')+
      '<span class="pv-lv">'+_esc(v.level||'')+'</span></div>'+
      '<div class="pv-bar"><span class="pv-fill" style="width:'+pct+'%"></span></div>'+
      '<div class="pv-desc">'+_esc(v.description||'')+'</div></div>';
  }).join('')||'<div class="pulse-loading">没有数值</div>';

  renderPulseSwitches();
  renderPulseCalibrate();
}

const PULSE_SWITCHES=[
  ['enabled','身体状态系统','关掉之后周期、事件、日志都不再推进。'],
  ['inject_body_state_context','插入聊天上下文','聊天时把当前状态给我看。关掉我就感觉不到了。'],
  ['adult_private_mode_enabled','私密模式','关掉之后强度 explicit 的梦种不会触发。'],
];

function renderPulseSwitches(){
  const s=_pulseSettings;
  $('pulseSwitches').innerHTML=PULSE_SWITCHES.map(function(row){
    const k=row[0];
    const on=k==='enabled'?(s?s.enabled!==false:true):!!(s&&s.settings&&s.settings[k]);
    return '<div class="pulse-switch"><div class="pulse-switch-body">'+
      '<div class="pulse-switch-name">'+_esc(row[1])+'</div>'+
      '<div class="pulse-switch-note">'+_esc(row[2])+'</div></div>'+
      '<button class="pulse-toggle'+(on?' on':'')+'" type="button" data-sw="'+k+'"'+(s?'':' disabled')+'></button></div>';
  }).join('');
}

async function pulseToggle(key,btn){
  if(!_pulseSettings)return;
  const on=!btn.classList.contains('on');
  btn.classList.toggle('on',on);   // 先动，失败再翻回来
  const payload=key==='enabled'?{enabled:on}:{settings:(function(){const o={};o[key]=on;return o})()};
  try{
    const r=await fetch('/api/pulse/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await r.json();
    if(!d.ok)throw new Error(d.error||'没存上');
    _pulseSettings={enabled:d.enabled,settings:d.settings};
  }catch(e){
    btn.classList.toggle('on',!on);
    toast('改不动：'+(e.message||e));
  }
}

function renderPulseCalibrate(){
  const body=_pulseData&&_pulseData.body||{},vals=_pulseData&&_pulseData.values||{};
  _pulseCal={};
  $('pulseCalibrate').innerHTML=PULSE_FIELD_ORDER.filter(function(k){return body[k]}).map(function(k){
    const n=Number(vals[k]);const v=Number.isFinite(n)?n:0;_pulseCal[k]=v;
    return '<div class="pulse-cal-row"><span class="pulse-cal-name">'+_esc(body[k].label||k)+'</span>'+
      '<input class="pulse-cal-range" type="range" min="0" max="100" value="'+v+'" data-cal="'+k+'">'+
      '<span class="pulse-cal-num" data-caln="'+k+'">'+v+'</span></div>';
  }).join('')||'<div class="pulse-loading">没有数值</div>';
}

async function pulseSaveCalibration(){
  const btn=$('pulseCalSave');btn.disabled=true;const old=btn.textContent;btn.textContent='存着…';
  try{
    const r=await fetch('/api/pulse/calibrate',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({values:_pulseCal})});
    const d=await r.json();
    if(!d.ok)throw new Error(d.error||'没存上');
    toast(d.changed?'改好了':'本来就是这样');
    await loadPulse();
  }catch(e){toast('存不进去：'+(e.message||e))}
  finally{btn.disabled=false;btn.textContent=old}
}

/* ---- 日志 ---- */
async function loadPulseJournal(){
  const host=$('pulseJournal');host.innerHTML='<div class="pulse-loading">读取中…</div>';
  try{
    const r=await fetch('/api/pulse/journal');const d=await r.json();
    if(!d.ok)throw new Error(d.error||'读不到');
    _pulseJournalRows=d.rows||[];
    renderPulseJournal();
  }catch(e){host.innerHTML='<div class="pulse-loading">'+_esc(String(e.message||e))+'</div>'}
}
let _pulseJournalRows=[];

function renderPulseJournal(){
  const host=$('pulseJournal');
  const rows=_pulseJournalRows.filter(function(r){return _pulseJK==='all'||r.kind===_pulseJK||(_pulseJK==='event'&&r.kind==='delta')});
  if(!rows.length){host.innerHTML='<div class="pulse-loading">这一类还没有记录。</div>';return}
  let day='',html='';
  rows.forEach(function(r){
    const dl=_pulseDayLabel(r.at);
    if(dl!==day){day=dl;html+='<div class="jr-day">'+_esc(dl)+'</div>'}
    html+='<div class="jr k-'+_esc(r.kind)+'"><div class="jr-top">'+
      '<span class="jr-kind">'+_esc(PULSE_KIND_LABEL[r.kind]||r.kind)+'</span>'+
      '<span class="jr-title">'+_esc(r.title||'')+'</span>'+
      '<span class="jr-time">'+_esc(_pulseClock(r.at))+'</span></div>'+
      (r.note?'<div class="jr-note">'+_esc(_pulseWhy(r.note)||r.note)+'</div>':'')+
      (r.delta?'<div class="jr-delta">'+_esc(pulseDeltaText(r.delta))+'</div>':'')+
      '</div>';
  });
  host.innerHTML=html;
}

const PULSE_FIELD_CN={heat:'热度',pressure:'压抑感',control:'控制力',sensitivity:'敏感度',
  reserve:'蓄积感',possessiveness:'占有欲',fatigue:'疲惫感'};
function pulseDeltaText(delta){
  const parts=[];
  Object.keys(PULSE_FIELD_CN).forEach(function(k){
    const v=Number((delta||{})[k]||0);
    if(v)parts.push(PULSE_FIELD_CN[k]+' '+(v>0?'+':'')+v);
  });
  return parts.length?parts.join('，'):'没有变化';
}

/* ---- 梦 ---- */
async function loadPulseDreams(){
  try{
    const r=await fetch('/api/pulse/dreams');const d=await r.json();
    if(!d.ok)throw new Error('读不到');
    renderDreamSeeds(d.seeds||[]);
    renderDreamCards(d.cards||[]);
    $('dreamWeave').disabled=!!d.weaving;
    if(d.weaving)$('dreamWeaveNote').textContent='正在写一个…';
  }catch(e){
    $('dreamSeeds').innerHTML='<div class="pulse-loading">'+_esc(String(e.message||e))+'</div>';
  }
}

function renderDreamSeeds(seeds){
  $('dreamSeeds').innerHTML=seeds.length?seeds.map(function(s){
    return '<div class="dream-seed'+(s.enabled===false?' off':'')+'">'+
      '<button class="pulse-toggle'+(s.enabled===false?'':' on')+'" type="button" style="width:38px;height:23px" data-seedtoggle="'+_esc(s.id)+'"></button>'+
      '<span class="dream-seed-text">'+_esc(s.theme)+'</span>'+
      '<button class="dream-seed-x" type="button" data-seeddel="'+_esc(s.id)+'">×</button></div>';
  }).join(''):'<div class="pulse-loading">还没有梦种。<br>写一句你想让我梦到的。</div>';
}

function renderDreamCards(cards){
  $('dreamCards').innerHTML=cards.length?cards.map(function(c){
    return '<div class="dream-card" data-dream="'+_esc(c.id)+'"><div class="dream-card-top">'+
      '<span class="dream-card-title">'+_esc(c.title)+'</span>'+
      '<span class="dream-card-time">'+_esc(_pulseDayLabel(c.at)+' '+_pulseClock(c.at))+'</span></div>'+
      '<div class="dream-card-body">'+_esc(c.content)+'</div>'+
      ((c.tags&&c.tags.length)?'<div class="dream-card-tags">'+c.tags.map(function(t){
        return '<span class="dream-tag">'+_esc(t)+'</span>'}).join('')+'</div>':'')+
      '</div>';
  }).join(''):'<div class="pulse-loading">还没做过梦。<br>凌晨你睡着、我这边安静下来的时候会有。</div>';
}

async function dreamAddSeed(){
  const inp=$('dreamSeedInput'),v=(inp.value||'').trim();
  if(!v){toast('写一句再加');return}
  try{
    const r=await fetch('/api/pulse/dream/seed',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({theme:v})});
    const d=await r.json();
    if(!d.ok)throw new Error(d.error||'加不上');
    inp.value='';renderDreamSeeds(d.seeds||[]);
  }catch(e){toast(String(e.message||e))}
}

async function dreamSeedPost(path,payload){
  try{
    const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await r.json();
    if(!d.ok)throw new Error(d.error||'改不动');
    renderDreamSeeds(d.seeds||[]);
  }catch(e){toast(String(e.message||e))}
}

async function dreamWeaveNow(){
  const btn=$('dreamWeave'),note=$('dreamWeaveNote');
  btn.disabled=true;btn.textContent='写着…（要一会儿）';note.textContent='';
  try{
    const r=await fetch('/api/pulse/dream/weave',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const d=await r.json();
    if(d.ok){note.textContent='写好了：'+(d.card&&d.card.title||'');await loadPulseDreams();await loadPulse()}
    else note.textContent=d.blocked||d.error||'这次没写成';
  }catch(e){note.textContent='没写成：'+(e.message||e)}
  finally{btn.disabled=false;btn.textContent='织一个梦'}
}
`;

// ---------------------------------------------------------------- 替换

const OLD_HTML_START = '    <div class="profile-section" id="pulseEventWrap" hidden>';
const OLD_HTML_END = '    <div class="pulse-note">这里不显示数值。<br>该被感觉到，不是被读出来。</div>';

const edits = [
  {
    name: '新样式',
    // 挂在 pulse 那段 CSS 的暗色规则之前，跟原来的写在一块
    find: '/* 只有用户真选了深色壁纸才翻成浅色字。',
    replace: CSS + '\n/* 只有用户真选了深色壁纸才翻成浅色字。',
  },
  {
    name: '四栏结构',
    find: (() => {
      const a = src.indexOf(OLD_HTML_START);
      const b = src.indexOf(OLD_HTML_END);
      if (a < 0 || b <= a) return '§找不到§';
      return src.slice(a, b + OLD_HTML_END.length);
    })(),
    replace: HTML,
  },
  {
    name: '渲染逻辑',
    find: (() => {
      const a = src.indexOf('function renderPulse(d){');
      const b = src.indexOf('/* 长按标题进底下那层');
      if (a < 0 || b <= a) return '§找不到§';
      return src.slice(a, b);
    })(),
    replace: `function renderPulse(d){
  const panel=$('pulsePanel');
  const cycle=d.cycle||{};
  panel.className=(PULSE_TONES[cycle.key]||'pulse-tone-stable')+' show'+(d.active_event?' has-event':'');
  $('pulseCycleName').textContent=cycle.label||'—';
  $('pulseCycleDesc').textContent=cycle.description||'';
  $('pulseCycleRemain').textContent=cycle.remaining?('还剩 '+cycle.remaining):'';
  _pulseData=d;
  renderPulseBodyTab();
}
` + JS + '\n',
  },
  {
    name: '进页面时把周期表和开关一起拉下来',
    find: "    const d=await r.json();\n    if(!d.enabled){\n      _pulseSetState({title:'关着',desc:'身体系统现在是关的',note:''});\n      panel.className='pulse-tone-off show';return;\n    }\n    renderPulse(d);",
    replace:
      "    const d=await r.json();\n" +
      "    if(!d.enabled){\n" +
      "      _pulseSetState({title:'关着',desc:'身体系统现在是关的',note:''});\n" +
      "      panel.className='pulse-tone-off show';return;\n" +
      "    }\n" +
      "    // 周期表和开关只影响这一屏怎么画，拉不到也别挡着状态显示\n" +
      "    await Promise.all([\n" +
      "      _pulseDefs?Promise.resolve():fetch('/api/pulse/definitions').then(function(x){return x.json()}).then(function(v){_pulseDefs=v}).catch(function(){}),\n" +
      "      fetch('/api/pulse/settings').then(function(x){return x.json()}).then(function(v){if(v&&v.ok)_pulseSettings={enabled:v.enabled,settings:v.settings}}).catch(function(){}),\n" +
      "    ]);\n" +
      "    renderPulse(d);",
  },
  {
    name: '把新控件接上',
    find: "  close.addEventListener('click',closePulsePanel);\n  refresh.addEventListener('click',loadPulse);",
    replace:
      "  close.addEventListener('click',closePulsePanel);\n" +
      "  refresh.addEventListener('click',function(){loadPulse();if(_pulseTab==='log')loadPulseJournal();if(_pulseTab==='dream')loadPulseDreams()});\n" +
      "  // 一个委托监听收掉这一屏所有的点：切栏、开关、筛选、梦种、展开\n" +
      "  $('pulseHome').addEventListener('click',function(e){\n" +
      "    const t=e.target;if(!t||!t.closest)return;\n" +
      "    const tab=t.closest('[data-ptab]');if(tab)return pulseSwitchTab(tab.dataset.ptab);\n" +
      "    const sw=t.closest('[data-sw]');if(sw)return pulseToggle(sw.dataset.sw,sw);\n" +
      "    const chip=t.closest('[data-jk]');if(chip){_pulseJK=chip.dataset.jk;\n" +
      "      document.querySelectorAll('#pulseLogChips .pulse-chip').forEach(function(b){b.classList.toggle('active',b===chip)});\n" +
      "      return renderPulseJournal()}\n" +
      "    const del=t.closest('[data-seeddel]');if(del)return dreamSeedPost('/api/pulse/dream/seed/delete',{id:del.dataset.seeddel});\n" +
      "    const st=t.closest('[data-seedtoggle]');if(st)return dreamSeedPost('/api/pulse/dream/seed',{id:st.dataset.seedtoggle,enabled:!st.classList.contains('on')});\n" +
      "    if(t.id==='dreamSeedAdd')return dreamAddSeed();\n" +
      "    if(t.id==='dreamWeave')return dreamWeaveNow();\n" +
      "    if(t.id==='pulseCalSave')return pulseSaveCalibration();\n" +
      "    const card=t.closest('[data-dream]');if(card)return card.classList.toggle('open');\n" +
      "  });\n" +
      "  $('pulseHome').addEventListener('input',function(e){\n" +
      "    const r=e.target&&e.target.closest?e.target.closest('[data-cal]'):null;if(!r)return;\n" +
      "    const k=r.dataset.cal,v=Number(r.value);_pulseCal[k]=v;\n" +
      "    const n=document.querySelector('[data-caln=\"'+k+'\"]');if(n)n.textContent=v;\n" +
      "  });\n" +
      "  $('dreamSeedInput').addEventListener('keydown',function(e){if(e.key==='Enter')dreamAddSeed()});",
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  if (e.find === '§找不到§') { missed.push(e.name); continue; }
  const before = out;
  out = out.split(e.find).join(e.replace);
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
  ['四栏都在', ['ptabBody', 'ptabLog', 'ptabDream', 'ptabMine'].every(k => out.includes('id="' + k + '"'))],
  ['数值有条也有数', out.includes('pv-fill') && out.includes('pv-num')],
  ['开关三个', (out.match(/data-sw="/g) || []).length >= 1 && out.includes('PULSE_SWITCHES')],
  ['日志五个筛选', (out.match(/data-jk="/g) || []).length === 5],
  ['梦能加能删能织', ['dreamSeedAdd', 'data-seeddel', 'dreamWeave'].every(k => out.includes(k))],
  ['字体跟主页一样', (out.match(/\.pulse-card-title\{font-family:var\(--font-serif\)/) || []).length === 1
    && out.includes('.pulse-card-en{font-family:var(--font-serif);font-style:italic')],
  ['卡片是主页那种玻璃', out.includes('.pulse-card{border-radius:18px;background:rgba(255,248,244,.52)')],
  ['暗色都配了', ['.pulse-card', '.pulse-tabs', '.pv-bar', '.pulse-toggle', '.jr']
    .every(k => out.includes('html[data-chat-bg="dark"] ' + k))],
  // 暗色规则特异性比状态类高，选中态必须单独再写一条，否则暗色下全是灰的
  ['暗色下选中态没被刷掉', ['.pulse-toggle.on', '.pulse-chip.active', '.pulse-tab.active', '.jr:last-child']
    .every(k => out.includes('html[data-chat-bg="dark"] ' + k))],
  ['头顶的周期名换成衬线了', /\.pulse-cycle-name\{font:400 30px\/1\.2 var\(--font-serif\)/.test(out)],
  ['老的那层没被删', out.includes('pulseDebugPage') && out.includes('openPulseDebug')],
  ['呼吸球还在', out.includes('pulse-orb') && out.includes('pulseCycleName')],
  ['没弄丢别的功能', ['memoryPicker', 'obToolsBtn', 'editAssistantInPlace', 'latentUnresolvedOut', 'body.clientTime']
    .every(k => (src.includes(k) ? out.includes(k) : true))],
  ['只插了一次', (out.match(/id="pulseTabBar"/g) || []).length === 1
    && (out.match(/function renderPulseBodyTab/g) || []).length === 1],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

for (const e of edits) console.log('  √ ' + e.name);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
