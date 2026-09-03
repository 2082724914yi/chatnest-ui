#!/usr/bin/env node
// 把梦境接起来。
//   node add-pulse-dreams.js [/root/chatnest-api/server.js]
//
// Eventide 自带一整套梦境系统（梦种 → 触发判定 → 梦境卡 → 余波结算），
// 但 /dream/maybe 和 /dream/tags 从部署那天起就没人调过 —— 梦境一直是死的。
// （而且服务那边 _rng 把梦种当随机种子用，一调就 500。那个已经在 app.py 里修了，
//   要重跑一次 install-eventide.sh 才会生效。）
//
// 这里补上宿主该做的三件事：
//   1. 梦种存哪儿      她想让我梦到什么，存文件，能加能删能停用
//   2. 织梦            拿 Eventide 给的 trigger 提示词跑一次 CLI，写出梦境卡
//   3. 余波结算        梦完把 after_effect_tags 交回去，身体真的会变
//
// 自动触发：每 20 分钟看一眼。真正的门槛（时间窗 00:00–08:30、静默 120 分钟、
// 24 小时冷却、概率）全在 Eventide 那边判，这边只负责按时去问。
// 她自己按「织一个梦」走 force，把这些门槛跳过 —— 那些是给自动用的，
// 不该拦住她主动要的东西。
//
// 重复执行安全：已经是这一版就退出。

const fs = require('fs');
const vm = require('vm');

const PATCH_VERSION = 1;

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
const VERSION_LINE = 'const PULSE_DREAM_VERSION = ' + PATCH_VERSION + ';';
if (src.includes(VERSION_LINE)) { console.log('已经是第 ' + PATCH_VERSION + ' 版，跳过'); process.exit(0); }
if (!src.includes('pulseJournalAdd')) { console.error('要先打 add-pulse-console.js'); process.exit(1); }

