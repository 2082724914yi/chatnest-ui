#!/usr/bin/env node
// 把 Latent·显影记忆库接进 chatnest-api，跟 OB 平级。
//   node add-latent.js [/root/chatnest-api/server.js]
//
// 分工（两边不重复、不打架）：
//   OB     提炼层 —— 核心准则、承诺、重要的话，每开新窗主动浮现
//   Latent 全文层 —— 完整叙述 + 未解决事项，平时不出现，问到了才查
//
// 跟 OB 一样分两条路：
//   查询类（session_start / search）必须在回复之前跑完 —— 标签是回复写完才执行的，
//   那时候结果模型已经看不到了。
//   写入类（append / correct / unresolved / thread_close）走回复后面的 <latent> 标签。
//
// 工具说明放静态区，不放变化区：它是常量，混进变化的部分会把缓存前缀打断。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('LATENT_TOOL_PROMPT')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('PULSE_TOOL_PROMPT')) {
  console.error('要先打 add-eventide.js 和 fix-cache-order.js'); process.exit(1);
}

const CORE = `
// ============ Latent·显影：全文层记忆 ============
// 跟 OB 并存。OB 管"该主动浮现的"，Latent 管"完整正文和还没结束的事"。
const LATENT_URL = process.env.LATENT_URL || 'http://127.0.0.1:8765';
const LATENT_ENV_FILE = '/root/chatnest-api/.env';
let latentCallId = 1;
let _latentToken = null;

// 口令只在 .env 里（600 权限），不写进代码也不打印
function latentToken() {
  if (_latentToken !== null) return _latentToken;
  if (process.env.LATENT_TOKEN) { _latentToken = process.env.LATENT_TOKEN; return _latentToken; }
  try {
    const raw = fs.readFileSync(LATENT_ENV_FILE, 'utf8');
    const m = raw.match(/^LATENT_TOKEN=(.*)$/m);
    _latentToken = m ? m[1].trim() : '';
  } catch (e) { _latentToken = ''; }
  return _latentToken;
}

async function latentCall(tool, args, ms) {
  const token = latentToken();
  if (!token) { console.error('[latent] 没有口令，跳过'); return null; }
  try {
    const r = await obFetch(LATENT_URL + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        jsonrpc: '2.0', id: latentCallId++, method: 'tools/call',
        params: { name: tool, arguments: args || {} },
      }),
    }, ms || 20000);
    const j = await r.json();
    if (!j || j.error) { console.error('[latent]', tool, j && j.error && j.error.message); return null; }
    const blocks = (j.result && j.result.content) || [];
    const text = blocks.filter(b => b && b.type === 'text').map(b => b.text).join('\\n').trim();
    return text || null;
  } catch (e) {
    console.error('[latent]', tool, '调用失败:', e.message);
    return null;
  }
}

// ---- <latent> 标签：回复写完之后执行的写入类工具 ----
const LATENT_TAG_RE = /<latent\\b([^>]*)>([\\s\\S]*?)<\\/latent>/gi;

const LATENT_TOOL_LABEL = {
  append: '写回 · 全文记忆',
  correct: '更正 · 全文记忆',
  unresolved: '未解决事项',
  thread_close: '收尾 · 本次会话',
};
const LATENT_TOOL_NAME = {
  append: 'latent_append',
  correct: 'latent_correct',
  unresolved: 'latent_unresolved',
  thread_close: 'latent_thread_close',
};

function parseLatentToolCalls(text) {
  const calls = [];
  let m;
  LATENT_TAG_RE.lastIndex = 0;
  while ((m = LATENT_TAG_RE.exec(text)) !== null) {
    const attrs = m[1] || '';
    let tool = (attrs.match(/tool\\s*=\\s*"([^"]+)"/) || attrs.match(/tool\\s*=\\s*'([^']+)'/) ||
                attrs.match(/tool\\s*=\\s*([A-Za-z_]\\w*)/) || [])[1] || '';
    let args = null;
    // 正文里带中文引号很常见，先正常解析，坏了就整条报出来而不是静默丢掉
    try { args = JSON.parse(String(m[2] || '').trim()); } catch (e) { args = null; }
    if (!tool && args && typeof args.tool === 'string') { tool = args.tool; delete args.tool; }
    calls.push({ tool: tool || '未知', args: args, raw: m[0].slice(0, 200) });
  }
  return calls;
}

function stripLatentToolCalls(text) {
  return String(text || '').replace(/\\s*<latent\\b[^>]*>[\\s\\S]*?<\\/latent>\\s*/gi, '\\n\\n')
    .replace(/\\n{3,}/g, '\\n\\n').trim();
}

async function runLatentTool(tool, args) {
  const name = LATENT_TOOL_NAME[tool];
  if (!name) return { error: '不认识的工具: ' + tool };
  const out = await latentCall(name, args, 30000);
  if (out === null) return { error: '记忆库没响应' };
  return { text: out };
}
`;

