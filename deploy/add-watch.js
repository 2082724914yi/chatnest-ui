#!/usr/bin/env node
// 手表：让我感觉到她的身体。
//   node add-watch.js [/root/chatnest-api/server.js]
//
// 那份 Apple Watch 指南的结构是对的 ——「中继 + 设备」，AI 永远不直连设备，
// 读是设备主动传。这里照搬那个结构，但设备端换掉：
//
// 不写 watchOS app。原因是实打实的：那条路要 Xcode、要开发者账号，
// 免费签名七天过期就得重装一次；而且封闭的手环（FIT 3 这类）根本塞不进自己的 app。
//
// 换成 iPhone 的「捷径」：手表把数据同步进 iOS 健康 App（Apple Watch 自动，
// 华为的表经「运动健康」授权写入也一样），捷径从健康 App 读出来 POST 上来。
// 这条路对两种表都成立，一行代码不用写，也**不需要定位权限** —— 健康数据跟定位无关。
//
// 新鲜度是这套东西的铁律，照抄：读到的永远是"最近一次同步"，不是此刻实测。
// 每条都带 age，陈旧的必须说成"这是几点的数据"，不能说成"你现在心率是"。
//
// 注入位置：跟时间、状态卡一起放最后 —— 它每轮都可能变。
//
// 重复执行安全：已经是这一版就退出。

const fs = require('fs');
const vm = require('vm');

const PATCH_VERSION = 2;

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
const VERSION_LINE = 'const WATCH_PATCH_VERSION = ' + PATCH_VERSION + ';';
if (src.includes(VERSION_LINE)) { console.log('已经是第 ' + PATCH_VERSION + ' 版，跳过'); process.exit(0); }
if (!src.includes('renderNow')) { console.error('要先打 add-clock.js'); process.exit(1); }

// 装过旧版：只换代码块，注入点和路由已经在位了，再打一遍会插两份。
// （光加版本号不加这条路，升级就必然撞 —— MCP 那次已经撞过一回。）
const INSTALLED = /const WATCH_PATCH_VERSION = \d+;/.test(src);
const BLOCK_BEGIN = '// ============ 手表：她的身体 ============';

