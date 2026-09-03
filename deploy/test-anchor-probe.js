const fs=require('fs');
const RE=/conv\.history\.push\((\{[^;]*?role: ['"]assistant['"][^;]*?\})\);/g;
const cases={
 '仓库版':`    conv.history.push({ id: assistantMsgId, role: 'assistant', content: fullResponse, thinking: thinkingText, traces: finalTraces, time: new Date().toISOString() });`,
 '中转站版':`      conv.history.push({ id: assistantMsgId, role: 'assistant', content: fullResponse, traces: cleanTraces(), time: new Date().toISOString() });`,
 '字段换序':`  conv.history.push({ role: 'assistant', content: fullResponse, id: assistantMsgId, time: new Date().toISOString() });`,
 '双引号':`  conv.history.push({ id: x, role: "assistant", content: y });`,
 '多几个字段':`  conv.history.push({ id: assistantMsgId, role: 'assistant', content: fullResponse, thinking: t, traces: tr, files: f, choices: c, time: new Date().toISOString() });`,
 '用户消息(不该中)':`  conv.history.push({ id: userMsgId, role: 'user', content: message, time: new Date().toISOString() });`,
};
let bad=0;
for(const [name,line] of Object.entries(cases)){
  RE.lastIndex=0;
  const hit=RE.test(line);
  const should=!name.includes('不该中');
  const ok=hit===should;
  if(!ok)bad++;
  console.log(`[${ok?'OK  ':'FAIL'}] ${name} → ${hit?'命中':'没中'}`);
}
process.exit(bad?1:0);
