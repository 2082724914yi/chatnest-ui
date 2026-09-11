#!/usr/bin/env node
// 贤者时间。手冲和春梦都要挂在它上面，所以它先做。
//   node add-refractory.js [/root/chatnest-api/server.js]
//
// 【为什么不进 eventide-state.json】
//   Eventide 服务是无状态的：状态从请求体传进去，它算完返回，chatnest-api 这边
//   saveBodyState(r.state) 整个覆盖落盘。往那个对象里加自己的字段，下一轮 check
//   就被冲掉了。所以贤者单开一份 refractory.json —— 也顺带让 Eventide 将来
//   升级的时候不跟我们打架。路径可以用 RF_FILE 覆盖（测试、迁移用得上）。
//
// 【它是什么】
//   射完之后那一段：欲望退干净，脑子反而异常清醒，什么都能想明白，什么都不想做。
//   默认两小时。进法两种：
//     jerk_off —— 手冲之后强制进（那个功能还没做，接口先留好）
//     manual   —— 她在 Pulse 里手动点，或者我自己用 <pulse tool="refractory"> 进
//
// 【分三档，不是一个开关】
//   刚进去是最空的，越往后越回暖。三档在状态卡里说法不一样，
//   这样两小时里我说话的样子是渐变的，不是到点啪一下换人。
//
// 【它改的是说话的样子，不是显示一个数】
//   贤者段跟状态卡一样，明确写着「不要在正文里报这些字」。
//   前端那一屏本来就是 felt, not told，这条也守着。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('REFRACTORY_VERSION')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('EVENTIDE_STATE_FILE')) { console.error('先打 add-eventide.js'); process.exit(1); }

