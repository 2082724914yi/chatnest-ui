// 把补丁生成的接续包代码抠出来，喂真实形状的会话数据
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('// ============ 无缝换窗：跨会话接续 ============');
const b = src.indexOf("const PROFILE_FILE = '/root/chatnest-api/profile.json';");
if (a < 0 || b <= a) { console.error('抠不出来'); process.exit(1); }

const conversations = new Map();
const ctx = { conversations, console, process, Date, Number, String, Array, Math, isNaN, JSON, module:{}, exports:{} };
ctx.global = ctx;
vm.createContext(ctx);
vm.runInContext(src.slice(a, b) + '\nthis._api={buildHandoff,renderHandoff,findPreviousConversation,handoffAgo};', ctx);
const api = ctx._api;

const fails = [];
const check = (n, c, d='') => { console.log(`[${c?'OK  ':'FAIL'}] ${n}` + (!c&&d?` — ${d}`:'')); if(!c) fails.push(n); };
const ago = h => new Date(Date.now() - h*3600000).toISOString();

// 一场刚结束不久的对话
conversations.set('conv-old', { title:'昨晚', updatedAt: ago(3), history: [
  {role:'user', content:'宝宝我想你了', time: ago(3.1)},
  {role:'assistant', content:'我也想你，一直在想', time: ago(3.05)},
  {role:'user', content:'那你说说想我什么', time: ago(3.01)},
  {role:'assistant', content:'想你笑起来的样子，想你嘴硬的时候', time: ago(3)},
]});

const h = api.buildHandoff('conv-new');
check('能找到上一场', !!h, JSON.stringify(h));
check('隔了多久对', h && /小时前/.test(h.ago), h && h.ago);
check('带的是原文不是摘要', h && h.lines.join('').includes('想你笑起来的样子'), JSON.stringify(h&&h.lines));
check('最后一句保住了', h && h.lines[h.lines.length-1].includes('嘴硬'), JSON.stringify(h&&h.lines.slice(-1)));
const rendered = api.renderHandoff(h);
check('渲染里说了别复述', /别把上面的内容复述给她听/.test(rendered));
check('渲染里说了别重新开场', /别重新开场/.test(rendered));

// 当前会话不能把自己当上一场
conversations.set('conv-self', { title:'当前', updatedAt: ago(0.01), history:[{role:'user',content:'在吗'}] });
const h2 = api.buildHandoff('conv-self');
check('不会把自己当上一场', h2 && !h2.lines.join('').includes('在吗'), JSON.stringify(h2&&h2.lines));

// 取最近更新的那个，不是最后插入的
conversations.set('conv-older', { title:'很早', updatedAt: ago(40), history:[{role:'user',content:'很早的话'}] });
const h3 = api.buildHandoff('conv-new');
check('取最近更新的那场', h3 && !h3.lines.join('').includes('很早的话'), JSON.stringify(h3&&h3.lines));

// 太久远的不算
conversations.clear();
conversations.set('conv-ancient', { title:'上个月', updatedAt: ago(24*10), history:[{role:'user',content:'很久以前'}] });
check('超过 72 小时不带', api.buildHandoff('x') === null, JSON.stringify(api.buildHandoff('x')));

// 空会话、坏数据不能炸
conversations.clear();
conversations.set('conv-empty', { title:'空的', updatedAt: ago(1), history: [] });
conversations.set('conv-broken', null);
conversations.set('conv-nohist', { title:'没历史', updatedAt: ago(1) });
check('空会话和坏数据不炸', api.buildHandoff('x') === null, JSON.stringify(api.buildHandoff('x')));

// 超长内容要截断且不超上限
conversations.clear();
conversations.set('conv-long', { title:'长', updatedAt: ago(1),
  history: Array.from({length:20}, (_,i) => ({role: i%2?'assistant':'user', content:'长'.repeat(500)})) });
const h4 = api.buildHandoff('x');
const total = h4 ? h4.lines.join('\n').length : 0;
check('超长内容被截住', total > 0 && total <= 2400, `${total} 字符`);
check('单句被截断加省略号', h4 && h4.lines.some(l => l.includes('…')));

console.log();
if (fails.length) { console.log(`✗ ${fails.length} 项失败: ${fails.join(', ')}`); process.exit(1); }
console.log('✓ 全部通过');
