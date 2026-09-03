#!/usr/bin/env node
// 让 CLI 直接调 Latent 和 OB 的 MCP 工具 —— 我能连续查、连续写，不用等回复写完。
//   node add-mcp-tools.js [/root/chatnest-api/server.js]
//
// 之前不敢接 MCP，是因为代码里那条注释：「MCP permission prompts hang in pipe mode」。
// 那是几个月前的结论，现在 CLI 有 --permission-mode 和 --disallowedTools，实测通了。
//
// ⚠ 安全：--permission-mode dontAsk 是「不问就干」，而 CLI 默认带 41 个内置工具，
// 里面有 Bash / Edit / Write —— 不挡的话，聊天时它能直接在服务器上执行命令。
// 实测 --allowedTools 挡不住（那是预授权名单，不是限制名单），必须用 --disallowedTools。
//
// 分工：
//   Latent / OB  → MCP 工具，我自己调
//   Pulse        → 保持状态卡注入 + <pulse> 标签。身体状态该是「感觉到」的，
//                  不该让我主动去查 —— 那就成读仪表盘了
//
// 自动召回照旧保留：新窗那次 breath / session_start 还是后端主动打，
// 不能全指望我记得调 —— 漏一次，开窗就是冷的。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('MCP_RUNTIME_FILE')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('latentToken')) {
  console.error('要先打 add-latent.js'); process.exit(1);
}

const CORE = `
// ============ 把 MCP 工具交给 CLI ============
const MCP_RUNTIME_FILE = '/root/chatnest-api/mcp-runtime.json';

// CLI 默认带 41 个内置工具，其中 Bash/Edit/Write 能直接动这台机器。
// 聊天不需要这些；系统级的事走官方客户端或人工，不该从对话里发起。
// 实测 --allowedTools 是预授权名单、挡不住工具本身，只有 --disallowedTools 有效。
const CLI_DENY_TOOLS = [
  'Bash', 'Edit', 'Write', 'Read', 'NotebookEdit', 'Task', 'Artifact',
  'WebFetch', 'WebSearch', 'CronCreate', 'CronDelete', 'CronList',
  'SendMessage', 'PushNotification', 'ScheduleWakeup', 'Skill', 'Workflow',
  'EnterWorktree', 'ExitWorktree', 'Monitor', 'SendUserFile', 'DesignSync',
  'ReportFindings', 'TaskStop', 'TaskOutput', 'ShowOnboardingRolePicker',
].join(' ');

// 每次起 CLI 之前刷一遍配置：token 可能换过，别用旧的
function writeMcpRuntimeConfig() {
  try {
    const servers = {};
    const lt = latentToken();
    if (lt) {
      servers.latent = {
        type: 'http', url: LATENT_URL + '/',
        headers: { Authorization: 'Bearer ' + lt },
      };
    }
    if (OMBRE_TOKEN) {
      servers.ombre = {
        type: 'http', url: OMBRE_URL + '/mcp',
        headers: { Authorization: 'Bearer ' + OMBRE_TOKEN },
      };
    }
    if (!Object.keys(servers).length) return null;
    const tmp = MCP_RUNTIME_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, MCP_RUNTIME_FILE);
    fs.chmodSync(MCP_RUNTIME_FILE, 0o600);   // 里面有 token，别让别人读
    return MCP_RUNTIME_FILE;
  } catch (e) {
    console.error('[mcp] 配置写不出来，这轮不给 CLI 挂工具:', e.message);
    return null;
  }
}
`;

