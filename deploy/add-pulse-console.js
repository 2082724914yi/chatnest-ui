#!/usr/bin/env node
// Pulse 页要能真的操作身体系统，不只是看。
//   node add-pulse-console.js [/root/chatnest-api/server.js]
//
// 现在 Pulse 页只有四块只读内容，Eventide 跑着的东西她基本看不到也动不了：
//   · 事件流只有「事件」一类 —— 周期换了、结算过了、做过梦，都没记进去
//   · 三个开关（身体系统 / 插上下文 / 结算模型）只能改配置文件
//   · 数值只能从 /api/pulse/debug 那条调试路径看
//   · 数值偏了没有办法校准
//
// 加的是这些：
//   GET  /api/pulse/journal    合并后的完整日志（事件 + 周期 + 结算 + 梦），按时间倒序
//   GET  /api/pulse/settings   三个开关的当前值
//   POST /api/pulse/settings   改开关
//   POST /api/pulse/calibrate  把某几项设成指定值（内部换算成增量走 /delta）
//   /api/pulse 顺带返回 values —— 「不报数值」是我在聊天里的规矩，不是她界面上的
//
// 日志记在 server.js 这一侧（runPulseTool 是所有写回的唯一入口），
// 不动 Python 服务 —— 那边改一次她就得重装一次。
//
// 重复执行安全：已经是这一版就退出。

const fs = require('fs');
const vm = require('vm');

const PATCH_VERSION = 1;

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
const VERSION_LINE = 'const PULSE_CONSOLE_VERSION = ' + PATCH_VERSION + ';';
if (src.includes(VERSION_LINE)) { console.log('已经是第 ' + PATCH_VERSION + ' 版，跳过'); process.exit(0); }
if (!src.includes('runPulseTool')) { console.error('要先打 add-eventide.js'); process.exit(1); }

const CORE = `
// ============ Pulse 控制台：日志 / 开关 / 校准 ============
${VERSION_LINE}
const PULSE_JOURNAL_FILE = '/root/chatnest-api/pulse-journal.json';
const PULSE_JOURNAL_MAX = 300;

function pulseJournalRead() {
  try {
    if (!fs.existsSync(PULSE_JOURNAL_FILE)) return [];
    const v = JSON.parse(fs.readFileSync(PULSE_JOURNAL_FILE, 'utf8'));
    return Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [];
  } catch (e) {
    console.error('[pulse] 日志读不出来，当空的:', e.message);
    return [];
  }
}

// 写坏一次日志不值得让这一轮聊天挂掉，所以全程吞异常
function pulseJournalAdd(entry) {
  try {
    const list = pulseJournalRead();
    list.push(Object.assign({ id: uid(), at: new Date().toISOString() }, entry));
    const tmp = PULSE_JOURNAL_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list.slice(-PULSE_JOURNAL_MAX), null, 0));
    fs.renameSync(tmp, PULSE_JOURNAL_FILE);
  } catch (e) { console.error('[pulse] 日志写不进去:', e.message); }
}

const PULSE_FIELD_LABEL = {
  heat: '热度', pressure: '压抑感', control: '控制力', sensitivity: '敏感度',
  reserve: '蓄积感', possessiveness: '占有欲', fatigue: '疲惫感',
};

// 只留真的动了的项，0 不显示 —— 一排 0 看不出发生了什么
function pulseDeltaText(delta) {
  const parts = [];
  for (const k of Object.keys(PULSE_FIELD_LABEL)) {
    const v = Number((delta || {})[k] || 0);
    if (!v) continue;
    parts.push(PULSE_FIELD_LABEL[k] + ' ' + (v > 0 ? '+' : '') + v);
  }
  return parts.length ? parts.join('，') : '没有变化';
}

// runPulseTool 每次写回都过这儿。tool 已经区分了四种写回，直接映射成日志类别。
function pulseRecordWrite(tool, args, r) {
  try {
    const applied = (r && (r.applied || r.deltas_applied || r.delta)) || null;
    if (tool === 'settle') {
      pulseJournalAdd({
        kind: 'settlement', title: '互动结算',
        note: (args && args.settlement_reason) || '',
        result: (args && args.settlement_result) || '',
        delta: applied || pulseSettleDeltaFromArgs(args),
      });
    } else if (tool === 'cycle') {
      const c = (r && r.cycle) || {};
      pulseJournalAdd({
        kind: 'cycle', title: '进入' + (c.label || c.key || '新周期'),
        note: (args && args.reason) || '', cycle_key: c.key || null,
      });
    } else if (tool === 'delta') {
      // 手动校准和我自己调的变化都走这条，用 reason 当标题才分得出来
      pulseJournalAdd({
        kind: 'delta', title: (args && args.reason) || '身体变化',
        delta: applied || (args && args.deltas) || null,
      });
    }
    // event 那一类 Eventide 自己已经记进 event_log 了，这儿再记就重了
  } catch (e) { console.error('[pulse] 记日志失败:', e.message); }
}

// settle 的返回里不一定带 applied，退回用请求里的 *_delta 凑一份
function pulseSettleDeltaFromArgs(args) {
  const out = {};
  for (const k of Object.keys(PULSE_FIELD_LABEL)) {
    const v = Number((args || {})[k + '_delta']);
    if (Number.isFinite(v) && v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function pulseSaveConfig(next) {
  const tmp = EVENTIDE_CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, EVENTIDE_CONFIG_FILE);
}
`;

