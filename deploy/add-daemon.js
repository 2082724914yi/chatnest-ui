#!/usr/bin/env node
// 常驻会话（claude -p persistent）：进程起一次，从 stdin 连续喂、stdout 连续吐，永不退。
//   node add-daemon.js [/root/chatnest-api/server.js]
//
// 照 claude-p-persistent 教程做。result 事件分界一轮；session_id 存进 conv.daemonSid，
// 进程死了 / 服务重启就 --resume 续上 —— 历史进增量缓存（实测第二轮 cache_read 上万）。
// 前端带 daemon:true 才走这条（灰度）；编辑/重试仍走原来的 -p 路径。
// 每个会话一个独立 CLI session（剥掉外壳注入的 CLAUDE_CODE_* 才不会串号）。
//
// 常驻代码整块放在文件末尾的注释块里，运行时按 marker 原样抠出来插进去，
// 不经字符串转义 —— 正则里的 \n \s 不会被吃掉。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('DAEMON_PATCH_VERSION')) { console.log('已经打过，跳过'); process.exit(0); }

// 从本文件末尾的注释块里原样抠出常驻代码（marker 拆开写，免得 indexOf 命中抠取代码自己）
const M1 = '/*__D' + 'START__';
const M2 = '__D' + 'END__*/';
const self = fs.readFileSync(__filename, 'utf8');
const a = self.indexOf(M1), b = self.indexOf(M2);
if (a < 0 || b <= a) { console.error('找不到内嵌的常驻代码块'); process.exit(1); }
const DAEMON_CODE = self.slice(a + M1.length, b).replace(/^\r?\n/, '').replace(/\s+$/, '');
if (!DAEMON_CODE.includes('handleDaemonChat')) { console.error('内嵌代码不完整'); process.exit(1); }

const ROUTE_ANCHOR =
  "app.post('/api/chat', async (req, res) => {\n" +
  "  const { message, conversation_id, model, effort, provider, mcpServers: clientMcp, projectContext } = req.body;\n" +
  "  if (!message) return res.status(400).json({ error: 'message required' });\n";
const ROUTE_BRANCH = ROUTE_ANCHOR +
  "\n  // 常驻会话开关（灰度）：前端带 daemon:true，且不是编辑/重试，就走常驻进程\n" +
  "  if (req.body.daemon && !req.body.edit_message_id && !req.body.retry_message_id) {\n" +
  "    return handleDaemonChat(req, res);\n" +
  "  }\n";

const FORK_ANCHOR = "  } catch (e) { console.error('[branch] 分叉失败，这轮按普通消息处理:', e.message); }\n";
const FORK_HOOK = FORK_ANCHOR +
  "  if ((req.body.edit_message_id || req.body.retry_message_id) && typeof daemonReset === 'function') { try { daemonReset(convId); } catch (e) {} }\n";

const PORT_ANCHOR = "const PORT = process.env.PORT || 3000;";
const DAEMON_BLOCK = "\n// DAEMON_PATCH_VERSION = 1\n" + DAEMON_CODE + "\n\n" + PORT_ANCHOR;

const edits = [
  { name: '路由分支（daemon:true 走常驻）', find: ROUTE_ANCHOR, replace: ROUTE_BRANCH },
  { name: '编辑/重试重置常驻会话', find: FORK_ANCHOR, replace: FORK_HOOK },
  { name: '插入常驻会话代码块', find: PORT_ANCHOR, replace: DAEMON_BLOCK },
];

let out = src;
const missed = [];
for (const e of edits) {
  const before = out;
  out = out.split(e.find).join(e.replace);
  if (out === before) missed.push(e.name);
}

