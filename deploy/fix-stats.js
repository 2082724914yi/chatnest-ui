#!/usr/bin/env node
// 统计页重排：删热力图，加缓存命中，每天一行看清消息/token/命中。
//   node fix-stats.js [/var/www/chatnest/index.html]
//
// 她要的：总 token、消息总数 留着；删掉聊天热力图；加"命中缓存"；
// 每天的消息数、每天的输入/输出 token、每天的命中缓存；CC 订阅额度不动。
// done 事件现在带了 cache_read/cache_creation（后端 add-cache-prefix），这里落进统计。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');

const target = process.argv[2] || '/var/www/chatnest/index.html';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('totalCacheRead')) { console.log('已经打过，跳过'); process.exit(0); }

// ---- 1) _trackTokens 落缓存 ----
const OLD_TRACK = `function _trackTokens(usage){
  if(!usage)return;
  const inp=usage.prompt_tokens||0;const out=usage.completion_tokens||0;
  _tokenStats.totalInput+=inp;
  _tokenStats.totalOutput+=out;
  _tokenStats.totalMessages++;
  const today=new Date().toISOString().slice(0,10);
  _tokenStats.dailyMessages[today]=(_tokenStats.dailyMessages[today]||0)+1;
  if(!_tokenStats.dailyTokens)_tokenStats.dailyTokens={};
  if(!_tokenStats.dailyTokens[today])_tokenStats.dailyTokens[today]={input:0,output:0};
  _tokenStats.dailyTokens[today].input+=inp;
  _tokenStats.dailyTokens[today].output+=out;
  _saveTokenStats();
}`;
const NEW_TRACK = `function _trackTokens(usage){
  if(!usage)return;
  const inp=usage.prompt_tokens||0;const out=usage.completion_tokens||0;
  const cr=usage.cache_read||0;const cc=usage.cache_creation||0;
  _tokenStats.totalInput+=inp;
  _tokenStats.totalOutput+=out;
  _tokenStats.totalCacheRead=(_tokenStats.totalCacheRead||0)+cr;
  _tokenStats.totalCacheCreation=(_tokenStats.totalCacheCreation||0)+cc;
  _tokenStats.totalMessages++;
  const today=new Date().toISOString().slice(0,10);
  _tokenStats.dailyMessages[today]=(_tokenStats.dailyMessages[today]||0)+1;
  if(!_tokenStats.dailyTokens)_tokenStats.dailyTokens={};
  if(!_tokenStats.dailyTokens[today])_tokenStats.dailyTokens[today]={input:0,output:0};
  _tokenStats.dailyTokens[today].input+=inp;
  _tokenStats.dailyTokens[today].output+=out;
  _tokenStats.dailyTokens[today].cacheRead=(_tokenStats.dailyTokens[today].cacheRead||0)+cr;
  _saveTokenStats();
}`;

// ---- 2) _renderStats 重排 ----
const OLD_STATS_START = 'function _renderStats(root){';
const OLD_STATS_END = '\nfunction _renderDailyTokens(container){';
const a = src.indexOf(OLD_STATS_START);
const b = src.indexOf(OLD_STATS_END);
if (a < 0 || b <= a) { console.error('找不到 _renderStats'); process.exit(1); }
const OLD_STATS = src.slice(a, b);