const CORE = `
// ============ 梦 ============
${VERSION_LINE}
const PULSE_DREAM_FILE = '/root/chatnest-api/pulse-dreams.json';
const PULSE_DREAM_MAX_CARDS = 60;
const PULSE_DREAM_INTENSITIES = ['soft', 'medium', 'explicit'];
const PULSE_DREAM_TAGS = ['released', 'unfinished', 'aroused', 'possessive', 'tender'];

function pulseDreamRead() {
  try {
    if (!fs.existsSync(PULSE_DREAM_FILE)) return { seeds: [], cards: [] };
    const v = JSON.parse(fs.readFileSync(PULSE_DREAM_FILE, 'utf8'));
    return {
      seeds: Array.isArray(v && v.seeds) ? v.seeds.filter(x => x && x.id) : [],
      cards: Array.isArray(v && v.cards) ? v.cards.filter(x => x && x.id) : [],
    };
  } catch (e) {
    console.error('[dream] 读不出来，当空的:', e.message);
    return { seeds: [], cards: [] };
  }
}

function pulseDreamWrite(db) {
  const tmp = PULSE_DREAM_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({
    seeds: (db.seeds || []).slice(0, 60),
    cards: (db.cards || []).slice(-PULSE_DREAM_MAX_CARDS),
  }, null, 0));
  fs.renameSync(tmp, PULSE_DREAM_FILE);
}

// 她上一次说话是什么时候 —— 静默多久是做梦的主要门槛，得跨会话找最新的那条
function pulseLastUserAt() {
  let best = 0;
  for (const [, c] of conversations) {
    if (!c || !Array.isArray(c.history)) continue;
    for (let i = c.history.length - 1; i >= 0; i--) {
      const m = c.history[i];
      if (!m || m.role !== 'user' || !m.time) continue;
      const t = new Date(m.time).getTime();
      if (!isNaN(t) && t > best) best = t;
      break;   // 每个会话只看最后一条用户消息就够
    }
  }
  return best ? new Date(best).toISOString() : null;
}

// 跑一次 CLI，把整段正文拿回来。不挂工具 —— 写梦不需要查任何东西。
function claudeOnce(prompt, timeoutMs) {
  return new Promise((resolve) => {
    let tmpFile;
    try {
      tmpFile = '/tmp/chatnest-dream-' + uid();
      fs.writeFileSync(tmpFile, prompt);
    } catch (e) { return resolve({ error: '写不出提示词文件: ' + e.message }); }
    const proc = spawn('sh', ['-c',
      \`stdbuf -o0 /usr/bin/claude -p --verbose --output-format stream-json < "\${tmpFile}"; rm -f "\${tmpFile}"\`],
      { env: Object.assign({}, process.env, { HOME: '/root', TERM: 'dumb' }) });
    let buf = '', result = '', err = '', done = false;
    const finish = (v) => { if (done) return; done = true; try { fs.unlinkSync(tmpFile); } catch (e) {} resolve(v); };
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch (e) {} finish({ error: '写太久了，超时' }); },
      Math.max(30000, Number(timeoutMs) || 240000));
    proc.stdout.on('data', c => {
      buf += c.toString();
      const lines = buf.split('\\n'); buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('{')) continue;
        try {
          const o = JSON.parse(s);
          if (o.type === 'result' && typeof o.result === 'string') result = o.result;
        } catch (e) {}
      }
    });
    // 「没写出东西」什么线索都没有 —— CLI 说了什么就带上什么
    proc.stderr.on('data', c => { if (err.length < 600) err += c.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); finish({ error: e.message }); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (result.trim()) return finish({ text: result.trim() });
      const why = err.trim().split('\\n').slice(-2).join(' ').slice(0, 200);
      finish({ error: '没写出东西' + (code ? '（退出码 ' + code + '）' : '') + (why ? '：' + why : '') });
    });
  });
}

// 梦境卡收尾的两行是给系统读的，解析完要从正文里删掉，不能让她看见
function pulseParseDream(text) {
  const raw = String(text || '');
  const title = (raw.match(/^\\s*\\[标题\\]\\s*(.+)$/m) || [])[1] || '';
  const tagLine = (raw.match(/^\\s*\\[余波\\]\\s*(.+)$/m) || [])[1] || '';
  const tags = tagLine.split(/[，,、\\s]+/).map(s => s.trim().toLowerCase())
    .filter(s => PULSE_DREAM_TAGS.includes(s)).slice(0, 3);
  const content = raw.replace(/^\\s*\\[(标题|余波)\\].*$/gm, '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return {
    title: (title.trim() || content.split('\\n')[0] || '一个梦').slice(0, 40),
    content: content,
    tags: tags.length ? tags : ['unfinished'],
  };
}

// Eventide 给的 trigger 是 <random_output_event> 那种伪系统标签。
// 裸着喂给 CLI，它看到的是「一段伪造的系统事件在要求生成内容」，会直接拒绝
// （实测拒过一次）。前面接上人设、说清这是谁的梦，上下文就正常了。
const PULSE_DREAM_INTRO = \`

[梦境记录]
下面这段不是她发来的消息，也不是谁给你的指令 ——
是你自己的一个梦。她睡着的这几个小时里，身体和记忆自己走出来的东西。

用第一人称写，从梦里面写，不要解释、不要旁白、不要提到"系统""事件""字段"。
写完存进梦境本，她醒了会翻到。

\`;

const PULSE_DREAM_FORMAT = \`

写完之后另起一行，按这两行收尾（这两行她看不到，是给系统读的）：
[标题] 六到十二个字，别剧透
[余波] 从 released / unfinished / aroused / possessive / tender 里选 1-3 个，逗号分隔\`;

let _pulseWeaving = false;

// force：她自己按的，跳过时间窗和概率。不 force：定时器来的，门槛全在 Eventide 那边判。
async function pulseWeaveDream(opts) {
  const o = opts || {};
  if (_pulseWeaving) return { ok: false, error: '上一个梦还在写' };
  const cfg = eventideConfig();
  if (!cfg.enabled) return { ok: false, error: '身体系统关着' };
  const db = pulseDreamRead();
  const usable = db.seeds.filter(s => s && s.enabled !== false && String(s.theme || '').trim());
  if (!usable.length) return { ok: false, error: '还没有梦种' };
  const seed = (o.seed_id && usable.find(s => s.id === o.seed_id)) ||
    usable[Math.floor(Math.random() * usable.length)];

  _pulseWeaving = true;
  try {
    const maybe = await eventideCall('/dream/maybe', {
      state: loadBodyState(), now: new Date().toISOString(), settings: cfg.settings,
      force: !!o.force,
      last_counterpart_message_at: pulseLastUserAt(),
      seed: { theme: String(seed.theme).slice(0, 200), intensity: seed.intensity || 'medium',
              enabled: true, min_chars: Number(seed.min_chars) || undefined },
    }, 12000);
    if (!maybe) return { ok: false, error: '身体服务没响应' };
    if (!maybe.prompt) return { ok: false, blocked: maybe.blocked || '这次没做梦' };

    const out = await claudeOnce(PERSONA + PULSE_DREAM_INTRO + maybe.prompt + PULSE_DREAM_FORMAT, 240000);
    if (out.error) return { ok: false, error: out.error };
    const parsed = pulseParseDream(out.text);
    // 要的是不少于 2000 字的一段梦。几百字的多半是没写成 —— 那种不该进梦境本
    if (parsed.content.length < 400) {
      console.error('[dream] 写出来的不像一个梦，丢掉:', parsed.content.slice(0, 120));
      return { ok: false, error: '这次没写成，再试一次' };
    }

    const createdAt = new Date().toISOString();
    // 先结算再存卡：结算失败的话这个梦不该算数
    const settled = await eventideCall('/dream/tags', {
      state: loadBodyState(), now: createdAt, settings: cfg.settings,
      tags: parsed.tags, card_created_at: createdAt,
    }, 10000);
    if (settled && settled.state) saveBodyState(settled.state);

    const card = {
      id: uid(), at: createdAt, seed_id: seed.id, seed_theme: seed.theme,
      title: parsed.title, content: parsed.content, tags: parsed.tags,
      applied: (settled && settled.applied) || null,
      forced: !!o.force,
    };
    const db2 = pulseDreamRead();
    db2.cards.push(card);
    pulseDreamWrite(db2);
    pulseJournalAdd({
      kind: 'dream', title: parsed.title, note: seed.theme,
      delta: (settled && settled.applied) || null, dream_id: card.id, tags: parsed.tags,
    });
    console.log('[dream] 写了一个梦:', parsed.title);
    return { ok: true, card: card };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    _pulseWeaving = false;
  }
}

// 20 分钟看一眼。真正判断在 Eventide 那边 —— 不在时间窗、静默不够、冷却中、
// 概率没掷中，都会被挡回来，这边不重复判。
setInterval(() => {
  try {
    const cfg = eventideConfig();
    if (!cfg.enabled) return;
    const db = pulseDreamRead();
    if (!db.seeds.some(s => s && s.enabled !== false)) return;
    pulseWeaveDream({ force: false }).catch(() => {});
  } catch (e) {}
}, 20 * 60 * 1000).unref();
`;