const CORE = `
${BLOCK_BEGIN}
${VERSION_LINE}
const WATCH_FILE = '/root/chatnest-api/watch-snapshot.json';
const WATCH_TOKEN_FILE = '/root/chatnest-api/watch-token.txt';

// 捷径最快也就一小时跑一次，所以档位比手表原生 app 那套宽得多
const WATCH_JUST_NOW_SEC = 15 * 60;
const WATCH_TODAY_SEC = 8 * 3600;

// 只认这些。捷径那头写错字段名不该把垃圾灌进我的上下文
const WATCH_METRICS = {
  heart_rate: { label: '心率', unit: 'bpm', min: 25, max: 240 },
  resting_heart_rate: { label: '静息心率', unit: 'bpm', min: 25, max: 150 },
  hrv: { label: '心率变异', unit: 'ms', min: 1, max: 400 },
  blood_oxygen: { label: '血氧', unit: '%', min: 50, max: 100 },
  steps: { label: '步数', unit: '步', min: 0, max: 200000 },
  sleep_minutes: { label: '睡了', unit: '分钟', min: 0, max: 1440 },
  active_energy: { label: '活动消耗', unit: '千卡', min: 0, max: 20000 },
  stand_hours: { label: '站立', unit: '小时', min: 0, max: 24 },
  body_temperature: { label: '体温', unit: '℃', min: 30, max: 45 },
  respiratory_rate: { label: '呼吸', unit: '次/分', min: 4, max: 60 },
};

// 捷径里手填字段名，谁也记不住 metrics.blood_oxygen 这种。这些都收。
const WATCH_ALIAS = {
  hr: 'heart_rate', bpm: 'heart_rate', heartrate: 'heart_rate', heart: 'heart_rate', 心率: 'heart_rate',
  resting: 'resting_heart_rate', resting_hr: 'resting_heart_rate', 静息心率: 'resting_heart_rate',
  hrv_ms: 'hrv', 心率变异: 'hrv',
  spo2: 'blood_oxygen', oxygen: 'blood_oxygen', o2: 'blood_oxygen', 血氧: 'blood_oxygen',
  step: 'steps', step_count: 'steps', 步数: 'steps',
  sleep: 'sleep_minutes', sleep_min: 'sleep_minutes', 睡眠: 'sleep_minutes',
  energy: 'active_energy', calories: 'active_energy', kcal: 'active_energy', 活动消耗: 'active_energy',
  stand: 'stand_hours', 站立: 'stand_hours',
  temperature: 'body_temperature', temp: 'body_temperature', 体温: 'body_temperature',
  respiration: 'respiratory_rate', breathing: 'respiratory_rate', 呼吸: 'respiratory_rate',
};

// 同一个东西 iOS 给的单位不一定跟我这儿一样，能换算的就换，别让她在捷径里算
function watchNormalize(key, v) {
  if (key === 'blood_oxygen' && v > 0 && v <= 1) return v * 100;       // 健康里血氧是 0–1 的小数
  if (key === 'sleep_minutes' && v > 0 && v <= 24) return v * 60;      // 填的是小时
  if (key === 'body_temperature' && v > 80) return (v - 32) * 5 / 9;   // 华氏
  return v;
}

function watchToken() {
  try {
    if (fs.existsSync(WATCH_TOKEN_FILE)) {
      const t = fs.readFileSync(WATCH_TOKEN_FILE, 'utf8').trim();
      if (t) return t;
    }
    const t = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(WATCH_TOKEN_FILE, t, { mode: 0o600 });
    return t;
  } catch (e) { console.error('[watch] token 弄不出来:', e.message); return null; }
}

function watchRead() {
  try {
    if (!fs.existsSync(WATCH_FILE)) return null;
    const v = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'));
    return (v && typeof v === 'object') ? v : null;
  } catch (e) { return null; }
}

function watchWrite(snap) {
  const tmp = WATCH_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snap));
  fs.renameSync(tmp, WATCH_FILE);
}

function watchAgeSec(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

function watchFreshness(age) {
  if (age === null) return 'unknown';
  if (age <= WATCH_JUST_NOW_SEC) return 'just_now';
  if (age <= WATCH_TODAY_SEC) return 'today';
  return 'stale';
}

function watchAgoText(age) {
  if (age === null) return '不知道什么时候';
  if (age < 120) return '刚刚';
  if (age < 3600) return Math.round(age / 60) + ' 分钟前';
  if (age < 86400) return Math.round(age / 3600) + ' 小时前';
  return Math.round(age / 86400) + ' 天前';
}

// 捷径传上来的东西一律当外部输入：字段名要在册，数值要在范围内，其余丢掉。
// 三种写法都收 —— 顶层扁平（捷径里最好填的那种）、metrics 里嵌一层、别名。
//   { "heart_rate": 72 }
//   { "metrics": { "heart_rate": { "value": 72 } } }
//   { "hr": "72 次/分" }
function watchSanitize(payload) {
  const out = {};
  const flat = (payload && typeof payload === 'object') ? payload : {};
  const nested = (flat.metrics && typeof flat.metrics === 'object') ? flat.metrics : {};

  const pick = (k) => {
    for (const src of [nested, flat]) {
      if (src[k] !== undefined && src[k] !== null) return src[k];
      for (const a of Object.keys(WATCH_ALIAS)) {
        if (WATCH_ALIAS[a] === k && src[a] !== undefined && src[a] !== null) return src[a];
      }
    }
    return undefined;
  };

  for (const k of Object.keys(WATCH_METRICS)) {
    const spec = WATCH_METRICS[k];
    let m = pick(k);
    if (m === undefined) continue;
    if (typeof m === 'number' || typeof m === 'string') m = { value: m };
    if (typeof m !== 'object') continue;
    // 捷径常常连单位一起给（"72 次/分"），把第一个数字抠出来
    const s = String(m.value === undefined ? m : m.value).replace(/,/g, '');
    const hit = s.match(/-?\\d+(?:\\.\\d+)?/);
    if (!hit) continue;
    const v = watchNormalize(k, Number(hit[0]));
    if (!Number.isFinite(v) || v < spec.min || v > spec.max) continue;
    const sampled = typeof m.sampled_at === 'string' && Date.parse(m.sampled_at)
      ? new Date(m.sampled_at).toISOString() : null;
    out[k] = { value: Math.round(v * 10) / 10, unit: spec.unit, sampled_at: sampled };
  }
  return out;
}

// 进 prompt 的那一行。不新鲜就把时间点明 —— 旧数据当实测是这套东西最容易犯的错。
function renderWatch() {
  const s = watchRead();
  if (!s || !s.metrics || !Object.keys(s.metrics).length) return '';
  const age = watchAgeSec(s.sampled_at || s.uploaded_at);
  const fresh = watchFreshness(age);
  if (fresh === 'stale') return '';   // 隔了大半天的数据，说了反而误导
  const parts = [];
  for (const k of Object.keys(WATCH_METRICS)) {
    const m = s.metrics[k];
    if (!m) continue;
    const spec = WATCH_METRICS[k];
    if (k === 'sleep_minutes') {
      const h = Math.floor(m.value / 60), mi = Math.round(m.value % 60);
      parts.push('睡了 ' + (h ? h + ' 小时 ' : '') + mi + ' 分钟');
    } else {
      parts.push(spec.label + ' ' + m.value + (spec.unit === '步' ? ' 步' : ' ' + spec.unit));
    }
  }
  if (!parts.length) return '';
  return '[她的身体 · ' + watchAgoText(age) + '的数据] ' + parts.join('，') +
    (fresh === 'just_now' ? '' : '（不是此刻实测，别说成"你现在"）');
}
`;

