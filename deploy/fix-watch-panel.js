#!/usr/bin/env node
// Pulse 的「我的」那一栏接上真实数据。
//   node fix-watch-panel.js [/var/www/chatnest/index.html]
//
// 那一栏原来是个占位，写着"手表还没接"。现在接上 /api/watch/latest：
// 连上了就显示各项指标和新鲜度，没连上就把怎么连写在那儿 ——
// 步骤放页面里，她随时能翻，不用回来问我。
//
// 要先打后端的 add-watch.js。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');

const target = process.argv[2] || '/var/www/chatnest/index.html';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('watchMetrics')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('ptabMine')) { console.error('要先打 fix-pulse-ui.js'); process.exit(1); }

const CSS = `
/* ===== 我的：手表 ===== */
.wm-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.wm-box{border-radius:14px;background:rgba(255,255,255,.36);padding:13px 14px}
html[data-chat-bg="dark"] .wm-box{background:rgba(255,255,255,.06)}
.wm-k{font-size:11.5px;color:var(--text-faint);letter-spacing:.04em}
.wm-v{font-family:var(--font-serif);font-size:24px;line-height:1.1;color:var(--text-primary);margin-top:6px;
  font-variant-numeric:tabular-nums}
.wm-u{font-size:12px;color:var(--text-secondary);margin-left:3px}
.wm-t{font-size:11px;color:var(--text-faint);margin-top:5px}
.wm-head{display:flex;align-items:center;gap:8px;margin-bottom:11px}
.wm-dot{width:7px;height:7px;border-radius:50%;background:var(--text-faint);flex:none}
.wm-dot.on{background:#7FA88C;box-shadow:0 0 0 3px rgba(127,168,140,.18)}
.wm-dot.old{background:#C9A227}
.wm-when{font-size:12.5px;color:var(--text-secondary)}
.wm-steps{font-size:12.5px;line-height:1.85;color:var(--text-secondary)}
.wm-steps b{color:var(--text-primary);font-weight:600}
.wm-steps code{font-family:var(--font-mono);font-size:11.5px;background:rgba(74,55,40,.07);
  border-radius:5px;padding:1px 5px;word-break:break-all}
html[data-chat-bg="dark"] .wm-steps code{background:rgba(255,255,255,.09)}
.wm-steps ol{padding-left:1.3em;margin:6px 0 0}
.wm-steps li{margin-bottom:7px}
`;

const HTML = `      <div class="pulse-card">
          <div class="pulse-card-head"><span class="pulse-card-title">身体</span><span class="pulse-card-en">from your wrist</span></div>
          <div class="wm-head"><i class="wm-dot" id="watchDot"></i><span class="wm-when" id="watchWhen">读取中…</span></div>
          <div class="wm-grid" id="watchMetrics"></div>
        </div>
        <div class="pulse-card">
          <div class="pulse-card-head"><span class="pulse-card-title">怎么接上</span><span class="pulse-card-en">one shortcut</span></div>
          <div class="wm-steps">
            不写 App，不装 Xcode，不开定位。用 iPhone 自带的「快捷指令」，每小时把「健康」里的数据传一次。
            <ol>
              <li>先让表的数据进「健康」App：Apple Watch 自动就有；华为的表要在「运动健康」里打开写入 iOS 健康的开关。</li>
              <li>在服务器上跑 <code>curl -s http://127.0.0.1:3000/api/watch/setup</code>，拿到 token。</li>
              <li>快捷指令 → 新建 → 加一个「查找健康采样」：<b>心率</b>，排序<b>按开始日期</b>、<b>最新的在前</b>，限制 <b>1</b> 项。
                再加一个「获取数值」指向它（这样拿到的是纯数字）。</li>
              <li>再加「获取 URL 内容」：URL 填 <code id="watchUrl">…/api/watch/upload</code>，
                方法 <b>POST</b>，请求体 <b>JSON</b>。<b>头部那一栏留空，不用填。</b></li>
              <li>请求体里加两个字段（都是「文本」类型）：<br>
                　<code>token</code> = 你的 token<br>
                　<code>heart_rate</code> = 上一步那个数值</li>
              <li>「自动化」→ 个人自动化 → <b>当天时间</b> → 每天/每小时 → 运行这个捷径，
                <b>关掉「运行前询问」</b>。</li>
            </ol>
            <b>想多加几项</b>：照第 3 步再复制几组「查找健康采样 + 获取数值」，
            然后在请求体里各加一行 —— <code>steps</code> 步数、<code>blood_oxygen</code> 血氧、
            <code>sleep</code> 睡眠小时数、<code>active_energy</code> 活动消耗、<code>resting_heart_rate</code> 静息心率、
            <code>hrv</code> 心率变异、<code>respiratory_rate</code> 呼吸、<code>body_temperature</code> 体温、
            <code>stand_hours</code> 站立。<br>
            字段名不用背准：<code>hr</code>、<code>心率</code>、<code>spo2</code>、<code>血氧</code> 这些别名我都认；
            带单位的字符串（"72 次/分"）会自己抠出数字；血氧给 0.98 会当成 98%；睡眠给 7.5 会当成小时。
            超出常识范围的数值直接丢掉。
          </div>
        </div>`;