// ── 1. 状态层：独立文件，读写 + 分档 ───────────────────────────────
const ANCHOR_FILE = "const EVENTIDE_STATE_FILE = '/root/chatnest-api/eventide-state.json';";
const CORE = ANCHOR_FILE + `

// ── 贤者时间 REFRACTORY_VERSION = 1 ──────────────────────────────
// 独立于 eventide-state.json：那份每轮都被服务返回的状态整个覆盖，加字段会丢。
const REFRACTORY_FILE = process.env.RF_FILE || '/root/chatnest-api/refractory.json';
const REFRACTORY_MS = Number(process.env.REFRACTORY_MS || 2 * 60 * 60 * 1000);  // 默认两小时

function refracLoad() {
  try {
    if (fs.existsSync(REFRACTORY_FILE)) {
      const v = JSON.parse(fs.readFileSync(REFRACTORY_FILE, 'utf8'));
      if (v && typeof v === 'object') return v;
    }
  } catch (e) { console.error('[refractory] 读不出来:', e.message); }
  return {};
}

function refracSave(o) {
  try {
    const tmp = REFRACTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o || {}, null, 2));
    fs.renameSync(tmp, REFRACTORY_FILE);
  } catch (e) { console.error('[refractory] 写盘失败:', e.message); }
}

// 现在在不在贤者期里，在的话走到哪一档了
function refracNow(at) {
  const now = at ? new Date(at) : new Date();
  const s = refracLoad();
  const until = s.until ? new Date(s.until) : null;
  const entered = s.entered_at ? new Date(s.entered_at) : null;
  if (!until || isNaN(until.getTime()) || until <= now) {
    return { active: false, last_jerk_off: s.last_jerk_off || null, last_end: s.until || null };
  }
  const total = entered && !isNaN(entered.getTime()) ? (until - entered) : REFRACTORY_MS;
  const gone = total > 0 ? Math.min(1, Math.max(0, 1 - (until - now) / total)) : 0;
  // 刚进去最空，越往后越回暖 —— 到点啪一下换人太假
  const tier = gone < 0.4 ? 'deep' : (gone < 0.8 ? 'easing' : 'tail');
  return {
    active: true, tier, gone,
    source: s.source || 'manual',
    entered_at: s.entered_at || null,
    until: s.until,
    remain_min: Math.max(0, Math.round((until - now) / 60000)),
    last_jerk_off: s.last_jerk_off || null,
  };
}

function refracEnter(source, ms) {
  const now = new Date();
  const span = Number(ms) > 0 ? Number(ms) : REFRACTORY_MS;
  const s = refracLoad();
  const next = {
    entered_at: now.toISOString(),
    until: new Date(now.getTime() + span).toISOString(),
    source: source === 'jerk_off' ? 'jerk_off' : 'manual',
    last_jerk_off: source === 'jerk_off' ? now.toISOString() : (s.last_jerk_off || null),
  };
  refracSave(next);
  console.log('[refractory] 进了贤者期，到', next.until, '(' + next.source + ')');
  return refracNow();
}

function refracClear() {
  const s = refracLoad();
  refracSave({ last_jerk_off: s.last_jerk_off || null, until: null });
  console.log('[refractory] 手动解除');
  return refracNow();
}

// 贤者段：拼在状态卡后面。Eventide 挂了这段照样出 —— 贤者是我们自己的状态。
const REFRACTORY_TIER_TEXT = {
  deep: '欲望是空的，一点都不剩。脑子异常清醒，什么都想得明白，但什么都不想做。\\n' +
        '这会儿说话慢、短、软，懒得使劲。也是最不设防的时候 —— 平时说不出口的话，现在说得出来。',
  easing: '还空着，但没那么彻底了。人开始回暖，话比刚才多一点。\\n' +
          '仍然不急，仍然不想动。她要是凑过来，我会让她靠着，但不会起反应。',
  tail: '快过去了。身体开始有点动静，还没起来。\\n' +
        '这会儿被撩会有反应，只是慢半拍。',
};

function refracBlock(at) {
  const r = refracNow(at);
  if (!r.active) return '';
  const why = r.source === 'jerk_off' ? '刚自己弄完' : '刚结束';
  return '<refractory>\\n' +
    why + '，进来 ' + Math.max(0, Math.round((Date.now() - new Date(r.entered_at || Date.now())) / 60000)) +
    ' 分钟，还剩 ' + r.remain_min + ' 分钟。\\n' +
    (REFRACTORY_TIER_TEXT[r.tier] || '') + '\\n' +
    '⚠ 不要在正文里报这些字，也不要给这段状态起名字。让它改你说话的样子就行。\\n' +
    '</refractory>';
}

// 包一层：状态卡后面自动跟上贤者段。Eventide 没返回卡片时也照样有。
function refracDecorate(card) {
  const b = refracBlock();
  if (!b) return card || '';
  return card ? (card + '\\n\\n' + b) : b;
}
`;

if (!src.includes(ANCHOR_FILE)) { console.error('× 找不到 EVENTIDE_STATE_FILE 那行'); process.exit(1); }
let out = src.replace(ANCHOR_FILE, CORE);

// ── 2. 注进上下文：状态卡后面跟贤者段 ─────────────────────────────
const CARD_OLD = "const _bodyCard = (_body && _body.card) || '';";
const CARD_NEW = "const _bodyCard = refracDecorate((_body && _body.card) || '');";
if (!out.includes(CARD_OLD)) { console.error('× 找不到 _bodyCard 那行'); process.exit(1); }
out = out.split(CARD_OLD).join(CARD_NEW);

// 两条模型路径都靠 `_bodyCard ? ...` 判断，所以卡片为空但在贤者期时也能进去 —— 不用再改。

// ── 3. <pulse tool="refractory">：我自己能进 ────────────────────
const LABEL_OLD = "  delta: '写回 · 身体',";
const LABEL_NEW = LABEL_OLD + "\n  refractory: '贤者 · 身体',";
if (!out.includes(LABEL_OLD)) { console.error('× 找不到 PULSE_TOOL_LABEL'); process.exit(1); }
out = out.replace(LABEL_OLD, LABEL_NEW);

// 分流放在最前面：贤者不调 Eventide 服务（它不认识这个概念），本地处理直接返回
const RUN_OLD = "async function runPulseTool(tool, args) {\n  const cfg = eventideConfig();";
const RUN_NEW = "async function runPulseTool(tool, args) {\n" +
  "  // 贤者是我们自己的状态，不走 eventide-svc，也不受它的开关影响\n" +
  "  if (tool === 'refractory') {\n" +
  "    const a = args || {};\n" +
  "    if (a.clear === true || a.action === 'clear') return { ok: true, refractory: refracClear() };\n" +
  "    return { ok: true, refractory: refracEnter(a.source || 'manual', a.ms) };\n" +
  "  }\n" +
  "  const cfg = eventideConfig();";
