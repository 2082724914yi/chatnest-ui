#!/usr/bin/env node
// 修好消息编辑：id 类型对不上，外加放开编辑助手消息。
//   node fix-edit-msgid.js [/var/www/chatnest/index.html]
//
// 两个 bug 同一个根因：前端假设消息 id 是数字，后端给的是 'msg-<hex>' 字符串。
//   1. messageId() 用 parseInt → NaN → 点编辑弹「这条消息要先重新打开会话才可编辑」
//   2. Number(m.id) <= Number(branchId) → NaN <= NaN → 永远 false
//      → 本地消息列表被整个 filter 空。第一个修好会立刻撞上这个。
//
// 顺带把「只能编辑你发出的消息」放开：编辑助手消息走原地改写（PATCH），
// 不重新生成 —— 改我说过的话，不是让我重答一遍。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');

const target = process.argv[2] || '/var/www/chatnest/index.html';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('editAssistantInPlace')) { console.log('已经打过，跳过'); process.exit(0); }

const ASSIST_EDIT = `
/* 编辑助手消息：原地改内容，不重新生成。
   改的是「我说过什么」，不是「让我重答」——重答是 renovate 那条路。 */
async function editAssistantInPlace(row,nextText){
  const id=messageId(row);
  if(!id){toast('这条消息还没落盘，等一下再试');return}
  if(!state.convId){toast('会话还没建立');return}
  try{
    const r=await fetch('/api/conversations/'+encodeURIComponent(state.convId)+'/messages/'+encodeURIComponent(id),{
      method:'PATCH',
      headers:{'Content-Type':'application/json',Authorization:\`Bearer \${state.token}\`},
      body:JSON.stringify({content:nextText})
    });
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.ok){toast(d.error||'改不动，稍后再试');return}
    setAssistantRowText(row,nextText);
    const m=(state._loadedMessages||[]).find(x=>String(x.id)===String(id));
    if(m){m.text=nextText;m.edited=true}
    if(state.convId)_refreshConvCache(state.convId);
    toast('改好了');
  }catch(e){toast('改不动：'+(e.message||e))}
}
/* 助手气泡的正文节点跟用户的不一样，单独写一个，别去动 setUserRowText */
function setAssistantRowText(row,text){
  if(!row)return;
  row.dataset.raw=text;
  const body=row.querySelector('.msg-text,.bubble-text,.md,.msg-body')||row.querySelector('.bubble')||row;
  try{ body.textContent=text; }catch(e){}
}
`;

const edits = [
  {
    name: 'messageId 认字符串 id',
    find: "function messageId(row){const id=parseInt(row?.dataset?.msgId||'',10);return Number.isFinite(id)?id:null}",
    replace:
      "/* 后端的 id 是 'msg-<hex>'，parseInt 出来是 NaN。这里只做非空判断，原样返回字符串。 */\n" +
      "function messageId(row){const id=String(row?.dataset?.msgId||'').trim();return id||null}",
  },
  {
    name: '本地历史按位置截断，不按 id 大小',
    // Number('msg-xxx') 是 NaN，NaN 比较永远 false，原来那句会把列表整个清空
    find: "      state._loadedMessages=(state._loadedMessages||[]).filter(m=>\n        keepSelf?Number(m.id)<=Number(branchId):Number(m.id)<Number(branchId));",
    replace:
      "      // id 是字符串，比不了大小；消息本来就是按时间排的数组，按下标截断才对\n" +
      "      const _bi=(state._loadedMessages||[]).findIndex(m=>String(m.id)===String(branchId));\n" +
      "      if(_bi>=0)state._loadedMessages=(state._loadedMessages||[]).slice(0,keepSelf?_bi+1:_bi);",
  },
  {
    name: '放开编辑助手消息',
    find: "  if(action==='edit'){\n    if(!isUser){toast('只能编辑你发出的消息');return}\n    enterEditMode(source,raw);\n  }",
    replace:
      "  if(action==='edit'){\n" +
      "    // 助手消息也能编辑：走原地改写，不重新生成\n" +
      "    _editState.assistant=!isUser;\n" +
      "    enterEditMode(source,raw);\n" +
      "  }",
  },
  {
    name: '保存时分流：我的消息原地改，你的消息重新生成',
    find: "if(_editState.active){const row=_editState.row,next=input.value.trim(),raw=row?.dataset?.raw||'';if(!next){toast('消息不能为空');return}if(next===raw){exitEditMode();return}exitEditMode({restore:false});editUserAndRegenerate(row,next);return}",
    replace: "if(_editState.active){const row=_editState.row,next=input.value.trim(),raw=row?.dataset?.raw||'';const isAsst=!!_editState.assistant;if(!next){toast('消息不能为空');return}if(next===raw){exitEditMode();return}exitEditMode({restore:false});if(isAsst)editAssistantInPlace(row,next);else editUserAndRegenerate(row,next);return}",
  },
  {
    name: '退出编辑时清掉标记',
    find: "  _editState.active=false;_editState.row=null;_editState.savedInput='';",
    replace: "  _editState.active=false;_editState.row=null;_editState.savedInput='';_editState.assistant=false;",
  },
  {
    name: '原地改写函数',
    find: "const _editState={active:false,row:null,savedInput:''};",
    replace: "const _editState={active:false,row:null,savedInput:'',assistant:false};\n" + ASSIST_EDIT,
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  const before = out;
  out = out.replace(e.find, e.replace);
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
  ['parseInt 那句没了', !out.includes("const id=parseInt(row?.dataset?.msgId")],
  ['Number 比较那句没了', !out.includes('Number(m.id)<=Number(branchId)')],
  ['不再挡助手消息', !out.includes("toast('只能编辑你发出的消息')")],
  ['没弄丢别的功能', ['pulsePanel', 'memoryPicker', 'obToolsBtn', 'editUserAndRegenerate']
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