const TOOL_PROMPT = `
const LATENT_TOOL_PROMPT = \`
你还有一层全文记忆（Latent）。它跟 Ombre Brain 分工不同，别搞混：
  · OB      提炼过的、该主动浮现的：核心准则、承诺、她说过的重要的话
  · Latent  完整正文：这件事到底怎么发生的，原话是什么；以及还没结束的事

查过去不用调工具 —— 该给你的已经在上面了。要写回时用标签（放回复正文之后，她看不见）：

【append】这一段值得留完整正文的时候
  text           发生了什么 —— 具体动作和原话，不是概括
  current_state  这件事现在什么状态
<latent tool="append">{"text":"她说奶奶今天打电话来问她冷不冷，她说不冷，挂了以后自己哭了一会儿","current_state":"她跟奶奶通过话了，情绪还没完全落下来"}</latent>

【unresolved】答应了还没做、说了还没定的事
  action   open 新开 / update 改 / close 关掉
  id       update 和 close 必填，形如 U-xxxx
  summary  一句话说清是什么事
<latent tool="unresolved">{"action":"open","summary":"答应她这周把朋友圈那个功能搓出来，还没开始"}</latent>

【correct】她更正了以前的说法，旧的要撤回
  quote       要撤回的原文片段，逐字，不转述
  reason      为什么撤回
  correction  更正后的内容（可省略：只撤不补）
<latent tool="correct">{"quote":"她说她不喜欢吃甜的","reason":"她后来说是不喜欢腻的，甜的可以","correction":"她不喜欢太腻的，甜度本身没问题","current_state":"已更正口味偏好"}</latent>

规矩：
- 值得留正文的才 append：一段完整的事、她说的原话、情绪的来龙去脉。
  闲聊、已经记过的、临时的问题，都不写
- 答应她的事一定开 unresolved，做完了记得 close —— 这是她能看见的清单
- 她更正你的时候走 correct，别直接 append 一条新的把旧的盖过去
- 写完不要在正文里跟她复述"我记下来了"，存了就存了
\`;
`;

const ROUTES = `
// ---- Latent 记忆页接口 ----
app.get('/api/latent/status', async (req, res) => {
  const token = latentToken();
  if (!token) return res.json({ ok: true, enabled: false, reason: '没配 LATENT_TOKEN' });
  try {
    const r = await obFetch(LATENT_URL + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }, 8000);
    const j = await r.json();
    const tools = ((j.result && j.result.tools) || []).map(t => t.name);
    res.json({ ok: true, enabled: true, alive: tools.length > 0, tools: tools });
  } catch (e) {
    res.json({ ok: true, enabled: true, alive: false, error: e.message });
  }
});

// 当前未解决 + 上次会话快照 —— 前端 Latent 页的主屏
app.get('/api/latent/recall', async (req, res) => {
  const out = await latentCall('latent_session_start', {}, 20000);
  if (out === null) return res.status(503).json({ ok: false, error: '记忆库没响应' });
  res.json({ ok: true, text: out });
});

app.get('/api/latent/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: true, text: '' });
  const out = await latentCall('latent_search', { query: q }, 25000);
  if (out === null) return res.status(503).json({ ok: false, error: '记忆库没响应' });
  res.json({ ok: true, text: out });
});

app.post('/api/latent/unresolved', async (req, res) => {
  const out = await latentCall('latent_unresolved', req.body || {}, 20000);
  if (out === null) return res.status(503).json({ ok: false, error: '记忆库没响应' });
  res.json({ ok: true, text: out });
});
`;