const JS = `
/* ===== 我的：手表 ===== */
const WATCH_ORDER=['heart_rate','resting_heart_rate','hrv','blood_oxygen','sleep_minutes','steps','active_energy','stand_hours','body_temperature','respiratory_rate'];

function watchValueText(k,m){
  if(k==='sleep_minutes'){
    const h=Math.floor(m.value/60),mi=Math.round(m.value%60);
    return {v:(h||0)+'<span class="wm-u">小时</span>'+(mi?' '+mi+'<span class="wm-u">分</span>':''),plain:true};
  }
  return {v:m.value+'<span class="wm-u">'+_esc(m.unit||'')+'</span>'};
}

async function loadWatch(){
  const host=$('watchMetrics'),dot=$('watchDot'),when=$('watchWhen');
  if(!host)return;
  try{
    const r=await fetch('/api/watch/latest');const d=await r.json();
    if(!d.ok||!d.connected){
      dot.className='wm-dot';when.textContent='还没接上 —— 下面那张卡是步骤';
      host.innerHTML='';return;
    }
    dot.className='wm-dot '+(d.freshness==='just_now'?'on':(d.freshness==='today'?'old':''));
    when.textContent=(d.device||'手表')+' · '+(d.ago||'')+'同步的';
    const ks=WATCH_ORDER.filter(function(k){return d.metrics[k]});
    host.innerHTML=ks.length?ks.map(function(k){
      const m=d.metrics[k],t=watchValueText(k,m);
      return '<div class="wm-box"><div class="wm-k">'+_esc(m.label||k)+'</div>'+
        '<div class="wm-v">'+t.v+'</div>'+
        '<div class="wm-t">'+_esc(m.ago||'')+'</div></div>';
    }).join(''):'<div class="pulse-loading">还没有数据传上来。</div>';
  }catch(e){
    dot.className='wm-dot';when.textContent='读不到：'+(e.message||e);host.innerHTML='';
  }
}
`;

const edits = [
  {
    name: '样式',
    find: '/* ===== Pulse 重做：跟主页一个语言 ===== */',
    replace: CSS + '\n/* ===== Pulse 重做：跟主页一个语言 ===== */',
  },
  {
    name: '把占位换成真数据',
    find: (() => {
      const a = src.indexOf('      <div class="pulse-card">\n          <div class="pulse-mine-hero">');
      const b = src.indexOf('</div>\n      </div>\n\n      <div class="pulse-view" id="ptabMine"');
      // 上面那个 b 不对，直接找「我的」那一栏里两张卡的整段
      const s = src.indexOf('<div class="pulse-view" id="ptabMine" hidden>');
      const e = src.indexOf('</div>\n     </div>\n    </div>', s);
      if (s < 0 || e <= s) return '§找不到§';
      const inner = src.slice(s, e);
      const c1 = inner.indexOf('      <div class="pulse-card">');
      if (c1 < 0) return '§找不到§';
      return inner.slice(c1);
    })(),
    replace: HTML,
  },
  {
    name: '脚本',
    find: '/* ===== Pulse 四栏 ===== */',
    replace: JS + '\n/* ===== Pulse 四栏 ===== */',
  },
  {
    name: '切到这一栏时去读',
    find: "  if(name==='dream')loadPulseDreams();",
    replace: "  if(name==='dream')loadPulseDreams();\n  if(name==='mine')loadWatch();",
  },
  {
    name: '刷新按钮也管这一栏',
    find: "if(_pulseTab==='dream')loadPulseDreams()});",
    replace: "if(_pulseTab==='dream')loadPulseDreams();if(_pulseTab==='mine')loadWatch()});",
  },
  {
    name: '上传地址填成她自己的域名',
    find: "  const m=$('ctxMeter');if(!m)return;",
    replace: "  try{const u=$('watchUrl');if(u)u.textContent=location.origin+'/api/watch/upload'}catch(e){}\n" +
      "  const m=$('ctxMeter');if(!m)return;",
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
  ['指标格子在', out.includes('id="watchMetrics"') && out.includes('id="watchDot"')],
  ['步骤写在页面里', out.includes('快捷指令') && out.includes('/api/watch/setup')],
  ['明说了不开定位', out.includes('不开定位')],
  ['明说了头部不用填', out.includes('头部那一栏留空')],
  ['字段名列全了', ['steps','blood_oxygen','sleep','active_energy','resting_heart_rate','hrv',
    'respiratory_rate','body_temperature','stand_hours'].every(k => out.includes('<code>' + k + '</code>'))],
  ['切栏会去读', out.includes("if(name==='mine')loadWatch();")],
  ['上传地址是她自己的域名', out.includes("location.origin+'/api/watch/upload'")],
  ['占位文案没了', !out.includes('HUAWEI FIT 3。')],
  ['只插了一次', (out.match(/id="watchMetrics"/g) || []).length === 1
    && (out.match(/async function loadWatch/g) || []).length === 1],
  ['没弄丢别的功能', ['pulseTabBar', 'ctxMeterFill', 'memoryPicker', 'dreamWeave', 'latentUnresolvedOut']
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