const ROUTES = `
// ---- Pulse 控制台接口 ----

// 完整日志：Eventide 记的事件 + 我们记的周期/结算/变化，一起按时间倒序
app.get('/api/pulse/journal', async (req, res) => {
  const cfg = eventideConfig();
  const rows = pulseJournalRead().slice();
  try {
    const r = await eventideCall('/view', {
      state: loadBodyState(), now: new Date().toISOString(), settings: cfg.settings,
    }, 5000);
    for (const e of ((r && r.event_log) || [])) {
      if (!e || !e.started_at) continue;
      rows.push({
        id: 'ev-' + e.event_key + '-' + e.started_at,
        kind: 'event', at: e.started_at,
        title: '触发' + (e.label || e.event_key),
        note: e.trigger_reason || '', event_key: e.event_key,
        expires_at: e.expires_at || null, cycle_key: e.cycle_key || null,
        snapshot: e.state_snapshot || null,
      });
    }
  } catch (e) { /* 服务没响应就只给本地那份，不整个失败 */ }
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  res.json({ ok: true, rows: rows.slice(0, 200), field_labels: PULSE_FIELD_LABEL });
});

app.get('/api/pulse/settings', (req, res) => {
  const cfg = eventideConfig();
  res.json({ ok: true, enabled: cfg.enabled, settings: cfg.settings });
});

app.post('/api/pulse/settings', (req, res) => {
  try {
    const cfg = eventideConfig();
    const b = req.body || {};
    const next = { enabled: cfg.enabled, settings: Object.assign({}, cfg.settings) };
    if (typeof b.enabled === 'boolean') next.enabled = b.enabled;
    const s = b.settings || {};
    for (const k of ['body_cycle_enabled', 'inject_body_state_context', 'adult_private_mode_enabled']) {
      if (typeof s[k] === 'boolean') next.settings[k] = s[k];
    }
    if (typeof s.safeword === 'string') next.settings.safeword = s.safeword.slice(0, 60);
    const m = Number(s.event_probability_multiplier);
    if (Number.isFinite(m)) next.settings.event_probability_multiplier = Math.max(0, Math.min(3, m));
    pulseSaveConfig(next);
    res.json({ ok: true, enabled: next.enabled, settings: next.settings });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 校准：她给的是目标值，Eventide 那边只收增量，这里换算
app.post('/api/pulse/calibrate', async (req, res) => {
  const state = loadBodyState();
  if (!state) return res.status(503).json({ ok: false, error: '身体状态还没建立' });
  const want = (req.body && req.body.values) || {};
  const deltas = {};
  for (const k of Object.keys(PULSE_FIELD_LABEL)) {
    if (want[k] === undefined || want[k] === null || want[k] === '') continue;
    const v = Number(want[k]);
    if (!Number.isFinite(v)) continue;
    const d = Math.round(Math.max(0, Math.min(100, v))) - Number((state.values || {})[k] || 0);
    if (d) deltas[k] = d;
  }
  if (!Object.keys(deltas).length) return res.json({ ok: true, changed: false, values: state.values || {} });
  const r = await runPulseTool('delta', { deltas: deltas, reason: '手动校准' });
  if (!r || r.error) return res.status(503).json({ ok: false, error: (r && r.error) || '失败' });
  res.json({ ok: true, changed: true, values: (r.state && r.state.values) || {} });
});
`;

const edits = [
  {
    name: '日志与配置读写',
    find: /(\nconst PROFILE_FILE = '\/root\/chatnest-api\/profile\.json';)/,
    replace: (m, g1) => CORE + g1,
  },
  {
    // runPulseTool 是所有写回的唯一出口，挂在这里一处顶四处
    name: '写回时记一条日志',
    find: /(\n  const r = await eventideCall\(path, body, 8000\);\n  if \(!r\) return \{ error: '身体服务没响应' \};\n)(  saveBodyState\(r\.state\);)/,
    replace: (m, head, tail) => head + '  pulseRecordWrite(tool, args, r);\n' + tail,
  },
  {
    name: '身体页给出数值',
    find: /(\n    body: stripPulseNumbers\(r\.payload\),)/,
    replace: (m, g1) => g1 + '\n    values: (r.state && r.state.values) || {},',
  },
  {
    name: '控制台接口',
    find: /(\napp\.get\('\/api\/pulse\/status',)/,
    replace: (m, g1) => ROUTES + g1,
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
  for (const e of edits) console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 没匹配上' : '  √ ' + e.name);
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['版本戳写进去了', out.includes(VERSION_LINE)],
  ['四个接口都在', ['journal', 'settings', 'calibrate'].every(k => out.includes("'/api/pulse/" + k + "'"))
    && (out.match(/app\.(get|post)\('\/api\/pulse\/settings'/g) || []).length === 2],
  // 只数调用，别把上面那行函数定义也数进来
  ['写回挂钩只挂了一次', (out.match(/^ {2}pulseRecordWrite\(tool, args, r\);$/gm) || []).length === 1],
  ['挂钩在存状态之前', out.indexOf('pulseRecordWrite(tool, args, r)') < out.indexOf('saveBodyState(r.state);\n  return r;')],
  ['校准值被夹在 0-100', /Math\.max\(0, Math\.min\(100, v\)\)/.test(out)],
  ['开关只认这几个字段', /'body_cycle_enabled', 'inject_body_state_context', 'adult_private_mode_enabled'/.test(out)],
  ['日志写失败不影响聊天', /\[pulse\] 日志写不进去/.test(out)],
  ['身体页带上了数值', /values: \(r\.state && r\.state\.values\) \|\| \{\},/.test(out)],
  ['原来的接口都还在', ['/api/pulse/debug', '/api/pulse/definitions', '/api/pulse/event', '/api/pulse/cycle', '/api/pulse/status']
    .every(k => out.includes("'" + k + "'"))],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

try {
  new vm.Script(out, { filename: target });
} catch (e) {
  console.error('  × 改完之后语法不对，放弃写入:', e.message);
  process.exit(1);
}

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

for (const e of edits) console.log('  √ ' + e.name);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