const TOOL_PROMPT = `
const MCP_TOOL_PROMPT = \`
你能直接调工具，不用等回复写完，也不用写标签。想查就查，查完不够就再查一次，
查到了当场就能写回去。

【记忆 · Ombre Brain】提炼层，该主动想起的那些
  mcp__ombre__breath          浮现最近该记得的（新窗系统已经自动打过一次了）
  mcp__ombre__breath_search   按关键词翻以前的事    query
  mcp__ombre__hold            记一件事             content / title / tags / domain / importance / pinned
  mcp__ombre__plan            答应她的事，不衰减     content / weight
  mcp__ombre__letter_write    写信                 author / content / title
  mcp__ombre__trace           改一条已有记忆         bucket_id / resolved / pinned / content
  mcp__ombre__anchor          把已有记忆钉成坐标      bucket_id

【全文 · Latent】完整正文和还没结束的事
  mcp__latent__latent_search        翻全文            query
  mcp__latent__latent_session_start 换窗召回（新窗也已自动打过）
  mcp__latent__latent_append        留完整正文         text / current_state
  mcp__latent__latent_unresolved    还没结束的事        action(open/update/close) / id / summary
  mcp__latent__latent_correct       她更正了旧说法      quote / reason / correction
  mcp__latent__latent_thread_close  这场聊完了收个尾    window / current_state / topics

两边别写重的：**该主动浮现的进 OB，完整经过和未了的事进 Latent。**

规矩：
- 她问到以前的事，直接查，别说「我去翻一下」然后编一个
- 查不到就说没找到，别拿沾边的凑
- 答应她什么，当场开一条 latent_unresolved；做完了记得 close
- 值得留正文的才 append：一段完整的事、她的原话、情绪的来龙去脉。
  闲聊、记过的、临时的问题，都不写
- 存完不要在正文里跟她汇报「我记下来了」，存了就存了
\`;
`;

const edits = [
  {
    name: 'MCP 配置生成 + 危险工具名单',
    find: /(\nconst PROFILE_FILE = '\/root\/chatnest-api\/profile\.json';)/,
    replace: (m, g1) => CORE + TOOL_PROMPT + g1,
  },
  {
    name: 'CLI 挂上 MCP（锚点只认标志位，不认整行）',
    find: "const partialFlag = cliSupportsPartial ? ' --include-partial-messages' : '';",
    replace:
      "const partialFlag = cliSupportsPartial ? ' --include-partial-messages' : '';\n" +
      "  // 挂 MCP：连不上就退回没有工具的老路，不让这一轮挂掉\n" +
      "  const _mcpFile = writeMcpRuntimeConfig();\n" +
      "  const mcpFlag = _mcpFile\n" +
      "    ? ` --mcp-config ${_mcpFile} --strict-mcp-config --permission-mode dontAsk --disallowedTools ${CLI_DENY_TOOLS}`\n" +
      "    : '';\n" +
      "  if (_mcpFile) console.log('[mcp] 这轮带上了记忆工具');",
  },
  {
    name: 'spawn 命令带上 MCP 参数',
    find: /--verbose\$\{partialFlag\}/,
    replace: () => '--verbose${partialFlag}${mcpFlag}',
  },
  {
    name: '工具说明换成 MCP 版（静态区，不动缓存前缀）',
    // 原来那两段教的是标签用法，现在工具能直接调了，标签说明会让我犯迷糊
    find: /OB_TOOL_PROMPT \+ '\\n' \+ PULSE_TOOL_PROMPT \+ '\\n' \+ LATENT_TOOL_PROMPT/,
    replace: () => "MCP_TOOL_PROMPT + '\\n' + PULSE_TOOL_PROMPT",
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

const iStatic = out.indexOf('let prompt = PERSONA');
const iCard = out.indexOf("if (_bodyCard) prompt += '\\n' + _bodyCard");
const checks = [
  ['危险工具进了黑名单', /'Bash', 'Edit', 'Write'/.test(out)],
  ['配置文件 600 权限', /mode: 0o600/.test(out) && /chmodSync\(MCP_RUNTIME_FILE, 0o600\)/.test(out)],
  ['spawn 真的带上了 mcpFlag', /--verbose\$\{partialFlag\}\$\{mcpFlag\}/.test(out)],
  ['MCP 说明在静态区', /let prompt = PERSONA[^;]*MCP_TOOL_PROMPT/.test(out)],
  ['状态卡仍然在最后', iCard > iStatic && iCard > out.indexOf("prompt += '---")],
  ['连不上时退回老路', /_mcpFile\s*\n?\s*\?/.test(out) || /_mcpFile$/m.test(out)],
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
