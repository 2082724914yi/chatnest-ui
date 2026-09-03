#!/usr/bin/env node
// 补上消息编辑和对话分支的后端。
//   node add-edit-branches.js [/root/chatnest-api/server.js]
//
// 现状：前端早就在传 edit_message_id / retry_message_id 了，后端一个字没接。
// 结果是编辑一条消息时，前端把后面的消息从界面上删了，后端 conv.history 里还留着——
// 下一轮拼 prompt 那些幽灵消息照样进上下文，刷新页面它们还会回来。
// 这不是缺功能，是正在漏的 bug。
//
// 补三件事：
//   1. edit_message_id  → 截断到编辑点，被截掉的整段存成分支（不是删掉）
//   2. retry_message_id → 旧回复收进那条消息的 branches，新回复接上去
//   3. 分支的读取和切换接口，切换时把当前这条也存成分支，所以永远可逆
//
// 一条铁律：**永远不丢东西**。截断、重生成、切换，旧内容都先落盘再动手。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('BRANCH_DIR')) { console.log('已经打过，跳过'); process.exit(0); }

const CORE = `
// ============ 消息编辑与对话分支 ============
// 被换下来的对话不删，存这儿；切回去随时能拿。
const BRANCH_DIR = '/root/chatnest-api/branches';

function branchPath(convId, branchId) {
  const safe = String(convId || '').replace(/[^\\w-]/g, '');
  const bid = String(branchId || '').replace(/[^\\w-]/g, '');
  return require('path').join(BRANCH_DIR, safe, bid + '.json');
}

function saveBranch(convId, tail, meta) {
  try {
    const branchId = 'br-' + uid();
    const p = branchPath(convId, branchId);
    fs.mkdirSync(require('path').dirname(p), { recursive: true });
    // 先写临时文件再 rename：中途断电不会留下半个 JSON
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      id: branchId, conv_id: convId, saved_at: new Date().toISOString(),
      meta: meta || {}, messages: tail,
    }, null, 2));
    fs.renameSync(tmp, p);
    return branchId;
  } catch (e) {
    console.error('[branch] 存不下来:', e.message);
    return null;
  }
}

function loadBranch(convId, branchId) {
  try {
    const raw = fs.readFileSync(branchPath(convId, branchId), 'utf8');
    const v = JSON.parse(raw);
    return Array.isArray(v.messages) ? v : null;
  } catch (e) { return null; }
}

function listBranches(convId) {
  try {
    const dir = require('path').join(BRANCH_DIR, String(convId || '').replace(/[^\\w-]/g, ''));
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
      try {
        const v = JSON.parse(fs.readFileSync(require('path').join(dir, f), 'utf8'));
        return {
          id: v.id, saved_at: v.saved_at, count: (v.messages || []).length,
          fork_id: (v.meta || {}).fork_id,
          preview: String(((v.messages || [])[0] || {}).content || '').slice(0, 80),
        };
      } catch (e) { return null; }
    }).filter(Boolean).sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at)));
  } catch (e) { return []; }
}

// 编辑：从编辑点起的整段存成分支，然后截断。被编辑的那条本身也进分支，
// 因为切回去的时候要连它一起还原。
function forkForEdit(conv, convId, editId) {
  const idx = conv.history.findIndex(m => m && m.id === editId);
  if (idx < 0) return { ok: false, reason: 'not_found' };
  const tail = conv.history.slice(idx);
  const branchId = saveBranch(convId, tail, {
    fork_id: editId, kind: 'edit',
    original_content: String((tail[0] || {}).content || '').slice(0, 200),
  });
  if (!branchId) return { ok: false, reason: 'save_failed' };   // 存不下就不截断，宁可不动
  conv.history = conv.history.slice(0, idx);
  return { ok: true, branch_id: branchId, removed: tail.length };
}

// 重新生成：把那条回复连同它后面的都摘掉，旧内容收进 branches 待会儿跟新回复合并。
// 返回摘下来的那条，交给下面 push 的时候接上。
function forkForRetry(conv, convId, retryId) {
  const idx = conv.history.findIndex(m => m && m.id === retryId);
  if (idx < 0) return null;
  const tail = conv.history.slice(idx);
  saveBranch(convId, tail, { fork_id: retryId, kind: 'retry' });
  conv.history = conv.history.slice(0, idx);
  return tail[0] || null;
}

// 新回复落盘时把旧版本接上，这样前端那对 ‹ › 才有东西可切
function mergeRetryBranches(msg, oldMsg) {
  if (!oldMsg) return msg;
  const branches = Array.isArray(oldMsg.branches) && oldMsg.branches.length
    ? oldMsg.branches.slice()
    : [{ id: oldMsg.id, content: oldMsg.content, time: oldMsg.time }];
  branches.push({ id: msg.id, content: msg.content, time: msg.time });
  msg.branches = branches;
  msg.branch_idx = branches.length - 1;
  msg.branch_count = branches.length;
  return msg;
}
`;

