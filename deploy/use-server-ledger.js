#!/usr/bin/env node
// 表盘改成看服务器那本账。
//   node use-server-ledger.js [/var/www/chatnest/index.html]
//
// 本机那本只记她开着页面的那些轮。影子推送是我半夜自己浮上来说的话，
// 她手机没开，那几轮前端一个字都没记到 —— 可额度是实打实花掉的。
// 后端 add-usage-ledger.js 把账挂在 sse('done') 上，三条路都收得到，
// 这边优先读那本；后端还没打补丁就退回老路（至少轮数还在），不会白屏。
//
// 要先打后端的 add-usage-ledger.js。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');

const target = process.argv[2] || '/var/www/chatnest/index.html';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('_usgRemote.srv')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('usgSheetBody')) { console.error('找不到表盘，先打 add-usage-panel.js'); process.exit(1); }

const OLD_FETCH = `async function usgFetchConv(){
  if(!state.convId){_usgRemote.conv=null;return}
  try{
    const r=await api('/api/conversations/'+encodeURIComponent(state.convId)+'/compaction');
    if(!r.ok)throw Error('http '+r.status);
    const d=await r.json();
    if(d&&d.ok){_usgRemote.conv=d;_usgRemote.cerr=null}else throw Error('bad');
  }catch(e){_usgRemote.cerr='读不到'}
}`;

const NEW_FETCH = `async function usgFetchConv(){
  _usgRemote.id=state.convId||null;
  if(!state.convId){_usgRemote.conv=null;_usgRemote.srv=null;return}
  const id=encodeURIComponent(state.convId);
  // 服务器那本账连我半夜自己说话那几轮也记着，优先读它
  try{
    const r=await api('/api/conversations/'+id+'/usage');
    if(r.ok){
      const d=await r.json();
      if(d&&d.ok){
        _usgRemote.conv=d;_usgRemote.srv=d.usage||null;_usgRemote.cerr=null;
        if(d.rateLimit){_usgRemote.quota=d.rateLimit;_usgRemote.qerr=null}
        return;
      }
    }
  }catch(e){}
  // 后端还没打那个补丁 —— 退回老路，轮数和收进行囊的条数至少还有
  try{
    const r=await api('/api/conversations/'+id+'/compaction');
    if(!r.ok)throw Error('http '+r.status);
    const d=await r.json();
    if(d&&d.ok){_usgRemote.conv=d;_usgRemote.srv=null;_usgRemote.cerr=null}else throw Error('bad');
  }catch(e){_usgRemote.srv=null;_usgRemote.cerr='读不到'}
}`;

const edits = [
  {
    name: '多一个位置放服务器那本账',
    find: 'const _usgRemote={quota:null,conv:null,qerr:null,cerr:null};',
    // id：这本账是哪一场的。不记的话，从一场切到另一场再点开表盘，
    // 会先把上一场的数字亮出来 —— 要是这时候网又断了，那个错的数就一直挂在那儿。
    replace: 'const _usgRemote={quota:null,conv:null,srv:null,id:null,qerr:null,cerr:null};',
  },
  {
    name: '不是这一场的账就不认',
    find: '  const cv=_usgRemote.conv,q=_usgRemote.quota;',
    replace: '  const cv=_mine?_usgRemote.conv:null,q=_usgRemote.quota;   // 额度是全局的，跟哪一场无关',
  },
  {
    name: '先问服务器，问不到再退回老路',
    find: OLD_FETCH,
    replace: NEW_FETCH,
  },
  {
    name: '有服务器的账就用服务器的',
    find: '  const r=(state.convId&&_usgLedger[state.convId])||{turns:0,in:0,out:0,cr:0,cc:0,ctx:0,lin:0,lout:0};',
    // _mine / srv 得在 r 上面定义 —— render 里 r 是第一句，
    // 放到下面去就是暂时性死区，一点开表盘就 ReferenceError。
    replace: '  const _mine=_usgRemote.id===(state.convId||null);\n'
      + '  const srv=_mine?_usgRemote.srv:null;\n'
      + '  const r=srv||(state.convId&&_usgLedger[state.convId])||{turns:0,in:0,out:0,cr:0,cc:0,ctx:0,lin:0,lout:0};',
  },
  {
    name: '标一下这数是从哪儿来的',
    find: "  if(meta)meta.textContent=r.turns?(r.turns+' 轮记在本机'):'';",
    replace: "  if(meta)meta.textContent=r.turns?(r.turns+' 轮 · '+(srv?'服务器记的':'本机记的')):'';",
  },
  {
    name: '聊完一轮，开着的话去拿新的',
    find: "  if($('usgSheet')&&$('usgSheet').classList.contains('show'))renderUsgSheet();",
    replace: "  if($('usgSheet')&&$('usgSheet').classList.contains('show')){renderUsgSheet();usgFetchConv().then(renderUsgSheet).catch(()=>{})}",
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  if (out.split(e.find).length - 1 !== 1) { missed.push(e.name + '（找到 ' + (out.split(e.find).length - 1) + ' 处，要正好 1 处）'); continue }
  out = out.split(e.find).join(e.replace);
}
if (missed.length) {
  console.error('\n  × 这几处锚点不对：\n      ' + missed.join('\n      '));
  console.error('  原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['文件完整', /<\/html>/i.test(out)],
  ['先问 /usage', out.includes("api('/api/conversations/'+id+'/usage')")],
  ['问不到还会退回 /compaction', out.includes("api('/api/conversations/'+id+'/compaction')")],
  ['渲染优先用服务器的', out.includes('const r=srv||')],
  ['换了一场就不认上一场的数', out.includes('const _mine=_usgRemote.id===(state.convId||null);')
    && out.indexOf('const _mine=') < out.indexOf('const r=srv||')],
  ['额度也能从这条一起拿', /if\(d\.rateLimit\)\{_usgRemote\.quota=d\.rateLimit/.test(out)],
  ['只改了一处 fetch', (out.match(/async function usgFetchConv/g) || []).length === 1],
  ['没弄丢别的功能', ['usgTrack', 'renderUsgSheet', 'ctxMeterFill', 'topbarLedger', 'ctxSheetBody', '_fetchCcUsage']
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