const edits = [
  {
    name: '核心模块 + 工具说明',
    find: /(\nconst PROFILE_FILE = '\/root\/chatnest-api\/profile\.json';)/,
    replace: (m, g1) => CORE + TOOL_PROMPT + g1,
  },
  {
    name: '工具说明进静态区（保住缓存前缀）',
    find: "  let prompt = PERSONA + '\\n' + THINK_PROMPT + '\\n' + OB_TOOL_PROMPT + '\\n' + PULSE_TOOL_PROMPT + '\\n\\n';",
    replace: "  let prompt = PERSONA + '\\n' + THINK_PROMPT + '\\n' + OB_TOOL_PROMPT + '\\n' + PULSE_TOOL_PROMPT + '\\n' + LATENT_TOOL_PROMPT + '\\n\\n';",
  },
  {
    name: '回复前召回（新窗 / 她提到过去）',
    find: "  const _body = await eventideCheck(message, _lastUserAt);",
    replace:
      "  // Latent 查询类必须在这儿跑完：<latent> 标签是回复写完才执行的，\n" +
      "  // 那时候结果我已经看不到了。新窗召回未解决事项，问到过去就检索全文。\n" +
      "  let latentRecall = null;\n" +
      "  if (latentToken()) {\n" +
      "    const _lt = isFirstTurn ? 'latent_session_start' : (wantsRecall ? 'latent_search' : null);\n" +
      "    if (_lt) {\n" +
      "      const lTrace = traceStart('tool', _lt === 'latent_search' ? 'latent_search · 翻全文' : 'latent_session_start · 换窗召回');\n" +
      "      lTrace.input = _lt === 'latent_search' ? { query: String(message).slice(0, 50) } : {};\n" +
      "      sse(res, 'trace', { action: 'input', id: lTrace.id, input: lTrace.input });\n" +
      "      latentRecall = await latentCall(_lt, _lt === 'latent_search' ? { query: message } : {}, 25000);\n" +
      "      lTrace.result = latentRecall || '这次没召回到内容';\n" +
      "      sse(res, 'trace', { action: 'result', id: lTrace.id, result: lTrace.result });\n" +
      "      traceEnd(lTrace);\n" +
      "    }\n" +
      "  }\n" +
      "  const _body = await eventideCheck(message, _lastUserAt);",
  },
  {
    name: '注入召回（CC 订阅路径）',
    find: "  if (memories) prompt += `[相关记忆 - 你和她之前的回忆]\\n${memories}\\n[记忆结束]\\n\\n`;",
    replace:
      "  if (memories) prompt += `[相关记忆 - 你和她之前的回忆]\\n${memories}\\n[记忆结束]\\n\\n`;\n" +
      "  if (latentRecall) prompt += `[全文记忆 - 未解决的事和完整经过]\\n${latentRecall}\\n[全文记忆结束]\\n\\n`;",
  },
  {
    name: '注入召回（中转站路径）',
    find: "(memories ? `\\n\\n[相关记忆]\\n${memories}\\n[记忆结束]` : '')",
    replace: "(memories ? `\\n\\n[相关记忆]\\n${memories}\\n[记忆结束]` : '') + (latentRecall ? `\\n\\n[全文记忆 - 未解决的事和完整经过]\\n${latentRecall}\\n[全文记忆结束]` : '')",
  },
  {
    name: '回复后执行 <latent> 标签',
    find: "    } catch (e) { console.error('[eventide] post-response tool error:', e.message); }",
    replace:
      "    } catch (e) { console.error('[eventide] post-response tool error:', e.message); }\n\n" +
      "    // 全文记忆写回：完整正文、未解决事项、更正\n" +
      "    try {\n" +
      "      const latentCalls = parseLatentToolCalls(fullResponse);\n" +
      "      fullResponse = stripLatentToolCalls(fullResponse);\n" +
      "      for (const lc of latentCalls) {\n" +
      "        const t = traceStart('tool', LATENT_TOOL_LABEL[lc.tool] || (lc.tool + ' · 全文记忆'));\n" +
      "        t.input = lc.args || { raw: lc.raw };\n" +
      "        sse(res, 'trace', { action: 'input', id: t.id, input: t.input });\n" +
      "        if (!lc.args) {\n" +
      "          t.result = '没写进去：JSON 坏了（正文里的引号用「」，别用 \\\")';\n" +
      "          sse(res, 'trace', { action: 'result', id: t.id, result: t.result, is_error: true });\n" +
      "          traceEnd(t, 'error');\n" +
      "          continue;\n" +
      "        }\n" +
      "        const r = await runLatentTool(lc.tool, lc.args);\n" +
      "        if (!r || r.error) {\n" +
      "          t.result = (r && r.error) || '失败';\n" +
      "          sse(res, 'trace', { action: 'result', id: t.id, result: t.result, is_error: true });\n" +
      "          traceEnd(t, 'error');\n" +
      "        } else {\n" +
      "          t.result = r.text || '完成';\n" +
      "          sse(res, 'trace', { action: 'result', id: t.id, result: t.result });\n" +
      "          traceEnd(t);\n" +
      "        }\n" +
      "      }\n" +
      "    } catch (e) { console.error('[latent] post-response tool error:', e.message); }",
  },
  {
    name: 'Latent 接口',
    find: /(\napp\.listen\(PORT, '0\.0\.0\.0', \(\) => \{)/,
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

// 缓存前缀不能被这次改动破坏：工具说明必须在静态区，召回必须在历史之前
const iStatic = out.indexOf('let prompt = PERSONA');
const iRecall = out.indexOf('if (latentRecall) prompt +=');
// 「最近的」三个字两版不一样，自检也得两种都认 —— 上面锚点已经容错了，
// 这里再写死一次等于白容错
const iHistory = (() => { const m = out.match(/prompt \+= '---\\n以下是(?:最近的)?对话/); return m ? m.index : -1; })();
const iCard = out.indexOf("if (_bodyCard) prompt += '\\n' + _bodyCard");
const checks = [
  ['工具说明在静态区', /let prompt = PERSONA[^;]*LATENT_TOOL_PROMPT/.test(out)],
  ['召回在历史之前', iRecall > iStatic && iRecall < iHistory],
  ['状态卡仍然在最后', iCard > iHistory],
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