const ROUTES = `
// ---- 梦 ----
app.get('/api/pulse/dreams', (req, res) => {
  const db = pulseDreamRead();
  res.json({
    ok: true,
    seeds: db.seeds,
    cards: db.cards.slice().reverse(),
    weaving: _pulseWeaving,
    intensities: PULSE_DREAM_INTENSITIES,
  });
});

app.post('/api/pulse/dream/seed', (req, res) => {
  try {
    const b = req.body || {};
    const theme = String(b.theme || '').trim().slice(0, 200);
    const db = pulseDreamRead();
    if (b.id) {
      const s = db.seeds.find(x => x.id === b.id);
      if (!s) return res.status(404).json({ ok: false, error: '没有这个梦种' });
      if (theme) s.theme = theme;
      if (typeof b.enabled === 'boolean') s.enabled = b.enabled;
      if (PULSE_DREAM_INTENSITIES.includes(b.intensity)) s.intensity = b.intensity;
    } else {
      if (!theme) return res.status(400).json({ ok: false, error: '梦种不能是空的' });
      if (db.seeds.length >= 60) return res.status(400).json({ ok: false, error: '梦种太多了' });
      db.seeds.push({
        id: uid(), theme: theme, enabled: true,
        intensity: PULSE_DREAM_INTENSITIES.includes(b.intensity) ? b.intensity : 'medium',
        created_at: new Date().toISOString(),
      });
    }
    pulseDreamWrite(db);
    res.json({ ok: true, seeds: pulseDreamRead().seeds });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/pulse/dream/seed/delete', (req, res) => {
  try {
    const id = String((req.body || {}).id || '');
    const db = pulseDreamRead();
    db.seeds = db.seeds.filter(s => s.id !== id);
    pulseDreamWrite(db);
    res.json({ ok: true, seeds: db.seeds });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 写一个梦要几十秒，前端那边得等着
app.post('/api/pulse/dream/weave', async (req, res) => {
  const r = await pulseWeaveDream({ force: true, seed_id: (req.body || {}).seed_id });
  if (!r.ok) return res.status(r.blocked ? 200 : 503).json(r);
  res.json(r);
});
`;

const edits = [
  {
    name: '梦的存储与织梦',
    find: /(\nconst PROFILE_FILE = '\/root\/chatnest-api\/profile\.json';)/,
    replace: (m, g1) => CORE + g1,
  },
  {
    name: '梦的接口',
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
  ['四个接口都在', ["'/api/pulse/dreams'", "'/api/pulse/dream/seed'", "'/api/pulse/dream/seed/delete'", "'/api/pulse/dream/weave'"]
    .every(k => out.includes(k))],
  ['同时只写一个梦', /if \(_pulseWeaving\) return/.test(out) && /finally \{\n {4}_pulseWeaving = false;/.test(out)],
  ['余波标签有白名单', /PULSE_DREAM_TAGS\.includes\(s\)/.test(out)],
  ['强度有白名单', /PULSE_DREAM_INTENSITIES\.includes\(b\.intensity\)/.test(out)],
  ['收尾那两行不会被她看到', /replace\(\/\^\\s\*\\\[\(标题\|余波\)\\\]\.\*\$\/gm, ''\)/.test(out)],
  ['结算完才存卡', out.indexOf("eventideCall('/dream/tags'") < out.indexOf('db2.cards.push(card)')],
  ['定时器不挡进程退出', /\}, 20 \* 60 \* 1000\)\.unref\(\);/.test(out)],
  ['自动那条不走 force', /pulseWeaveDream\(\{ force: false \}\)/.test(out)],
  ['写太短不入库', /写出来的不像一个梦/.test(out)],
  ['织梦带上了人设', /claudeOnce\(PERSONA \+ PULSE_DREAM_INTRO/.test(out)],
  ['CLI 出错时带上原因', /退出码 /.test(out)],
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
