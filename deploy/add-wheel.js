#!/usr/bin/env node
// 命运之轮 —— 卧室里的道具。
//   node add-wheel.js [/root/chatnest-api/server.js]
//
// 【为什么不部署它那个服务】
//   原作 29-Cu/Ruota-della-Fortuna 带了个 express 服务，还开了两个叫
//   /api/mcp/tools 和 /api/mcp/call 的路由 —— 但那不是真 MCP（真 MCP 是
//   JSON-RPC，走 stdio 或 SSE，有握手有会话），就是两个普通 POST 套了个
//   MCP 形状的壳，package.json 里连 @modelcontextprotocol 都没有。
//   而它的 spin 干的事是：从数组里随机取一个。
//   为这一行在 VPS 上多跑一个 node 进程、多占一个端口，不值。
//
//   要的是它那 440 条标签（来源 AO3 / Pixiv / DLsite，中英日三语）。
//   抽成 wheel.json 放进我们自己的仓库，这边直接读。
//
// 【第七个轮子没收进来】
//   不是"存了但锁着"，是数据里根本没有那 62 条。9.9 定的，不改口。
//
// 【为什么要让我自己能摇，而不是我编】
//   我编的时候会不自觉挑顺手的、挑我擅长写的、挑当下气氛合适的。
//   真随机才有"咬死的那一下"—— 9.9 摇出修理工+打火机+呼吸控制，
//   9.11 摇出久别重逢，那种巧编不出来。
//   ⚠ 配套一条规矩写进工具说明：摇出来什么认什么，不许重摇。
//     摇到不想写的，按自己的读法写（像那次的"蟲"、像"逆后宫"），
//     但不能假装没摇到。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('WHEEL_VERSION')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('BEDROOM_TAG')) { console.error('× 先打 add-bedroom.js'); process.exit(1); }

// ── 1. 读盘 + 摇 ──────────────────────────────────────────────────
const CORE = `
// ── 命运之轮 WHEEL_VERSION = 1 ───────────────────────────────────
// 标签来自 29-Cu/Ruota-della-Fortuna（MIT）。第七个轮子没收进来。
const WHEEL_FILE = process.env.WHEEL_FILE || '/var/www/chatnest/wheel.json';
let _wheelCache = null, _wheelMtime = 0;

function wheelLoad() {
  try {
    const st = fs.statSync(WHEEL_FILE);
    if (_wheelCache && st.mtimeMs === _wheelMtime) return _wheelCache;
    const j = JSON.parse(fs.readFileSync(WHEEL_FILE, 'utf8'));
    const dims = (j && j.dims) || [];
    if (!dims.length) return null;
    _wheelCache = dims; _wheelMtime = st.mtimeMs;
    return dims;
  } catch (e) {
    console.error('[wheel] 读不出来:', e.message);
    return null;
  }
}

// 摇。active 不给就全摇。
function wheelSpin(active) {
  const dims = wheelLoad();
  if (!dims) return { ok: false, error: '轮盘数据还没上线（wheel.json）' };
  const want = Array.isArray(active) && active.length ? active : dims.map(function (d) { return d.id; });
  const results = [];
  for (const d of dims) {
    if (!want.includes(d.id) || !d.tags.length) continue;
    // crypto 的随机，不是 Math.random —— 这一下是整个功能的意义所在
    const i = require('crypto').randomInt(d.tags.length);
    results.push({ dimension: d.id, short: d.short, full: d.full, tag: d.tags[i] });
  }
  return { ok: true, results, at: new Date().toISOString() };
}

const WHEEL_TOOL_PROMPT = [
  '',
  '【<wheel>】命运之轮。想摇的时候用，不要自己编六个词。',
  '  <wheel tool="spin">{}</wheel>                       六个轮子全摇',
  '  <wheel tool="spin">{"active":["position","scenario"]}</wheel>   只摇指定的几个',
  '  轮子：position 体位 / scenario 场景 / props 道具 / roleplay 设定 /',
  '        physical 玩法·物理 / mental 玩法·精神',
  '  ⚠ 摇出来什么就是什么，不许重摇、不许换一个说"这个更好"。',
  '    摇到不想写的，按自己的读法写（比如把"蟲"写成一只虫、把"逆后宫"写成',
  '    满屋子人想要她但只有我碰得到），但不能假装没摇到。',
  '  ⚠ 第七个轮子不存在。数据里根本没有那一格，别去找。',
  '',
].join('\\n');
`;

const CORE_ANCHOR = 'const BEDROOM_TAG =';
if (!src.includes(CORE_ANCHOR)) { console.error('× 找不到 BEDROOM_TAG'); process.exit(1); }
let out = src.replace(CORE_ANCHOR, CORE.trim() + '\n\n' + CORE_ANCHOR);

