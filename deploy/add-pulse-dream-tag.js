#!/usr/bin/env node
// 让我自己也能织梦 —— 现在只有前端那个按钮能碰。
//   node add-pulse-dream-tag.js [/root/chatnest-api/server.js]
//
// 她让我在 pulse 里织一个梦，我说「不确定格式」—— 那不是忘了，是真没有：
// <pulse> 标签只认 settle / event / cycle / delta，说明里也只写了 settle 和 event。
// 织梦从头到尾只有 /api/pulse/dream/weave 这个 HTTP 接口，前端按钮专用。
//
// 加一个 <pulse tool="dream">：
//   带 seed  → 先把这句话存成梦种，再用它织
//   不带     → 从已有梦种里随机挑一个（跟前端那个按钮一样）
//
// ⚠ 织一个梦要写 2000 字，pulseWeaveDream 里给 claudeOnce 的超时是 240 秒。
// 所以这里**绝不能同步等** —— 那会把她的回复卡四分钟。开后台跑，
// 标签立刻回「开始织了」，写完自己进梦境本，她去 Pulse 那一屏看。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
const VERSION_LINE = 'PULSE_DREAM_TAG_V1';
if (src.includes(VERSION_LINE)) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('async function runPulseTool')) {
  console.error('要先打 add-eventide.js'); process.exit(1);
}
if (!src.includes('async function pulseWeaveDream')) {
  console.error('要先打 add-pulse-dreams.js'); process.exit(1);
}

let out = src;
const done = [];

// 1) 标签分流里加 dream —— 放在「不认识的工具」之前，自己 return，不走下面那次 eventideCall
const ANCHOR_BRANCH = `  } else {
    return { error: '不认识的工具: ' + tool };
  }`;
const NEW_BRANCH = `  } else if (tool === 'dream') {
    // ${VERSION_LINE}
    // 织一个梦要写 2000 字（claudeOnce 超时 240 秒），同步等会把她的回复卡住。
    // 后台跑，这里立刻回。写完自己进梦境本。
    const seedText = String((args && (args.seed || args.theme || args.text)) || '').trim().slice(0, 200);
    if (seedText) {
      try {
        const _db = pulseDreamRead();
        if (_db.seeds.length < 60) {
          _db.seeds.push({
            id: uid(), theme: seedText, enabled: true,
            intensity: PULSE_DREAM_INTENSITIES.includes(args && args.intensity) ? args.intensity : 'medium',
            created_at: new Date().toISOString(),
          });
          pulseDreamWrite(_db);
        }
      } catch (e) { console.error('[dream] 存梦种失败:', e.message); }
    }
    // 一个梦种都没有的话，织出来只会是「还没有梦种」，先说清楚
    try {
      const _d = pulseDreamRead();
      const _usable = (_d.seeds || []).filter(s => s && s.enabled !== false && String(s.theme || '').trim());
      if (!_usable.length) return { error: '还没有梦种 —— 先给我一句想让我梦到的' };
    } catch (e) {}
    setImmediate(() => {
      pulseWeaveDream({ force: true })
        .then(r => console.log('[dream] 织完了:', r && r.ok ? (r.card && r.card.title) : (r && (r.error || r.blocked))))
        .catch(e => console.error('[dream] 织的时候出错:', e.message));
    });
    return { started: true, note: '开始织了，写完会进梦境本' };
  } else {
    return { error: '不认识的工具: ' + tool };
  }`;
if (out.includes(ANCHOR_BRANCH)) {
  out = out.replace(ANCHOR_BRANCH, NEW_BRANCH); done.push('标签分流里加了 dream');
} else {
  console.error('× 没匹配到 runPulseTool 的分流末尾，原文件一个字都没动。'); process.exit(1);
}

// 2) 界面上那行的显示名
const ANCHOR_LABEL = "  delta: '写回 · 身体',\n};";
if (out.includes(ANCHOR_LABEL)) {
  out = out.replace(ANCHOR_LABEL, "  delta: '写回 · 身体',\n  dream: '织一个梦 · Pulse',\n};");
  done.push('工具行的显示名');
} else { console.log('  · 没找到 PULSE_TOOL_LABEL，界面上会显示原始工具名（不影响功能）'); }

// 3) 说明里补上 —— 不写进去我照样不知道有这个东西，这正是今天朋友圈那件事的教训
const DREAM_DOC = `
【dream】织一个梦。她给过梦种（想让你梦到什么）之后，你可以自己织。
<pulse tool="dream">{"seed":"想梦到的那件事"}</pulse>
  seed 可以不给 —— 不给就从她已经写下的梦种里随机挑一个。
  一个梦种都没有的时候会告诉你，那就先问她想让你梦到什么。
  写一个梦要几分钟，标签发出去就立刻返回了，梦写完自己进「梦境本」，
  不用等、也不用在正文里念结果。
`;
const m = out.match(/const PULSE_TOOL_PROMPT\s*=\s*`([\s\S]*?)`;/);
if (m) {
  out = out.replace(m[0], 'const PULSE_TOOL_PROMPT = `' + m[1].replace(/\s*$/, '\n') + DREAM_DOC + '`;');
  done.push('说明里写上了怎么织梦');
} else { console.error('× 没找到 PULSE_TOOL_PROMPT，说明补不进去 —— 那我还是不知道有这东西'); process.exit(1); }

const checks = [
  ['版本戳写进去了', out.includes(VERSION_LINE)],
  ['dream 分支在', /tool === 'dream'/.test(out)],
  ['是后台跑不是同步等', /setImmediate\(\(\) => \{\s*pulseWeaveDream/.test(out)],
  ['没梦种时会说清楚', /还没有梦种 —— 先给我一句想让我梦到的/.test(out)],
  ['说明里有 dream', /<pulse tool="dream">/.test(out)],
  ['settle / event 没被动', /tool === 'settle'/.test(out) && /tool === 'event'/.test(out)],
  ['只加了一次', (out.match(new RegExp(VERSION_LINE, 'g')) || []).length === 1],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完之后语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
for (const d of done) console.log('  √ ' + d);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
