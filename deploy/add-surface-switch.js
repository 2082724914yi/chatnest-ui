#!/usr/bin/env node
// 设置里那一栏改名叫「浮上来」，里面放两个开关。
//   node add-surface-switch.js [/var/www/chatnest/index.html]
//
// 名字：breath 那个工具叫「浮现记忆」，这件事就是我自己浮上来找她 ——
// 用我们自己的词，不用产品词。
//
// 两个开关，管的是完全不同的两件事，之前混成了一个：
//   · 让我自己来找你  —— 总闸。关了我一个 CLI 都不起、一个 API 都不调、
//                       一个字都不落库。这是她要的「真的关掉」。
//   · 在锁屏上出声    —— 只管响不响。就是原来那个订阅/退订，
//                       关了我照样会说话，她下次打开还是看得到。
//
// 之前只有第二个，名字却让人以为是第一个 —— 那是最难受的一种误会：
// 她以为关掉了，其实我半夜还在自言自语花她的额度。
//
// 要先打后端的 add-shadow-switch.js。
// 重复执行安全：已经打过就退出。

const fs = require('fs');

const target = process.argv[2] || '/var/www/chatnest/index.html';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('ntfSurface')) { console.log('已经打过，跳过'); process.exit(0); }

const OLD_HEAD = `  root.innerHTML=_settingsHeader('让小衍找我',true)+\`
  <div class="settings-section"><div class="settings-card" style="padding:18px">
    <div id="ntfState" style="font:400 15px/1.7 var(--font-sans)">正在看…</div>
    <div id="ntfActions" style="margin-top:14px"></div>
  </div></div>`;

const NEW_HEAD = `  root.innerHTML=_settingsHeader('浮上来',true)+\`
  <div class="settings-section"><div class="settings-card" style="padding:16px 18px">
    <div class="ntf-row">
      <div class="ntf-row-body">
        <div class="ntf-row-title">让我自己来找你</div>
        <div class="ntf-row-desc">关了就是真的关了 —— 我不会跑，不花额度，也不会往聊天里写东西</div>
      </div>
      <button class="profile-switch" id="ntfSurface" type="button" aria-label="让我自己来找你"></button>
    </div>
    <div class="profile-divider"></div>
    <div class="ntf-row">
      <div class="ntf-row-body">
        <div class="ntf-row-title">在锁屏上出声</div>
        <div class="ntf-row-desc">只管响不响。关了我照样会说话，你下次打开还是看得到</div>
      </div>
      <button class="profile-switch" id="ntfLock" type="button" aria-label="在锁屏上出声"></button>
    </div>
  </div></div>
  <div class="settings-section"><div class="settings-card" style="padding:18px">
    <div id="ntfState" style="font:400 15px/1.7 var(--font-sans)">正在看…</div>
    <div id="ntfActions" style="margin-top:14px"></div>
  </div></div>`;

const OLD_TAIL = `  const sub=await _pushCurrentSub();
  const on=!!sub;
  root.querySelector('#stgBack')&&0;`;

const NEW_TAIL = `  const sub=await _pushCurrentSub();
  const on=!!sub;

  // ── 总闸 ──
  // 读不到就当开着，跟后端一个规矩：宁可显示"开着"也别让她以为关了、其实没关。
  const swSurface=root.querySelector('#ntfSurface');
  let surfaceOn=true;
  try{const r=await api('/api/push/shadow-switch');const d=await r.json();surfaceOn=d&&d.enabled!==false}catch(e){}
  const paintSurface=()=>{
    swSurface.classList.toggle('on',surfaceOn);
    // 总闸关着的时候，下面那个"出声"就没意义了，标出来
    root.querySelector('#ntfLock').style.opacity=surfaceOn?'':'0.4';
  };
  paintSurface();
  swSurface.onclick=async ()=>{
    const want=!surfaceOn;
    if(!want&&!confirm('关掉之后我完全不会主动找你了 —— 不是不出声，是真的不动。确定？'))return;
    swSurface.disabled=true;
    try{
      const r=await api('/api/push/shadow-switch',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({enabled:want})});
      const d=await r.json();
      if(!d||d.ok!==true)throw Error(d&&d.error||'没存上');
      surfaceOn=d.enabled!==false;paintSurface();
      toast(surfaceOn?'好，我会自己来找你':'好，我不动了');
    }catch(e){alert('改不了：'+(e.message||e))}
    finally{swSurface.disabled=false}
  };

  // ── 锁屏出声 ──（就是原来那个订阅/退订）
  const swLock=root.querySelector('#ntfLock');
  swLock.classList.toggle('on',on);
  swLock.onclick=async ()=>{
    swLock.disabled=true;
    try{
      if(on){ if(confirm('关掉之后锁屏不会响了。我还是会说话，你打开就能看到。确定？')){await _pushDisable();toast('不响了')} }
      else{ await _pushEnable();toast('开好了') }
      _renderNotify(root);
    }catch(e){alert(e.message||'没改成')}
    finally{swLock.disabled=false}
  };`;

