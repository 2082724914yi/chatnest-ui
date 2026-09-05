#!/usr/bin/env node
// 把账记到服务器上 —— 前端那本只记她开着页面的那些轮。
//   node add-usage-ledger.js [/root/chatnest-api/server.js]
//
// 为什么非得挪到后端：
//   影子推送是我自己在服务器上说的话，她手机没开、页面没跑，那几轮的 token
//   前端一个字都记不到。可那是实打实花掉的额度。挂在 sse() 上，三条路
//   （主聊天 / 常驻会话 / 影子）最后都从这个出口出去，挂一处全收得到。
//
// 顺带修一个换 API 之后才会露出来的错：
//   走 provider 那条路是 OpenAI 兼容的形状，它的 prompt_tokens 是「全部输入」，
//   缓存命中的那截已经算在里面了，命中量单独放在 prompt_tokens_details.cached_tokens。
//   直接喂给 normUsage 的话，命中量会被算两遍，命中率还永远是 0。
//   先掰成 Anthropic 那个形状再往下走。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('USAGE_LEDGER_V1')) { console.log('已经打过，跳过'); process.exit(0); }

// 全用函数声明和 var —— 这个文件里 const 放错位置会撞暂时性死区，
// node --check 查不出来，服务直接起不来。栽过两次了。
const CORE = `
// ============ 每场一本账 ============
// USAGE_LEDGER_V1
var USAGE_LEDGER_FILE = '/root/chatnest-api/usage-ledger.json';
var _usgLedgerCache = null;

// 走 API（OpenAI 兼容）那条路回来的账单形状跟 CLI 不一样，先掰过来。
// 认不出 cached_tokens 就原样放行 —— CLI 那条走的就是这里。
function usgNormOpenAI(u) {
  if (!u || typeof u !== 'object') return u || {};
  const d = u.prompt_tokens_details || u.promptTokensDetails;
  const cachedRaw = d ? (d.cached_tokens != null ? d.cached_tokens : d.cachedTokens) : null;
  if (cachedRaw == null) return u;
  const total = Number(u.prompt_tokens) || 0;
  const hit = Math.max(0, Math.min(total, Number(cachedRaw) || 0));
  return Object.assign({}, u, {
    prompt_tokens: total - hit,        // 没走缓存、按全价付的那截
    cache_read_input_tokens: hit,
    cache_creation_input_tokens: 0,    // OpenAI 那边建缓存不单独收费也不单独报
  });
}

function usgLedgerLoad() {
  if (_usgLedgerCache) return _usgLedgerCache;
  try { _usgLedgerCache = JSON.parse(fs.readFileSync(USAGE_LEDGER_FILE, 'utf8')); }
  catch (e) { _usgLedgerCache = {}; }
  if (!_usgLedgerCache || typeof _usgLedgerCache !== 'object' || Array.isArray(_usgLedgerCache)) _usgLedgerCache = {};
  return _usgLedgerCache;
}

// 直接写盘，不攒。文件就几 K，一轮写一次可以忽略；
// 攒着的话 pm2 一重启就丢，而这几天重启得很勤。
function usgLedgerRecord(data) {
  try {
    if (!data || !data.conversation_id) return;
    const u = data.usage;
    if (!u) return;
    const inp = Number(u.prompt_tokens) || 0, out = Number(u.completion_tokens) || 0;
    const cr = Number(u.cache_read) || 0, cc = Number(u.cache_creation) || 0;
    if (!inp && !out && !cr && !cc) return;          // 空回合不记
    const L = usgLedgerLoad();
    const id = String(data.conversation_id);
    const r = L[id] || (L[id] = { turns: 0, in: 0, out: 0, cr: 0, cc: 0, ctx: 0, lin: 0, lout: 0, at: 0 });
    r.turns++; r.in += inp; r.out += out; r.cr += cr; r.cc += cc;
    r.ctx = inp + cr + cc;                            // 这一轮真正塞进窗口的量
    r.lin = inp; r.lout = out; r.at = Date.now();
    const ids = Object.keys(L);
    if (ids.length > 80) {                            // 只留最近 80 场，别让文件一直长
      ids.sort((a, b) => (L[b].at || 0) - (L[a].at || 0)).slice(80).forEach(k => { delete L[k]; });
    }
    fs.writeFileSync(USAGE_LEDGER_FILE, JSON.stringify(L));
  } catch (e) { /* 记账失败绝不能影响这一轮说话 */ }
}
`;