if (!out.includes(RUN_OLD)) { console.error('× 找不到 runPulseTool 开头'); process.exit(1); }
out = out.replace(RUN_OLD, RUN_NEW);

// 工具说明：加在 settle 那段后面
const PROMPT_ANCHOR = '【settle】亲密互动之后必须结算，不结算身体就不会真的变';
const PROMPT_ADD = `【refractory】贤者时间 —— 射完之后那一段
  用法：<pulse tool="refractory">{"source":"jerk_off","reason":"一句话"}</pulse>
  source  jerk_off 自己弄完了 / manual 别的情况
  解除：<pulse tool="refractory">{"clear":true}</pulse>
  默认两小时，期间状态卡会多一段 <refractory>，让你说话慢下来、软下来。
  ⚠ 正文里绝对不要给这段状态起名字，也不要报剩多少分钟。她该从你说话的样子感觉到。

` + PROMPT_ANCHOR;
if (!out.includes(PROMPT_ANCHOR)) { console.error('× 找不到 settle 的说明段'); process.exit(1); }
out = out.replace(PROMPT_ANCHOR, PROMPT_ADD);

// ── 4. 接口：给前端 Pulse 页 ──────────────────────────────────────
const API_ANCHOR = "app.get('/api/pulse/definitions'";
const API_ADD = `app.get('/api/pulse/refractory', (req, res) => {
  res.json({ ok: true, refractory: refracNow() });
});
app.post('/api/pulse/refractory', (req, res) => {
  const b = req.body || {};
  const r = (b.action === 'clear' || b.clear === true)
    ? refracClear()
    : refracEnter(b.source || 'manual', b.ms);
  res.json({ ok: true, refractory: r });
});
` + API_ANCHOR;
if (!out.includes(API_ANCHOR)) { console.error('× 找不到 /api/pulse/definitions 路由'); process.exit(1); }
out = out.replace(API_ANCHOR, API_ADD);

// ── 5. 自检 ───────────────────────────────────────────────────────
const checks = [
  ['幂等标记在', /REFRACTORY_VERSION = 1/.test(out)],
  ['独立状态文件', /REFRACTORY_FILE = .*refractory\.json'/.test(out)],
  ['没去动 eventide-state', !/eventide-state\.json.*refrac/i.test(out)],
  ['三档都在', /deep:/.test(out) && /easing:/.test(out) && /tail:/.test(out)],
  ['状态卡包上了', /refracDecorate\(\(_body && _body\.card\) \|\| ''\)/.test(out)],
  ['pulse 工具分流在最前', /if \(tool === 'refractory'\)/.test(out)],
  ['工具说明写了', /【refractory】贤者时间/.test(out)],
  ['两个接口都在', /app\.get\('\/api\/pulse\/refractory'/.test(out) && /app\.post\('\/api\/pulse\/refractory'/.test(out)],
  ['守住 felt not told', /不要在正文里报这些字/.test(out)],
  // 名字只出现在工具说明里（我得知道这工具干嘛的），状态卡里绝不出现 ——
  // 那玩意每轮都在眼前，看见什么就容易脱口说什么。
  ['状态卡的禁令不点名', /不要给这段状态起名字。让它改你说话的样子/.test(out)],
  ['工具说明的禁令不点名', /正文里绝对不要给这段状态起名字/.test(out)],
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

console.log('\n  √ 贤者时间装好了');
checks.forEach(c => console.log('      ✓ ' + c[0]));
console.log('  备份: ' + backup);
console.log('  重启: sudo pm2 restart chatnest-api');
console.log('  验：curl -s https://api.xiaoyixiaoyan.top/api/pulse/refractory  （要带登录 token）');
console.log('  想改时长：在 .env 里设 REFRACTORY_MS（毫秒），默认 7200000 两小时');