const ROUTES = `
// ---- 分支接口 ----
app.get('/api/conversations/:id/branches', (req, res) => {
  res.json({ ok: true, branches: listBranches(req.params.id) });
});

app.get('/api/conversations/:id/branches/:branchId', (req, res) => {
  const b = loadBranch(req.params.id, req.params.branchId);
  if (!b) return res.status(404).json({ ok: false, error: '这条分支找不到了' });
  res.json({ ok: true, branch: b });
});

// 改一条消息的内容，不重新生成 —— 她要编辑我说过的话时走这条。
// 改之前先把原文存进 edits 里，改错了还找得回来。
app.patch('/api/conversations/:id/messages/:msgId', (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: '会话找不到了' });
  const msg = (conv.history || []).find(m => m && m.id === req.params.msgId);
  if (!msg) return res.status(404).json({ ok: false, error: '这条消息找不到了' });
  const next = String((req.body || {}).content || '');
  if (!next.trim()) return res.status(400).json({ ok: false, error: '内容不能是空的' });

  const edits = Array.isArray(msg.edits) ? msg.edits : [];
  edits.push({ content: msg.content, at: new Date().toISOString() });
  msg.edits = edits.slice(-20);
  msg.content = next;
  msg.edited = true;
  conv.updatedAt = new Date().toISOString();
  saveData();
  res.json({ ok: true, edited: true, history_count: edits.length });
});

// 切一条回复的第几个版本（重新生成产生的那些）。
// 前端只拿得到 branch_count，内容在后端，所以切换在这儿做完再把新内容回给它。
app.post('/api/conversations/:id/messages/:msgId/branch', (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: '会话找不到了' });
  // 切过版本之后 id 会跟着变，所以也要在 branches 里找，否则切一次就再也找不到这条
  const msg = (conv.history || []).find(m => m && (m.id === req.params.msgId ||
    (Array.isArray(m.branches) && m.branches.some(b => b && b.id === req.params.msgId))));
  if (!msg || !Array.isArray(msg.branches) || msg.branches.length < 2) {
    return res.status(404).json({ ok: false, error: '这条没有别的版本' });
  }
  const cur = Number.isInteger(msg.branch_idx) ? msg.branch_idx : msg.branches.length - 1;
  const body = req.body || {};
  let next = Number.isInteger(body.idx) ? body.idx : cur + (Number(body.dir) || 0);
  if (next < 0 || next >= msg.branches.length) next = cur;   // 到头了就不动

  const b = msg.branches[next] || {};
  msg.branch_idx = next;
  msg.content = b.content != null ? b.content : msg.content;
  if (b.id) msg.id = b.id;
  if (b.time) msg.time = b.time;
  msg.branch_count = msg.branches.length;
  conv.updatedAt = new Date().toISOString();
  saveData();
  res.json({ ok: true, id: msg.id, content: msg.content, idx: next, count: msg.branches.length });
});

// 切换：先把当前这段也存成分支，再换上目标分支 —— 所以来回切都不丢
app.post('/api/conversations/:id/branches/:branchId/switch', (req, res) => {
  const convId = req.params.id;
  const conv = conversations.get(convId);
  if (!conv) return res.status(404).json({ ok: false, error: '会话找不到了' });
  const target = loadBranch(convId, req.params.branchId);
  if (!target) return res.status(404).json({ ok: false, error: '这条分支找不到了' });

  const forkId = (target.meta || {}).fork_id;
  let idx = forkId ? conv.history.findIndex(m => m && m.id === forkId) : -1;
  if (idx < 0) idx = conv.history.length;   // 找不到分叉点就接在末尾，至少不丢东西

  const current = conv.history.slice(idx);
  if (current.length) saveBranch(convId, current, { fork_id: forkId, kind: 'switch_back' });

  conv.history = conv.history.slice(0, idx).concat(target.messages || []);
  conv.updatedAt = new Date().toISOString();
  saveData();
  res.json({ ok: true, restored: (target.messages || []).length, saved: current.length });
});
`;