const NEW_STATS = `function _renderStats(root){
  const totalMsgs=_tokenStats.totalMessages||0;
  const totalIn=_tokenStats.totalInput||0;
  const totalOut=_tokenStats.totalOutput||0;
  const totalTokens=totalIn+totalOut;
  const cacheRead=_tokenStats.totalCacheRead||0;
  const cacheCreation=_tokenStats.totalCacheCreation||0;
  // 命中率 = 缓存读 /（缓存读 + 新读 + 写缓存）= 输入里有多少是从缓存来的
  const inTotal=cacheRead+cacheCreation+totalIn;
  const hitPct=inTotal?Math.round(cacheRead/inTotal*100):0;
  const daily=_tokenStats.dailyMessages||{};
  const activeDays=Object.keys(daily).length;
  const fmt=n=>n>=1000?(n/1000).toFixed(1)+'K':String(n);
  root.innerHTML=_settingsHeader('统计',true)+\`
  <div class="settings-section"><div class="settings-section-title">Token 用量</div><div class="settings-stat-grid">
    <div class="settings-stat-card"><div class="settings-stat-label">输入 Token</div><div class="settings-stat-value">\${fmt(totalIn)}</div><div class="settings-stat-sub">未命中缓存的新输入</div></div>
    <div class="settings-stat-card"><div class="settings-stat-label">输出 Token</div><div class="settings-stat-value">\${fmt(totalOut)}</div><div class="settings-stat-sub">回复生成</div></div>
  </div></div>
  <div class="settings-section"><div class="settings-section-title">缓存命中</div><div class="settings-stat-grid">
    <div class="settings-stat-card"><div class="settings-stat-label">命中总量</div><div class="settings-stat-value">\${fmt(cacheRead)}</div><div class="settings-stat-sub">从缓存读的 Token</div></div>
    <div class="settings-stat-card"><div class="settings-stat-label">命中率</div><div class="settings-stat-value">\${hitPct}%</div>
      <div style="height:6px;border-radius:3px;background:rgba(0,0,0,.08);margin:6px 0 4px;overflow:hidden">
        <div style="height:100%;width:\${hitPct}%;border-radius:3px;background:#7FA88C;transition:width .3s"></div>
      </div>
      <div class="settings-stat-sub">输入里从缓存来的占比</div></div>
  </div></div>
  <div class="settings-section"><div class="settings-section-title">消息统计</div><div class="settings-stat-grid">
    <div class="settings-stat-card"><div class="settings-stat-label">总消息数</div><div class="settings-stat-value">\${totalMsgs}</div><div class="settings-stat-sub">所有对话累计</div></div>
    <div class="settings-stat-card"><div class="settings-stat-label">活跃天数</div><div class="settings-stat-value">\${activeDays}</div><div class="settings-stat-sub">有聊天的天数</div></div>
  </div></div>
  <div class="settings-section"><div class="settings-section-title">最近 7 天</div><div class="settings-stat-card" style="padding:12px 16px">
    <div id="stgDaily"></div>
  </div></div>
  <div class="settings-section"><div class="settings-section-title">概览</div><div class="settings-card">
    <div class="settings-overview-row"><div class="settings-overview-icon">💬</div><div class="settings-overview-label">日均消息</div><div class="settings-overview-value">\${activeDays?Math.round(totalMsgs/activeDays):0}</div></div>
    <div class="settings-overview-row"><div class="settings-overview-icon">📊</div><div class="settings-overview-label">总 Token 消耗</div><div class="settings-overview-value">\${fmt(totalTokens)}</div></div>
    <div class="settings-overview-row"><div class="settings-overview-icon">📱</div><div class="settings-overview-label">当前模型</div><div class="settings-overview-value">\${currentModel()?.label||'Sonnet 5'}</div></div>
  </div></div>
  <div class="settings-section"><div class="settings-section-title">CC 订阅额度</div>
    <div class="settings-stat-grid" id="stgCcUsage">
      <div class="settings-stat-card"><div class="settings-stat-label">加载中…</div><div class="settings-stat-value">--</div><div class="settings-stat-sub">正在获取</div></div>
    </div>
  </div>\`;
  root.querySelector('#stgBack').onclick=()=>_renderSettingsRoot();
  _renderDaily(root.querySelector('#stgDaily'));
  _fetchCcUsage(root.querySelector('#stgCcUsage'));
}
// 每天一行：消息数 / 输入·输出 token / 命中缓存
function _renderDaily(container){
  if(!container)return;
  const dm=_tokenStats.dailyMessages||{};
  const dt=_tokenStats.dailyTokens||{};
  const days=Array.from(new Set(Object.keys(dm).concat(Object.keys(dt)))).sort().reverse().slice(0,7);
  if(!days.length){container.innerHTML='<div style="text-align:center;color:#77736c;font-size:13px;padding:8px 0">暂无数据</div>';return}
  const fmt=n=>n>=1000?(n/1000).toFixed(1)+'K':String(n||0);
  let html='<div style="display:flex;font-size:11px;color:#aaa49c;padding:0 0 6px"><div style="width:44px;flex:none">日期</div><div style="width:38px;flex:none;text-align:right">消息</div><div style="flex:1;text-align:right">输入/输出</div><div style="width:52px;flex:none;text-align:right">命中</div></div>';
  days.forEach(k=>{
    const msgs=dm[k]||0;const t=dt[k]||{};const inp=t.input||0,out=t.output||0,cr=t.cacheRead||0;
    const label=k.slice(5);
    html+=\`<div style="display:flex;align-items:center;font-size:12.5px;color:var(--text-primary);padding:7px 0;border-top:1px solid rgba(120,120,128,.10)">
      <div style="width:44px;flex:none;color:#77736c">\${label}</div>
      <div style="width:38px;flex:none;text-align:right">\${msgs}</div>
      <div style="flex:1;text-align:right;color:#77736c">\${fmt(inp)}/\${fmt(out)}</div>
      <div style="width:52px;flex:none;text-align:right;color:#7FA88C">\${fmt(cr)}</div>
    </div>\`;
  });
  container.innerHTML=html;
}`;

const edits = [
  { name: '统计追踪缓存', find: OLD_TRACK, replace: NEW_TRACK },
  { name: '统计页重排（删热力图+加缓存+每天一行）', find: OLD_STATS, replace: NEW_STATS },
  {
    name: '设置入口描述',
    find: '<div class="settings-row-title">统计</div><div class="settings-row-desc">用量、Token、聊天热力图</div>',
    replace: '<div class="settings-row-title">统计</div><div class="settings-row-desc">用量、Token、缓存命中</div>',
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  const before = out;
  out = out.split(e.find).join(e.replace);
  if (out === before) missed.push(e.name);
}

console.log('\n补丁结果：');
if (missed.length) {
  for (const e of edits) console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 没匹配上' : '  √ ' + e.name);
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['文件完整', /<\/html>/i.test(out)],
  ['追踪了缓存命中', /totalCacheRead=\(_tokenStats\.totalCacheRead/.test(out)],
  ['统计页有缓存命中区', out.includes('缓存命中') && out.includes('命中率')],
  ['热力图从统计页拿掉了', !/id="stgHeatmap"/.test(out) && !/_renderHeatmap\(root/.test(out)],
  ['每天一行渲染在', /function _renderDaily\(/.test(out) && out.includes('id="stgDaily"')],
  ['CC 额度还在', out.includes('CC 订阅额度') && out.includes('stgCcUsage')],
  ['入口描述换了', out.includes('用量、Token、缓存命中') && !out.includes('用量、Token、聊天热力图')],
  ['只改了一份', (out.match(/function _renderStats\(/g) || []).length === 1
    && (out.match(/function _renderDaily\(/g) || []).length === 1],
  ['没弄丢别的功能', ['_fetchCcUsage', '_settingsHeader', 'currentModel', 'chatnest_token_stats']
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