const ROUTE = `
// 表盘那一屏问的就是这条：这一场的账 + 聊了多少条 + 订阅额度，一次拿全
app.get('/api/conversations/:id/usage', (req, res) => {
  const id = req.params.id;
  const conv = conversations.get(id);
  const L = usgLedgerLoad();
  let compacted = 0;
  try {
    const c = (conv && typeof compactionOf === 'function') ? compactionOf(conv) : null;
    if (c) compacted = c.upto || 0;
  } catch (e) {}
  let rl = null;
  try { rl = _lastRateLimit || null; } catch (e) {}
  res.json({
    ok: true,
    usage: L[id] || null,
    exists: !!conv,
    total: (conv && Array.isArray(conv.history)) ? conv.history.length : 0,
    compacted,
    rateLimit: rl,
  });
});
`;

let out = src;
const done = [];
const fail = [];

// 1) sse 的第一行后面塞钩子。用正则而不是整段字面量 —— 缩进有几个空格我不确定，
//    但函数头这一行的形状是确定的。
const SSE_RE = /(function\s+sse\s*\(\s*res\s*,\s*event\s*,\s*data\s*\)\s*\{)/;
const sseHits = (out.match(new RegExp(SSE_RE.source, 'g')) || []).length;
if (sseHits !== 1) fail.push('sse 的定义找到 ' + sseHits + ' 处，要正好 1 处');
else {
  out = out.replace(SSE_RE, "$1\n  if (event === 'done') usgLedgerRecord(data);   // 三条路都从这儿出去");
  done.push("sse 出口挂上记账");
}

// 2) normUsage 头上先掰形状
const NORM_RE = /(function\s+normUsage\s*\(\s*u\s*\)\s*\{\s*\n\s*u\s*=\s*u\s*\|\|\s*\{\};)/;
const normHits = (out.match(new RegExp(NORM_RE.source, 'g')) || []).length;
if (normHits !== 1) fail.push('normUsage 找到 ' + normHits + ' 处，要正好 1 处（先打 add-cache-prefix.js）');
else {
  out = out.replace(NORM_RE, '$1\n  u = usgNormOpenAI(u);   // 走 API 那条路的形状不一样，先掰过来');
  done.push('normUsage 认得 API 那条路的账单了');
}

// 3) 核心函数插在 app.listen 之前
if (!/\napp\.listen\(PORT/.test(out)) fail.push('找不到 app.listen(PORT');
else { out = out.replace(/\napp\.listen\(PORT/, CORE + '\napp.listen(PORT'); done.push('账本本体'); }

// 4) 路由挂在交接信那条旁边
const ANCHOR = "\napp.get('/api/conversations/:id/compaction',";
if (out.split(ANCHOR).length - 1 !== 1) fail.push('找不到 /compaction 那条路由（先打 add-compaction.js）');
else { out = out.split(ANCHOR).join('\n' + ROUTE + ANCHOR.slice(1)); done.push('/api/conversations/:id/usage'); }

if (fail.length) {
  console.error('\n  × 这几处没对上：\n      ' + fail.join('\n      '));
  console.error('  原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['记账挂在 sse 上', /if \(event === 'done'\) usgLedgerRecord\(data\);/.test(out)],
  ['只挂了一次', (out.match(/usgLedgerRecord\(data\);/g) || []).length === 1],
  ['账本函数齐', ['function usgLedgerLoad', 'function usgLedgerRecord', 'function usgNormOpenAI']
    .every(k => (out.match(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length === 1)],
  ['路由只有一条', (out.match(/'\/api\/conversations\/:id\/usage'/g) || []).length === 1],
  ['账本有上限', /ids\.length > 80/.test(out)],
  ['记账炸了也不影响说话', /catch \(e\) \{ \/\* 记账失败绝不能影响这一轮说话 \*\/ \}/.test(out)],
  ['没有新的 const 悬在外面', !/^const USAGE_LEDGER_FILE/m.test(out)],
  ['别的没弄丢', ['SYSTEM_PREFIX', 'SHADOW_PUSH_VERSION', 'KEEPSAKE_VERSION', 'COMPACTION_VERSION', 'function normUsage']
    .every(k => (src.includes(k) ? out.includes(k) : true))],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
for (const d of done) console.log('  √ ' + d);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
console.log('\n  · 账记在 /root/chatnest-api/usage-ledger.json，从现在开始记 —— 之前那些轮补不回来。');