const edits = [
  {
    name: '分支存取核心',
    find: /(\nconst PROFILE_FILE = '\/root\/chatnest-api\/profile\.json';)/,
    replace: (m, g1) => CORE + g1,
  },
  {
    name: '编辑/重生成：先分叉再落这一轮',
    // 必须在 push 用户消息之前动手，否则新消息会被一起截掉
    find: "  conv.history.push({ id: userMsgId, role: 'user', content: message, time: new Date().toISOString() });",
    replace:
      "  // 前端传了 edit/retry 就先分叉：被换下来的整段存成分支，再截断历史。\n" +
      "  // 不接的话前端删了界面、后端还留着，那些幽灵消息下一轮照样进上下文。\n" +
      "  let _retriedMsg = null;\n" +
      "  try {\n" +
      "    if (req.body.edit_message_id) {\n" +
      "      const r = forkForEdit(conv, convId, req.body.edit_message_id);\n" +
      "      console.log('[branch] 编辑分叉:', req.body.edit_message_id, r.ok ? ('存了 ' + r.removed + ' 条') : r.reason);\n" +
      "    } else if (req.body.retry_message_id) {\n" +
      "      _retriedMsg = forkForRetry(conv, convId, req.body.retry_message_id);\n" +
      "      console.log('[branch] 重新生成:', req.body.retry_message_id, _retriedMsg ? '旧回复已收好' : '没找到那条');\n" +
      "    }\n" +
      "  } catch (e) { console.error('[branch] 分叉失败，这轮按普通消息处理:', e.message); }\n" +
      "  // 重新生成不重复记用户消息 —— 用户那句原本就还在历史里\n" +
      "  if (!req.body.retry_message_id) conv.history.push({ id: userMsgId, role: 'user', content: message, time: new Date().toISOString() });",
  },
  {
    name: '新回复接上旧版本（中转站路径）',
    find: "      conv.history.push({ id: assistantMsgId, role: 'assistant', content: fullResponse, traces: cleanTraces(), time: new Date().toISOString() });",
    replace: "      conv.history.push(mergeRetryBranches({ id: assistantMsgId, role: 'assistant', content: fullResponse, traces: cleanTraces(), time: new Date().toISOString() }, _retriedMsg));",
  },
  {
    name: '新回复接上旧版本（CC 订阅路径）',
    find: "    conv.history.push({ id: assistantMsgId, role: 'assistant', content: fullResponse, thinking: thinkingText, traces: finalTraces, time: new Date().toISOString() });",
    replace: "    conv.history.push(mergeRetryBranches({ id: assistantMsgId, role: 'assistant', content: fullResponse, thinking: thinkingText, traces: finalTraces, time: new Date().toISOString() }, _retriedMsg));",
  },
  {
    name: '分支接口',
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

const checks = [
  ['分叉在落用户消息之前', out.indexOf('forkForEdit(conv, convId') < out.indexOf("if (!req.body.retry_message_id) conv.history.push({ id: userMsgId")],
  ['存不下就不截断', /if \(!branchId\) return \{ ok: false, reason: 'save_failed' \}/.test(out)],
  ['两条路径都接上了旧版本', (out.match(/mergeRetryBranches\(/g) || []).length >= 3],
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