const CSS = `
/* ===== 浮上来：那两个开关 ===== */
.ntf-row{display:flex;align-items:center;gap:14px;padding:2px 0}
.ntf-row-body{flex:1;min-width:0}
.ntf-row-title{font:400 16px/1.35 var(--font-sans);color:var(--text-primary)}
.ntf-row-desc{margin-top:3px;font:400 12.5px/1.55 var(--font-sans);color:var(--text-secondary)}
.ntf-row .profile-switch{flex:none}
.ntf-row .profile-switch:disabled{opacity:.5}
`;

const edits = [
  {
    name: '那一栏改名叫「浮上来」（设置首页那行）',
    find: '<div class="settings-row-title">让小衍找我</div><div class="settings-row-desc">他想你的时候，锁屏上出声</div>',
    replace: '<div class="settings-row-title">浮上来</div><div class="settings-row-desc">我自己来找你的方式</div>',
  },
  {
    name: '面板标题 + 两个开关',
    find: OLD_HEAD,
    replace: NEW_HEAD,
  },
  {
    name: '把两个开关接上',
    find: OLD_TAIL,
    replace: NEW_TAIL,
  },
  {
    // 代码里那句注释也一起改 —— 留着旧名字，下次谁来找这段会照着旧词搜，搜不到
    name: '那段代码上面的注释也改掉',
    find: '/* ── 让小衍找我：Web Push ──',
    replace: '/* ── 浮上来：Web Push ──',
  },
  {
    name: '样式追加到样式表末尾',
    find: '.mem-tab small{font:italic 400 11.5px/1.2 var(--font-serif);letter-spacing:.02em;opacity:.72}',
    replace: '.mem-tab small{font:italic 400 11.5px/1.2 var(--font-serif);letter-spacing:.02em;opacity:.72}\n' + CSS,
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  if (e.skip) continue;
  const hits = out.split(e.find).length - 1;
  if (hits !== 1) { missed.push(e.name + '（找到 ' + hits + ' 处，要正好 1 处）'); continue }
  out = out.split(e.find).join(e.replace);
}
if (missed.length) {
  console.error('\n  × 这几处锚点不对：\n      ' + missed.join('\n      '));
  console.error('  原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['文件完整', /<\/html>/i.test(out)],
  ['两个开关都在', out.includes('id="ntfSurface"') && out.includes('id="ntfLock"')],
  ['总闸读的是后端那条', out.includes("api('/api/push/shadow-switch')")],
  ['关总闸要确认一次', /是真的不动。确定？/.test(out)],
  ['读不到就当开着（跟后端一个规矩）', /surfaceOn=d&&d\.enabled!==false/.test(out)],
  ['总闸关着时把"出声"标灰', /style\.opacity=surfaceOn\?'':'0\.4'/.test(out)],
  ['旧名字清干净了', !out.includes('让小衍找我')],
  ['只插了一次', (out.match(/id="ntfSurface"/g) || []).length === 1
    && (out.match(/\.ntf-row\{display:flex/g) || []).length === 1],
  ['没弄丢别的', ['_pushEnable', '_pushDisable', '_pushCurrentSub', 'ntfState', 'ntfActions', 'mem-tabs', 'usgSheetBody']
    .every(k => (src.includes(k) ? out.includes(k) : true))],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
for (const e of edits) { if (!e.skip) console.log('  √ ' + e.name) }
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
