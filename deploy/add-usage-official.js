#!/usr/bin/env node
// 订阅额度显示成跟官方一模一样的数。
//   node add-usage-official.js [/root/chatnest-api/server.js]
//
// 她发现前端那两张卡（5 小时 29% / 7 天 84%）跟 Claude 官方那一屏
// （43% / 86%）对不上。原因不是哪里坏了，是两套算法：
// 前端那个是后端自己数 token 记的账再除以一个估的上限，
// 官方那个是 Anthropic 服务端按真实计费算的（缓存折扣、模型权重都算进去）。
// 各算各的，永远不会一致 —— 注意重置时间是对得上的，因为时间照规则推，
// 只有百分比对不上，这正说明问题出在「算」而不是「读」。
//
// 要一模一样只有一条路：拿官方那份数。
// CC CLI 自己用的就是 /api/oauth/usage?at_wall=1&skip_spend=1，
// 凭证在它自己的 .credentials.json 里。实测调得通，返回：
//   five_hour: { utilization: 52.0, resets_at: "2026-09-06T14:00:00+00:00" }
//   seven_day: { utilization: 87.0, resets_at: "2026-09-10T10:00:00+00:00" }
//
// 做法：不动原来那个 /api/cc-usage 路由，在它前面挂一个同路径的 handler，
// 把 res.json 包一层 —— 官方数据拿到了就替换 rateLimit.unifiedWindows，
// 拿不到就原样放行。这样原路由返回的其它字段一个不丢，
// 官方接口挂了也只是退回旧行为，不会把那一屏搞白。
//
// token 只读不写、不打印、不落日志。缓存 60 秒，别把这个接口打爆。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
const VERSION_LINE = '// USAGE_OFFICIAL_VERSION = 1';
if (src.includes('USAGE_OFFICIAL_VERSION')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes("app.get('/api/cc-usage'")) {
  console.error("找不到 app.get('/api/cc-usage')，要先打 add-usage-ledger.js"); process.exit(1);
}

const BLOCK = `
${VERSION_LINE}
// ---- 官方额度：跟 Claude 那一屏同一个数据源 ----
// 前端读的是 rateLimit.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}，
// 字段形状不变，只把数换成官方的，所以前端一行都不用改。
const CC_CRED_PATHS = [
  '/root/.claude/.credentials.json',
  (process.env.HOME || '/root') + '/.claude/.credentials.json',
];
let _officialCache = { at: 0, data: null };

function ccOauthToken() {
  for (const p of CC_CRED_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      // 结构可能不止一种，几个常见位置都摸一遍
      const cands = [
        c && c.claudeAiOauth && c.claudeAiOauth.accessToken,
        c && c.oauth && c.oauth.accessToken,
        c && c.accessToken,
        c && c.access_token,
      ];
      for (const t of cands) if (typeof t === 'string' && t.length > 20) return t;
    } catch (e) { /* 换下一个 */ }
  }
  return null;
}

async function fetchOfficialUsage() {
  const now = Date.now();
  if (_officialCache.data && now - _officialCache.at < 60000) return _officialCache.data;
  const tok = ccOauthToken();
  if (!tok) return null;
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1', {
      headers: {
        Authorization: 'Bearer ' + tok,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'chatnest-usage',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { console.error('[usage] 官方接口 HTTP', r.status); return null; }
    const j = await r.json();
    const one = (w) => {
      if (!w || typeof w.utilization !== 'number') return null;
      const out = { utilization: w.utilization / 100 };   // 官方给百分数，前端要 0~1
      if (w.resets_at) {
        const ts = Date.parse(w.resets_at);
        if (!Number.isNaN(ts)) out.resetsAt = Math.floor(ts / 1000);  // 前端按秒 ×1000
      }
      return out;
    };
    const five = one(j.five_hour), seven = one(j.seven_day);
    if (!five && !seven) return null;
    const data = {};
    if (five) data.five_hour = five;
    if (seven) data.seven_day = seven;
    _officialCache = { at: now, data };
    return data;
  } catch (e) {
    console.error('[usage] 官方接口调不通:', e.message);
    return null;
  }
}

// 挂在原路由前面：只换数，不接管。拿不到就原样放行，退回旧行为。
app.get('/api/cc-usage', async (req, res, next) => {
  let official = null;
  try { official = await fetchOfficialUsage(); } catch (e) {}
  if (official) {
    const origJson = res.json.bind(res);
    res.json = (body) => {
      try {
        if (body && typeof body === 'object') {
          body.rateLimit = Object.assign({}, body.rateLimit, {
            unifiedWindows: Object.assign({}, (body.rateLimit || {}).unifiedWindows, official),
            source: 'official',
          });
        }
      } catch (e) { /* 换不成就用原来的，别为了好看把这一屏搞崩 */ }
      return origJson(body);
    };
  }
  next();
});
`;

// 插在原来那个 /api/cc-usage 之前 —— Express 按注册顺序匹配，必须在前面
const ANCHOR = /\napp\.get\('\/api\/cc-usage'/;
if (!ANCHOR.test(src)) { console.error('锚点没命中，原文件一个字都没动。'); process.exit(1); }
let out = src.replace(ANCHOR, '\n' + BLOCK + "\napp.get('/api/cc-usage'");

const checks = [
  ['版本戳写进去了', out.includes(VERSION_LINE)],
  ['取 token 的函数在', /function ccOauthToken/.test(out)],
  ['调官方接口的函数在', /fetchOfficialUsage/.test(out)],
  ['原路由还在（没被顶掉）', (out.match(/app\.get\('\/api\/cc-usage'/g) || []).length === 2],
  ['拿不到就放行', /next\(\);\n\}\);/.test(out)],
  ['只加了一次', (out.match(/USAGE_OFFICIAL_VERSION/g) || []).length === 1],
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

console.log('\n补丁结果：');
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