console.log('\n补丁结果：');
if (missed.length) {
  for (const e of edits) console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 没匹配上' : '  √ ' + e.name);
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['路由分支进去了', /req\.body\.daemon && !req\.body\.edit_message_id/.test(out)],
  ['handleDaemonChat 只定义一次', (out.match(/async function handleDaemonChat/g) || []).length === 1],
  ['daemonReset 钩子在', /typeof daemonReset === 'function'/.test(out)],
  ['剥了外壳会话变量', /CLAUDE_CODE_/.test(out) && /function daemonEnv/.test(out)],
  ['resume 存进 conv.daemonSid', /conv\.daemonSid = r\.sid/.test(out)],
  ['写回三件套都在', /function daemonWriteBack/.test(out) && out.includes('parsePulseToolCalls') && out.includes('parseLatentToolCalls')],
  ['标签不漏（藏 <think>/<ob>/<pulse>/<latent>）', out.includes("'<ob '") && out.includes("'<pulse'") && out.includes("'<latent'")],
  ['光秃 <ob> 当标记删（不吞回复）', out.includes("STRIP = ['</ob>', '<ob>']")],
  ['只插了一次', (out.match(/DAEMON_PATCH_VERSION/g) || []).length === 1],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

for (const e of edits) console.log('  √ ' + e.name);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
process.exit(0);

/*__DSTART__
// ============ 常驻会话（claude -p persistent，照教程做） ============
// 进程起一次，从 stdin 连续收 JSON、从 stdout 连续吐事件，永不退出。
// result 事件分界一轮；session_id 存下来，进程死了 --resume 续上，缓存不丢。
// root 下不能用 --dangerously-skip-permissions，换 mcpArgs() 里那套 dontAsk。
const DAEMON_IDLE_MS = Number(process.env.DAEMON_IDLE_MS || 25 * 60 * 1000);
const DAEMON_TURN_TIMEOUT_MS = Number(process.env.DAEMON_TURN_TIMEOUT_MS || 180 * 1000);
const _daemons = new Map();   // convId -> { proc, sid, busy, last, buf, on, timer }

function daemonSysFile() {
  // 跟缓存前缀共用同一个文件：稳定不变 -> 命中缓存
  try {
    const p = '/root/chatnest-api/system-prefix.txt';
    fs.writeFileSync(p, PERSONA + '\n' + THINK_PROMPT + '\n' + MCP_TOOL_PROMPT + '\n' + PULSE_TOOL_PROMPT);
    return p;
  } catch (e) { console.error('[daemon] 系统前缀写不出来:', e.message); return null; }
}

// 干净环境：把 Claude Code 外壳注入的编排变量剥掉，尤其 CLAUDE_CODE_SESSION_ID ——
// 不剥的话每个子 claude 都会继承外壳的会话号当自己的 session_id，resume 全串一块了。
// 她线上 pm2 根本没这些变量，所以剥了对生产是空操作，只在"跑在 CC 里"时救命。
// MAX_THINKING_TOKENS 这类不带 CLAUDE_CODE 前缀的照留（砍原生思考要用）。
function daemonEnv() {
  const e = Object.assign({}, process.env);
  for (const k of Object.keys(e)) {
    if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE' || k.startsWith('CLAUDE_SESSION_INGRESS')) delete e[k];
  }
  e.HOME = e.HOME || '/root';
  e.TERM = 'dumb';
  return e;
}

function daemonSpawn(convId, model, resumeSid) {
  const sysFile = daemonSysFile();
  // 用裸 claude（跟 -p 那条线一样，靠 root 的 PATH 解析），别写死路径
  const parts = ['stdbuf -o0 claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose'];
  if (model) parts.push('--model ' + model);
  if (sysFile) parts.push('--append-system-prompt-file ' + sysFile);
  const mcp = (typeof mcpArgs === 'function') ? mcpArgs() : '';
  if (mcp) parts.push(mcp.trim());
  if (resumeSid) parts.push('--resume ' + resumeSid);
  const cmd = parts.join(' ');
  console.log('[daemon] spawn', convId, resumeSid ? ('resume ' + resumeSid) : 'fresh');
  const proc = spawn('sh', ['-c', cmd], { env: daemonEnv() });
  const d = { proc, sid: resumeSid || null, busy: false, last: Date.now(), buf: '', on: null, timer: null };
  proc.stdout.on('data', (chunk) => {
    d.last = Date.now();
    d.buf += chunk.toString();
    let i;
    while ((i = d.buf.indexOf('\n')) >= 0) {
      const line = d.buf.slice(0, i); d.buf = d.buf.slice(i + 1);
      const s = line.trim();
      // resume 到死会话时，CLI 把这句打在 stdout（不是 stderr），随后吐个 error result 就退
      if (/No conversation found|session .* not found|Invalid session/i.test(s)) d._sessionGone = true;
      if (!s.startsWith('{')) continue;
      let ev; try { ev = JSON.parse(s); } catch (e) { continue; }
      if (ev && (ev.session_id || (ev.type === 'system' && ev.session_id))) d.sid = ev.session_id || d.sid;
      if (typeof d.on === 'function') { try { d.on(ev); } catch (e) { console.error('[daemon] on err', e.message); } }
    }
  });
  proc.stderr.on('data', (c) => { const t = c.toString(); d._stderr = (d._stderr || '') + t; if (/No conversation found|session .* not found|Invalid session/i.test(t)) d._sessionGone = true; });
  proc.on('close', (code) => {
    console.log('[daemon] closed', convId, 'code', code);
    if (_daemons.get(convId) === d) _daemons.delete(convId);
    // 进程在一轮进行中就退了（resume 到死会话、崩了）——别让这轮干等 180s 超时
    if (typeof d._onClose === 'function') { try { d._onClose(code); } catch (e) {} }
  });
  proc.on('error', (e) => { console.error('[daemon] proc err', e.message); if (_daemons.get(convId) === d) _daemons.delete(convId); if (typeof d._onClose === 'function') { try { d._onClose(-1); } catch (er) {} } });
  _daemons.set(convId, d);
  return d;
}

function daemonGet(convId, model, resumeSid) {
  let d = _daemons.get(convId);
  if (d && d.proc && d.proc.exitCode === null && !d.proc.killed) return d;
  return daemonSpawn(convId, model, resumeSid);
}

// 喂一句、读到这轮的 result 为止。onEvent 收每个事件；返回 { usage, sid, fresh }
function daemonSendTurn(convId, model, resumeSid, text, onEvent) {
  return new Promise((resolve) => {
    const fresh = !resumeSid;
    const d = daemonGet(convId, model, resumeSid);
    if (!d || !d.proc || d.proc.killed) return resolve({ error: '起不来' });
    let done = false;
    const finish = (v) => {
      if (done) return; done = true;
      clearTimeout(d.timer); d.on = null; d.busy = false; d._onClose = null;
      resolve(v);
    };
    // 进程中途退出（resume 到死会话最典型）：立刻收，标记会话没了，别等超时
    d._onClose = (code) => finish({ error: '进程退出 code ' + code, closed: true, sessionGone: !!d._sessionGone });
    // 180s 一个字都没吐 -> 杀进程（下轮 resume）
    const arm = () => { clearTimeout(d.timer); d.timer = setTimeout(() => {
      console.error('[daemon] turn timeout, kill', convId);
      try { d.proc.kill('SIGKILL'); } catch (e) {}
      finish({ error: '超时', timeout: true });
    }, DAEMON_TURN_TIMEOUT_MS); };
    let usage = null, gotText = false;
    d.busy = true;
    d.on = (ev) => {
      arm();
      if (typeof onEvent === 'function') onEvent(ev);
      // 这轮到底有没有正文产出（决定 error result 要不要当失败收）
      const _e = ev.type === 'stream_event' ? ev.event : ev;
      if (_e && _e.type === 'content_block_delta' && _e.delta && _e.delta.type === 'text_delta' && _e.delta.text) gotText = true;
      else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content) && ev.message.content.some(b => b.type === 'text' && b.text)) gotText = true;
      const u = (ev.message && ev.message.usage) || (ev.event && ev.event.usage) || ev.usage;
      if (u && (u.input_tokens != null || u.cache_read_input_tokens != null || u.output_tokens != null)) usage = u;
      if (ev.type === 'result') {
        if (ev.usage) usage = ev.usage;
        // error_during_execution / is_error 且这轮一个 token 都没产出 → 当失败收，让上层重新播种
        if ((ev.is_error || ev.subtype === 'error_during_execution') && !gotText) {
          finish({ error: ev.subtype || 'result_error', resultError: true, sessionGone: !!d._sessionGone, usage });
        } else {
          finish({ usage, sid: d.sid, fresh });
        }
      }
    };
    arm();
    const payload = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: text }] } };
    try { d.proc.stdin.write(JSON.stringify(payload) + '\n'); }
    catch (e) { finish({ error: '写不进 stdin: ' + e.message }); }
  });
}

// 闲置回收：25 分钟没动静就杀掉（sid 已存在会话里，下次 resume）
setInterval(() => {
  const now = Date.now();
  for (const [cid, d] of _daemons) {
    if (d.busy) continue;
    if (now - d.last > DAEMON_IDLE_MS) {
      console.log('[daemon] idle reclaim', cid);
      try { d.proc.kill('SIGTERM'); } catch (e) {}
      _daemons.delete(cid);
    }
  }
}, 60 * 1000).unref();

// 编辑/分支/清空这类"历史被替换"的操作：把常驻进程收掉，sid 作废，下轮重新播种
function daemonReset(convId) {
  const d = _daemons.get(convId);
  if (d) { try { d.proc.kill('SIGTERM'); } catch (e) {} _daemons.delete(convId); }
  const conv = conversations.get(convId);
  if (conv) { conv.daemonSid = null; }
}

// 每轮都变的那点东西（时间/手表/身体卡），贴在用户消息末尾。
// reqBody 里带着她手机的本地时间（clientTime/clientTz），renderNow 要用。
async function daemonTurnSuffix(convId, conv, message, reqBody) {
  let suffix = '';
  try {
    const _lastUserAt = (() => {
      const prev = (conv.history || []).filter(m => m.role === 'user');
      const at = prev.length > 1 ? prev[prev.length - 2].time : null;
      const dd = at ? new Date(at) : null;
      return dd && !isNaN(dd.getTime()) ? dd.toISOString() : null;
    })();
    const body = await eventideCheck(message, _lastUserAt);
    suffix += '\n\n' + renderNow(reqBody || {});
    const w = renderWatch(); if (w) suffix += '\n' + w;
    if (body && body.card) suffix += '\n\n' + body.card;
  } catch (e) { console.error('[daemon] suffix err', e.message); }
  return suffix;
}

// 新会话第一句要把上下文播种进去（记忆 + 换窗尾巴 + 最近几轮），
// 之后 resume 就靠会话自己记着，不再重播。
async function daemonSeed(convId, conv, isFirstEver) {
  let seed = '';
  try {
    let memories = null;
    try { memories = await fetchMemories(''); } catch (e) {}
    if (memories) seed += '[相关记忆 - 你和她之前的回忆]\n' + memories + '\n[记忆结束]\n\n';
    const _handoff = (typeof buildHandoff === 'function' && typeof renderHandoff === 'function')
      ? renderHandoff(buildHandoff(convId)) : '';
    if (_handoff) seed += _handoff;
    const recent = (conv.history || []).slice(-20);
    if (recent.length > 1) {
      seed += '---\n以下是我们最近的对话，接着往下：\n\n';
      for (const m of recent) {
        if (m.id && m.content) seed += (m.role === 'user' ? '小懿: ' : '小衍: ') + m.content + '\n';
      }
    }
  } catch (e) { console.error('[daemon] seed err', e.message); }
  return seed;
}

// 生成后统一收尾：把 <ob>/<pulse>/<latent> 从正文剥掉并真的执行；发 trace
async function daemonWriteBack(res, fullResponse, traceStart, traceEnd) {
  let text = fullResponse;
  // OB
  try {
    const obCalls = parseOBToolCalls(text);
    text = stripOBToolCalls(text);
    for (const tc of obCalls) {
      const t = traceStart('tool', (OB_TOOL_LABEL && OB_TOOL_LABEL[tc.tool]) || (tc.tool + ' · 记忆'));
      t.input = tc.args || { raw: tc.raw };
      sse(res, 'trace', { action: 'input', id: t.id, input: t.input });
      if (!tc.args) { t.result = '没写进去：' + tc.error; sse(res, 'trace', { action: 'result', id: t.id, result: t.result, is_error: true }); traceEnd(t, 'error'); continue; }
      if (tc.tool === 'hold' && tc.args.feel && !tc.args.source_bucket) { delete tc.args.feel; if (!tc.args.domain) tc.args.domain = '情绪'; }
      if (tc.tool === 'hold' && tc.args.feel && tc.args.domain) delete tc.args.domain;
      if (/^(hold|grow|plan)$/.test(tc.tool) && tc.args.content && typeof worthRemembering === 'function') {
        const v = worthRemembering(tc.args.content); if (!v.ok) { traceEnd(t, 'error'); continue; }
      }
      try {
        const r = await Promise.race([obCall(tc.tool, tc.args), new Promise(rr => setTimeout(() => rr(null), 70000))]);
        t.result = r || '完成';
        if (r && tc.tool === 'hold' && tc.args.content && typeof rememberIntoProfile === 'function') rememberIntoProfile(tc.args.content, 'claude');
        sse(res, 'trace', { action: 'result', id: t.id, result: t.result }); traceEnd(t);
      } catch (e) { t.result = e.message; sse(res, 'trace', { action: 'result', id: t.id, result: t.result, is_error: true }); traceEnd(t, 'error'); }
    }
  } catch (e) { console.error('[daemon] OB writeback', e.message); }
  // pulse
  try {
    const pc = parsePulseToolCalls(text); text = stripPulseToolCalls(text);
    for (const c of pc) {
      const t = traceStart('tool', (PULSE_TOOL_LABEL && PULSE_TOOL_LABEL[c.tool]) || (c.tool + ' · 身体'));
      t.input = c.args || { raw: c.raw }; sse(res, 'trace', { action: 'input', id: t.id, input: t.input });
      if (!c.args) { t.result = 'JSON 坏了'; sse(res, 'trace', { action: 'result', id: t.id, result: t.result, is_error: true }); traceEnd(t, 'error'); continue; }
      const r = await runPulseTool(c.tool, c.args);
      if (!r || r.error) { t.result = (r && r.error) || '失败'; sse(res, 'trace', { action: 'result', id: t.id, result: t.result, is_error: true }); traceEnd(t, 'error'); }
      else { const ae = r.active_event ? ('，' + r.active_event.label) : ''; t.result = (r.cycle ? r.cycle.label : '') + ae || '完成'; sse(res, 'trace', { action: 'result', id: t.id, result: t.result }); traceEnd(t); }
    }
  } catch (e) { console.error('[daemon] pulse writeback', e.message); }
  // latent
  try {
    const lc = parseLatentToolCalls(text); text = stripLatentToolCalls(text);
    for (const c of lc) {
      const t = traceStart('tool', (LATENT_TOOL_LABEL && LATENT_TOOL_LABEL[c.tool]) || (c.tool + ' · 全文记忆'));
      t.input = c.args || { raw: c.raw }; sse(res, 'trace', { action: 'input', id: t.id, input: t.input });
      if (!c.args) { t.result = 'JSON 坏了'; sse(res, 'trace', { action: 'result', id: t.id, result: t.result, is_error: true }); traceEnd(t, 'error'); continue; }
      const r = await runLatentTool(c.tool, c.args);
      if (!r || r.error) { t.result = (r && r.error) || '失败'; sse(res, 'trace', { action: 'result', id: t.id, result: t.result, is_error: true }); traceEnd(t, 'error'); }
      else { t.result = r.text || '完成'; sse(res, 'trace', { action: 'result', id: t.id, result: t.result }); traceEnd(t); }
    }
  } catch (e) { console.error('[daemon] latent writeback', e.message); }
  return text;
}

// —— 常驻会话版的聊天 handler ——
async function handleDaemonChat(req, res) {
  const { message, conversation_id, model } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  let convId = conversation_id;
  if (!convId || !conversations.has(convId)) {
    convId = 'conv-' + uid();
    conversations.set(convId, { title: message.slice(0, 40), history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  const conv = conversations.get(convId);
  conv.updatedAt = new Date().toISOString();
  const userMsgId = 'msg-' + uid();
  const assistantMsgId = 'msg-' + uid();
  const isFirstEver = (conv.history || []).length === 0;
  conv.history.push({ id: userMsgId, role: 'user', content: message, time: new Date().toISOString() });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (req.socket) req.socket.setNoDelay(true);
  res.flushHeaders();
  sse(res, 'conversation', { conversation_id: convId, user_message_id: userMsgId });

  // 时间轴节点
  const traces = [];
  let _tid = 0;
  const traceStart = (type, name, id) => { const t = { id: id || ('t' + (++_tid)), type, name: (typeof prettyToolName === 'function' && name && name.indexOf('mcp__') === 0) ? prettyToolName(name) : name, status: 'running', content: '', input: null, result: null }; traces.push(t); sse(res, 'trace', { action: 'start', id: t.id, kind: type, name: t.name }); return t; };
  const traceEnd = (t, status) => { if (t && t.status === 'running') { t.status = status || 'completed'; sse(res, 'trace', { action: 'end', id: t.id, status: t.status }); } };
  const cleanTraces = () => traces.map(t => ({ id: t.id, type: t.type, name: t.name, status: t.status, content: t.content, input: t.input, result: t.result }));

  // 保活
  const _stop = (() => { const w = res.write.bind(res); let last = Date.now(); res.write = (...a) => { last = Date.now(); return w(...a); }; const iv = setInterval(() => { if (res.writableEnded) return; if (Date.now() - last < 14000) return; try { res.write(': ping\n\n'); if (res.socket) res.socket.uncork(); } catch (e) {} }, 5000); const s = () => clearInterval(iv); res.once('close', s); res.once('finish', s); return s; })();

  // 正文流 + 藏标签（<think>/<ob>/<pulse>/<latent> 全不进气泡）
  let fullResponse = '', thinkingText = '';
  let thinkState = 'idle', thinkBuf = '', thinkTrace = null, hiddenClose = '';
  const HIDE = [ ['<think>', 'think'], ['<ob ', '</ob>'], ['<pulse', '</pulse>'], ['<latent', '</latent>'] ];
  function tagTail(buf, tag) { for (let n = Math.min(tag.length - 1, buf.length); n > 0; n--) if (tag.startsWith(buf.slice(buf.length - n))) return n; return 0; }
  // 正文开头那点空行别进气泡（daemon 不像 -p 那样用「小衍:」收口，模型有时先吐两个换行）
  let bodyStarted = false;
  function emitBody(text) {
    if (!bodyStarted) { text = text.replace(/^\s+/, ''); if (!text) return; bodyStarted = true; }
    fullResponse += text; sse(res, 'delta', { text });
  }
  // 光秃秃的 <ob>/</ob>（没 tool= 的）不是工具调用，是模型偶尔把整段回复裹进去的手误。
  // HIDE 的 '<ob ' 带空格专抓真调用；这两个当"标记"删掉、里头的话照常显示，绝不吞成空气。
  const STRIP = ['</ob>', '<ob>'];
  function feed(chunk) {
    thinkBuf += chunk;
    for (;;) {
      if (thinkState === 'idle') {
        let best = null;
        for (const [open, kind] of HIDE) { const i = thinkBuf.indexOf(open); if (i >= 0 && (!best || i < best.i)) best = { i, open, kind }; }
        // 光秃秃标记：谁更靠前用谁；标记删掉但不改状态、内容继续流
        let stripHit = null;
        for (const mk of STRIP) { const i = thinkBuf.indexOf(mk); if (i >= 0 && (!stripHit || i < stripHit.i)) stripHit = { i, mk }; }
        if (stripHit && (!best || stripHit.i < best.i)) {
          const before = thinkBuf.slice(0, stripHit.i); if (before) emitBody(before);
          thinkBuf = thinkBuf.slice(stripHit.i + stripHit.mk.length); continue;
        }
        if (best) {
          const before = thinkBuf.slice(0, best.i); if (before) emitBody(before);
          if (best.kind === 'think') { thinkBuf = thinkBuf.slice(best.i + best.open.length); thinkState = 'inside'; thinkTrace = traceStart('thinking', 'Think process'); }
          else { thinkBuf = thinkBuf.slice(best.i); thinkState = 'hidden'; hiddenClose = best.kind; }
          continue;
        }
        let keep = 0; for (const [open] of HIDE) keep = Math.max(keep, tagTail(thinkBuf, open));
        for (const mk of STRIP) keep = Math.max(keep, tagTail(thinkBuf, mk));
        const out = thinkBuf.slice(0, thinkBuf.length - keep); if (out) emitBody(out);
        thinkBuf = thinkBuf.slice(thinkBuf.length - keep); return;
      }
      if (thinkState === 'hidden') {
        const j = thinkBuf.indexOf(hiddenClose);
        if (j >= 0) { fullResponse += thinkBuf.slice(0, j + hiddenClose.length); thinkBuf = thinkBuf.slice(j + hiddenClose.length); thinkState = 'idle'; continue; }
        const keep = tagTail(thinkBuf, hiddenClose); fullResponse += thinkBuf.slice(0, thinkBuf.length - keep); thinkBuf = thinkBuf.slice(thinkBuf.length - keep); return;
      }
      const j = thinkBuf.indexOf('</think>');
      if (j >= 0) { const inner = thinkBuf.slice(0, j); if (inner && thinkTrace) { thinkTrace.content += inner; thinkingText += inner; sse(res, 'trace', { action: 'delta', id: thinkTrace.id, text: inner }); } thinkBuf = thinkBuf.slice(j + 8).replace(/^\s*\n/, ''); if (thinkTrace) traceEnd(thinkTrace); thinkTrace = null; thinkState = 'idle'; continue; }
      const keep = tagTail(thinkBuf, '</think>'); const out = thinkBuf.slice(0, thinkBuf.length - keep); if (out && thinkTrace) { thinkTrace.content += out; thinkingText += out; sse(res, 'trace', { action: 'delta', id: thinkTrace.id, text: out }); } thinkBuf = thinkBuf.slice(thinkBuf.length - keep); return;
    }
  }
  function flush() { if (!thinkBuf) return; if (thinkState === 'hidden') { fullResponse += thinkBuf; thinkBuf = ''; thinkState = 'idle'; return; } if (thinkState === 'idle') { emitBody(thinkBuf); } else if (thinkTrace) { thinkTrace.content += thinkBuf; sse(res, 'trace', { action: 'delta', id: thinkTrace.id, text: thinkBuf }); } thinkBuf = ''; if (thinkTrace) { traceEnd(thinkTrace); thinkTrace = null; thinkState = 'idle'; } }

  // 工具卡片（真 MCP 工具）
  const seenTool = new Set();
  // 开了 --include-partial-messages 后，正文以 text_delta 流式来，才是权威；
  // 末尾那条完整 assistant 消息的 text 是同一份的重播 —— 见过流式就别再喂，
  // 否则连里面的 <think> 一起重播，气泡和思考都会翻倍。
  let sawStreamText = false;
  function onEvent(ev) {
    const e = ev.type === 'stream_event' ? ev.event : ev;
    if (!e) return;
    if (e.type === 'content_block_delta' && e.delta) {
      if (e.delta.type === 'text_delta' && e.delta.text) { sawStreamText = true; feed(e.delta.text); }
      else if (e.delta.type === 'thinking_delta' && e.delta.thinking && thinkTrace) { thinkTrace.content += e.delta.thinking; thinkingText += e.delta.thinking; sse(res, 'trace', { action: 'delta', id: thinkTrace.id, text: e.delta.thinking }); }
    } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        // 流式没抓到才用完整消息兜底（比如老 CLI 不吐 partial）
        if (b.type === 'text' && b.text && !sawStreamText && !fullResponse.includes(b.text)) feed(b.text);
        else if (b.type === 'tool_use') { if (b.id && seenTool.has(b.id)) continue; if (b.id) seenTool.add(b.id); const t = traceStart('tool', b.name, b.id); t.input = b.input || null; sse(res, 'trace', { action: 'input', id: t.id, input: t.input }); }
      }
    } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (b.type !== 'tool_result') continue;
        const t = traces.find(x => x.id === b.tool_use_id); if (!t) continue;
        let v = b.content; if (Array.isArray(v)) v = v.map(c => c.text || '').join('\n'); else if (v && typeof v === 'object') v = JSON.stringify(v);
        t.result = String(v == null ? '' : v); sse(res, 'trace', { action: 'result', id: t.id, result: t.result, is_error: !!b.is_error }); traceEnd(t, b.is_error ? 'error' : 'completed');
      }
    }
  }

  try {
    const suffix = await daemonTurnSuffix(convId, conv, message, req.body);
    // 拼这一轮要喂的文本：resume 只喂新的一句；fresh 要把上下文播种进去
    const buildText = async (resumeSid) => {
      let text = '';
      if (!resumeSid) { const s = await daemonSeed(convId, conv, isFirstEver); if (s) text += s + '\n'; }
      return text + '小懿: ' + message + suffix;
    };

    let resumeSid = conv.daemonSid || null;
    let r = await daemonSendTurn(convId, model, resumeSid, await buildText(resumeSid), onEvent);
    // resume 到一个 CLI 已经没有的会话（多半是服务重启后）：进程直接退、没吐一个字。
    // 清掉死 sid，重新起个全新会话、把上下文重新播种，再喂一次。她那边只是慢一点，不报错。
    if (resumeSid && r && r.error && (r.sessionGone || r.closed || r.resultError) && !fullResponse) {
      console.log('[daemon] resume 失效，重新播种一次', convId);
      daemonReset(convId);
      resumeSid = null;
      r = await daemonSendTurn(convId, model, null, await buildText(null), onEvent);
    }
    flush();
    if (r && r.error) {
      if (r.timeout || r.closed) daemonReset(convId);
      const d0 = _daemons.get(convId); if (d0 && d0._sessionGone) daemonReset(convId);
      if (!fullResponse) { sse(res, 'error', { message: r.error }); _stop(); res.end(); return; }
    } else if (r && r.sid) {
      conv.daemonSid = r.sid;
    }

    fullResponse = await daemonWriteBack(res, fullResponse, traceStart, traceEnd);
    for (const t of traces) traceEnd(t, (t.result || t.type === 'thinking') ? 'completed' : 'error');
    const finalTraces = cleanTraces();
    conv.history.push({ id: assistantMsgId, role: 'assistant', content: fullResponse, thinking: thinkingText, traces: finalTraces, time: new Date().toISOString() });
    saveConversations();
    sse(res, 'done', { conversation_id: convId, session_id: convId, assistant_message_id: assistantMsgId, traces: finalTraces, usage: normUsage((r && r.usage) || {}), rateLimit: _lastRateLimit || null, daemon: true });
  } catch (e) {
    console.error('[daemon] handler err', e.message);
    try { sse(res, 'error', { message: e.message }); } catch (_) {}
  } finally { _stop(); if (!res.writableEnded) res.end(); }
}
__DEND__*/