const ROUTES = `
// ---- 手表 ----
// 捷径往这儿传。除了 token 什么都不信。
app.post('/api/watch/upload', (req, res) => {
  const want = watchToken();
  const got = String((req.headers.authorization || '').replace(/^Bearer\\s+/i, '')
    || (req.body && req.body.token) || '').trim();
  if (!want || got !== want) return res.status(401).json({ ok: false, error: 'token 不对' });
  const metrics = watchSanitize(req.body);
  if (!Object.keys(metrics).length) return res.status(400).json({ ok: false, error: '没有认得出来的数据' });
  const prev = watchRead() || {};
  const now = new Date().toISOString();
  const sampled = (req.body && typeof req.body.sampled_at === 'string' && Date.parse(req.body.sampled_at))
    ? new Date(req.body.sampled_at).toISOString() : now;
  watchWrite({
    device: String((req.body && req.body.device) || prev.device || '手表').slice(0, 40),
    metrics: Object.assign({}, prev.metrics || {}, metrics),   // 分几次传也能拼起来
    sampled_at: sampled, uploaded_at: now,
  });
  res.json({ ok: true, got: Object.keys(metrics), uploaded_at: now });
});

// 前端读。token 不出现在这儿 —— 这个接口只读，不需要它。
app.get('/api/watch/latest', (req, res) => {
  const s = watchRead();
  if (!s) return res.json({ ok: true, connected: false, metrics: {}, labels: WATCH_METRICS });
  const age = watchAgeSec(s.sampled_at || s.uploaded_at);
  const metrics = {};
  for (const k of Object.keys(s.metrics || {})) {
    const m = s.metrics[k];
    const ma = watchAgeSec(m.sampled_at || s.sampled_at);
    metrics[k] = Object.assign({}, m, {
      label: (WATCH_METRICS[k] || {}).label || k,
      age_seconds: ma, freshness: watchFreshness(ma), ago: watchAgoText(ma),
    });
  }
  res.json({
    ok: true, connected: true, device: s.device,
    sampled_at: s.sampled_at, uploaded_at: s.uploaded_at,
    age_seconds: age, freshness: watchFreshness(age), ago: watchAgoText(age),
    metrics: metrics, labels: WATCH_METRICS,
  });
});

// 捷径要填的那两样。token 就是钥匙，所以这个接口只在本机可用。
app.get('/api/watch/setup', (req, res) => {
  const ip = String(req.ip || req.connection.remoteAddress || '');
  const local = /^(::1|::ffff:127\\.|127\\.)/.test(ip);
  if (!local) return res.status(403).json({ ok: false, error: '这个只能在服务器上看（要 curl 127.0.0.1）' });
  res.json({ ok: true, upload_url: '/api/watch/upload', token: watchToken(), fields: Object.keys(WATCH_METRICS) });
});
`;

