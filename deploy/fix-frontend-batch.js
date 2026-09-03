#!/usr/bin/env node
// 四个前端小毛病一起修。
//   node fix-frontend-batch.js [/var/www/chatnest/index.html]
//
// F 进 chat 页停在聊天记录开头，要手动往下划 —— enterChat 显示后没滚到底。
// H 从主页进 memory，按叉返回回到的是 chat 不是主页 —— 因为进 memory 前先 enterChat 了。
// I 侧边栏搜索：后端返回 conversation_id/title/time，前端却读 conv_id/conv_title/time_text，
//   对不上 —— 结果时间空着、标题错、点了跳不动。顺手把日期加上。
// A 手表「我的」加个刷新按钮：点一下跑她的捷径，回来自动重读。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');

const target = process.argv[2] || '/var/www/chatnest/index.html';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('watchRefresh')) { console.log('已经打过，跳过'); process.exit(0); }

const edits = [
  {
    // F：显示后滚到底。rAF 一次 + 延迟一次（等图片/字体撑开高度）
    name: 'F 进 chat 页停在底部',
    find: "function enterChat(){$('home').classList.add('hidden');$('chat').classList.remove('hidden')}",
    replace: "function enterChat(){$('home').classList.add('hidden');$('chat').classList.remove('hidden');" +
      "requestAnimationFrame(scrollBottom);setTimeout(scrollBottom,120);setTimeout(scrollBottom,400)}",
  },
  {
    // H：从主页开 memory 不要先 enterChat，直接盖在主页上，关了就回主页
    name: 'H memory 从主页开、返回回主页',
    find: "if(page==='memory'){enterChat();setTimeout(openMemoryPicker,200);return}",
    replace: "if(page==='memory'){openMemoryPicker();return}",
  },
  {
    // I：字段映射 + 日期
    name: 'I 搜索字段对齐 + 加日期',
    find: "    renderSearchResults(data.results||[],q);",
    replace:
      "    const _mapped=(data.results||[]).map(function(r){return {\n" +
      "      conv_id:r.conv_id||r.conversation_id,\n" +
      "      conv_title:r.conv_title||r.title||'对话',\n" +
      "      message_id:r.message_id,\n" +
      "      role:r.role,\n" +
      "      snippet:r.snippet,\n" +
      "      time_text:r.time_text||_fmtSearchDate(r.time),\n" +
      "      starred:r.starred,\n" +
      "    }});\n" +
      "    renderSearchResults(_mapped,q);",
  },
  {
    name: 'I 日期格式化函数',
    find: "async function runChatSearch(q){",
    replace:
      "function _fmtSearchDate(iso){\n" +
      "  const t=Date.parse(iso||'');if(!isFinite(t))return '';\n" +
      "  const d=new Date(t),now=new Date();\n" +
      "  const hm=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');\n" +
      "  if(d.toDateString()===now.toDateString())return '今天 '+hm;\n" +
      "  return (d.getMonth()+1)+'月'+d.getDate()+'日 '+hm;\n" +
      "}\n" +
      "async function runChatSearch(q){",
  },
  {
    // A：手表卡头上加刷新按钮
    name: 'A 手表刷新按钮',
    find: '<div class="wm-head"><i class="wm-dot" id="watchDot"></i><span class="wm-when" id="watchWhen">读取中…</span></div>',
    replace: '<div class="wm-head"><i class="wm-dot" id="watchDot"></i><span class="wm-when" id="watchWhen">读取中…</span>' +
      '<button class="wm-refresh" id="watchRefresh" type="button" aria-label="刷新">↻</button></div>',
  },
  {
    name: 'A 刷新按钮样式',
    find: '.wm-head{display:flex;align-items:center;gap:8px;margin-bottom:11px}',
    replace: '.wm-head{display:flex;align-items:center;gap:8px;margin-bottom:11px}\n' +
      '.wm-refresh{margin-left:auto;flex:none;width:28px;height:28px;border:0;border-radius:50%;' +
      'background:rgba(74,55,40,.07);color:var(--text-secondary);font-size:15px;line-height:1;cursor:pointer;-webkit-tap-highlight-color:transparent}\n' +
      'html[data-chat-bg="dark"] .wm-refresh{background:rgba(255,255,255,.09)}',
  },
  {
    // A：刷新逻辑 —— 跑她的捷径，回来自动重读。捷径名记在本地，第一次问一下。
    name: 'A 刷新逻辑',
    find: "async function loadWatch(){",
    replace:
      "let _watchRefreshing=false;\n" +
      "function watchRefresh(){\n" +
      "  let name=localStorage.getItem('watch_shortcut_name')||'';\n" +
      "  if(!name){name=(prompt('你那个上传健康的捷径叫什么名字？（填一次就记住）')||'').trim();if(!name)return;localStorage.setItem('watch_shortcut_name',name)}\n" +
      "  _watchRefreshing=true;\n" +
      "  const w=$('watchWhen');if(w)w.textContent='让手机跑一下捷径…';\n" +
      "  // 打开 Shortcuts 跑捷径；跑完 iOS 会切回来，靠 visibilitychange 重读\n" +
      "  try{location.href='shortcuts://run-shortcut?name='+encodeURIComponent(name)}catch(e){_watchRefreshing=false}\n" +
      "}\n" +
      "document.addEventListener('visibilitychange',function(){\n" +
      "  if(!document.hidden&&_watchRefreshing){_watchRefreshing=false;setTimeout(loadWatch,1500)}\n" +
      "});\n" +
      "async function loadWatch(){",
  },
  {
    name: 'A 刷新按钮接上点击',
    find: "  if(name==='mine')loadWatch();",
    replace: "  if(name==='mine'){loadWatch();const _rb=$('watchRefresh');if(_rb&&!_rb._bound){_rb._bound=1;_rb.addEventListener('click',watchRefresh)}}",
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
  ['进 chat 滚到底', /requestAnimationFrame\(scrollBottom\);setTimeout\(scrollBottom/.test(out)],
  ['memory 不再先 enterChat', !/if\(page==='memory'\)\{enterChat\(\)/.test(out)],
  ['搜索做了字段映射', /conv_id:r\.conv_id\|\|r\.conversation_id/.test(out)],
  ['搜索有日期函数', /function _fmtSearchDate/.test(out)],
  ['手表刷新按钮在', out.includes('id="watchRefresh"') && /function watchRefresh/.test(out)],
  ['刷新回来自动重读', /visibilitychange/.test(out) && /setTimeout\(loadWatch,1500\)/.test(out)],
  ['只插了一次', (out.match(/function watchRefresh/g) || []).length === 1
    && (out.match(/function _fmtSearchDate/g) || []).length === 1],
  ['没弄丢别的功能', ['pulseTabBar', 'ctxMeterFill', 'watchMetrics', 'latentUnresolvedOut', 'jumpToSearchHit']
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