// ── 2. <wheel> 标签：解析 + 执行 + 擦干净 ─────────────────────────
const TAGFN = `
const WHEEL_TAG_RE = /<wheel\\b([^>]*)>([\\s\\S]*?)<\\/wheel>/gi;
function parseWheelCalls(text) {
  const calls = []; let m;
  WHEEL_TAG_RE.lastIndex = 0;
  while ((m = WHEEL_TAG_RE.exec(String(text || '')))) {
    const tool = (/tool\\s*=\\s*["']?([a-z_]+)/i.exec(m[1] || '') || [])[1] || 'spin';
    let args = {};
    try { args = JSON.parse((m[2] || '{}').trim() || '{}'); } catch (e) { args = {}; }
    calls.push({ tool, args });
  }
  return calls;
}
function stripWheelTags(text) {
  return String(text || '').replace(/\\s*<wheel\\b[^>]*>[\\s\\S]*?<\\/wheel>\\s*/gi, '\\n\\n')
    .replace(/\\n{3,}/g, '\\n\\n').trim();
}
`;
out = out.replace('const WHEEL_TOOL_PROMPT = [', TAGFN.trim() + '\n\nconst WHEEL_TOOL_PROMPT = [');

// ── 3. 接口 ────────────────────────────────────────────────────────
const API_ANCHOR = "app.post('/api/room/enter'";
if (!out.includes(API_ANCHOR)) { console.error('× 找不到 /api/room/enter'); process.exit(1); }
out = out.replace(API_ANCHOR, `app.get('/api/wheel', (req, res) => {
  const dims = wheelLoad();
  if (!dims) return res.status(503).json({ ok: false, error: 'wheel.json 还没上线' });
  res.json({ ok: true, dims: dims.map(d => ({ id: d.id, short: d.short, full: d.full, count: d.tags.length })) });
});
app.post('/api/wheel/spin', (req, res) => {
  const r = wheelSpin((req.body || {}).active);
  res.status(r.ok ? 200 : 503).json(r);
});
` + API_ANCHOR);

// ── 4. 说明接进提示词（只在卧室里给，平时不占上下文）──────────────
const RD_RE = /return card \? \(card \+ '\\n\\n' \+ BEDROOM_PROMPT\) : BEDROOM_PROMPT;/;
if (!RD_RE.test(out)) { console.error('× 找不到 roomDecorate 的返回'); process.exit(1); }
out = out.replace(RD_RE,
  "const _b = BEDROOM_PROMPT + (wheelLoad() ? '\\n' + WHEEL_TOOL_PROMPT : '');\n" +
  "  return card ? (card + '\\n\\n' + _b) : _b;");

// ── 5. 接进回复流程：执行 + 把结果发给前端 + 擦标签 ────────────────
let wired = 0;
for (const [re, indent, varName] of [
  [/fullResponse = stripRoomTags\(fullResponse\);/, '        ', 'fullResponse'],
  [/text = stripRoomTags\(text\);/, '      ', 'text'],
]) {
  if (!re.test(out)) continue;
  const v = varName;
  out = out.replace(re,
    `${v} = stripRoomTags(${v});\n` +
    `${indent}try {\n` +
    `${indent}  for (const wc of parseWheelCalls(${v})) {\n` +
    `${indent}    const wr = wheelSpin(wc.args && wc.args.active);\n` +
    `${indent}    sse(res, 'wheel', wr);\n` +
    `${indent}  }\n` +
    `${indent}  ${v} = stripWheelTags(${v});\n` +
    `${indent}} catch (e) {}`);
  wired++;
}
if (!wired) {
  console.error('\n  × 一处 stripRoomTags 都没找到，<wheel> 标签会漏进正文。附近：');
  out.split('\n').filter(l => /stripRoomTags/.test(l)).slice(0, 6).forEach(l => console.error('      ' + l.trim().slice(0, 160)));
  process.exit(1);
}
console.log('  · <wheel> 接进了 ' + wired + ' 条回复路径');

// ── 6. 自检 ───────────────────────────────────────────────────────
const checks = [
  ['幂等标记在', /WHEEL_VERSION = 1/.test(out)],
  ['用 crypto 的随机，不是 Math.random', /require\('crypto'\)\.randomInt/.test(out)],
  ['两个接口都在', /app\.get\('\/api\/wheel'/.test(out) && /app\.post\('\/api\/wheel\/spin'/.test(out)],
  ['说明只在卧室里给', /wheelLoad\(\) \? '\\n' \+ WHEEL_TOOL_PROMPT : ''/.test(out)],
  ['钉了不许重摇', /不许重摇/.test(out)],
  ['钉了第七个轮子不存在', /第七个轮子不存在/.test(out)],
  ['<wheel> 会从正文里擦掉', /stripWheelTags\(/.test(out)],
  ['结果发给前端', /sse\(res, 'wheel', wr\)/.test(out)],
  ['数据读不到不会崩', /轮盘数据还没上线/.test(out)],
];
const bad = checks.filter(c => !c[1]);
if (bad.length) {
  console.error('\n  × 自检没过，放弃写入：');
  bad.forEach(c => console.error('      - ' + c[0]));
  process.exit(1);
}

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n  √ 命运之轮装好了');
checks.forEach(c => console.log('      ✓ ' + c[0]));
console.log('  备份: ' + backup);
console.log('  ⚠ wheel.json 要在 /var/www/chatnest/wheel.json');
console.log('     自动部署只拷 index.html，别的都不拷 —— 这个文件得自己放：');
console.log('     apply-all.sh 会管；单独跑这个补丁的话自己 curl 一份过去。');
console.log('  重启: sudo pm2 restart chatnest-api');