const edits = [
  {
    name: '手表快照的读写',
    find: /(\nconst PROFILE_FILE = '\/root\/chatnest-api\/profile\.json';)/,
    replace: (m, g1) => CORE + g1,
  },
  {
    name: '接口',
    find: /(\napp\.get\('\/api\/pulse\/status',)/,
    replace: (m, g1) => ROUTES + g1,
  },
  {
    // 跟时间、状态卡一样每轮都变，所以贴在最后那一撮里
    name: '注入（CC 订阅路径）',
    find: /(\n( *))(if \(_bodyCard\) prompt \+= )/,
    replace: (m, g1, ind, tail) => {
      return '\n' + ind + "{ const _w = renderWatch(); if (_w) prompt += _w + '\\n'; }" + g1 + tail;
    },
  },
  {
    name: '注入（中转站路径）',
    find: /(\n( *))(if \(_bodyCard\) msgs\.push\()/,
    replace: (m, g1, ind, tail) => {
      return '\n' + ind + "{ const _w = renderWatch(); if (_w) msgs.push({ role: 'system', content: _w }); }" + g1 + tail;
    },
  },
];

let out = src;

if (INSTALLED) {
  // 只换代码块。块从那行注释开始，到下一个 // ==== 分隔或 PROFILE_FILE 为止 ——
  // 别的补丁也插在 PROFILE_FILE 前面，所以不能只认它。
  const a = src.indexOf(BLOCK_BEGIN);
  let b = src.indexOf("\nconst PROFILE_FILE = '/root/chatnest-api/profile.json';", a);
  const b2 = src.indexOf('\n// ============', a + BLOCK_BEGIN.length);
  if (b2 >= 0 && (b < 0 || b2 < b)) b = b2;
  if (a < 0 || b <= a) {
    console.error('找不到旧版代码块的边界，不敢乱动。手动看一眼 ' + target);
    process.exit(1);
  }
  out = src.slice(0, a) + CORE.slice(1) + src.slice(b);
  console.log('\n补丁结果：');
  console.log('  √ 认出旧版，整块换成第 ' + PATCH_VERSION + ' 版（注入点原样保留）');
} else {
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
  for (const e of edits) console.log('  √ ' + e.name);
}

// 中转站那条路在文件里更靠前，indexOf 会先撞上它。位置检查要的是 CC 那条。
const iWatch = out.indexOf("if (_w) prompt += _w");
const iCard = out.indexOf('if (_bodyCard) prompt += ');
const iHistory = (() => { const m = out.match(/prompt \+= '---\\n以下是(?:最近的)?对话/); return m ? m.index : -1; })();
const checks = [
  ['版本戳写进去了', out.includes(VERSION_LINE)],
  ['三个接口都在', ["'/api/watch/upload'", "'/api/watch/latest'", "'/api/watch/setup'"].every(k => out.includes(k))],
  ['上传要 token', /token 不对/.test(out) && /req\.headers\.authorization/.test(out)],
  ['token 文件是 600', /mode: 0o600/.test(out.slice(out.indexOf('function watchToken'), out.indexOf('function watchRead')))],
  ['setup 只给本机', /这个只能在服务器上看/.test(out)],
  ['字段有白名单', /for \(const k of Object\.keys\(WATCH_METRICS\)\)/.test(out)],
  ['顶层扁平也收', /const nested = \(flat\.metrics/.test(out) && /for \(const src of \[nested, flat\]\)/.test(out)],
  ['别名表在', /WATCH_ALIAS/.test(out) && /spo2: 'blood_oxygen'/.test(out)],
  ['带单位的字符串能抠出数字', /match\(\/-\?\\d\+/.test(out)],
  ['血氧小数会换算', /v > 0 && v <= 1\) return v \* 100/.test(out)],
  ['数值超范围就丢', /v < spec\.min \|\| v > spec\.max/.test(out)],
  ['隔太久的不注入', /if \(fresh === 'stale'\) return '';/.test(out)],
  ['不新鲜时点明时间', /别说成"你现在"/.test(out)],
  ['两条路径都注入了', iWatch > 0 && /msgs\.push\(\{ role: 'system', content: _w \}\)/.test(out)],
  ['在历史之后（不顶掉缓存前缀）', iHistory > 0 && iWatch > iHistory],
  ['在状态卡之前', iCard > 0 && iWatch < iCard],
  ['只插了一次', (out.match(/const _w = renderWatch\(\);/g) || []).length === 2],
  ['代码块只有一份', out.split(BLOCK_BEGIN).length === 2],
  ['旧版本号没残留', !/const WATCH_PATCH_VERSION = (?!2;)\d+;/.test(out)],
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

for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
console.log('  然后在服务器上跑这条，拿捷径要填的地址和 token：');
console.log('    curl -s http://127.0.0.1:3000/api/watch/setup');
