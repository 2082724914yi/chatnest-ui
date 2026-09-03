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
  // WebSearch 放行：它回的是标题/链接/摘要，结构化、面窄。
  // WebFetch 继续挡：那是把整页网页塞进上下文，网页里可能藏着写给 AI 的指令。
  'WebFetch', 'CronCreate', 'CronDelete', 'CronList',
  'SendMessage', 'PushNotification', 'ScheduleWakeup', 'Skill', 'Workflow',
  'EnterWorktree', 'ExitWorktree', 'Monitor', 'SendUserFile', 'DesignSync',
  'ReportFindings', 'TaskStop', 'TaskOutput', 'ShowOnboardingRolePicker',
].join(' ');

// 时间轴上显示的名字。原名是 mcp__latent__latent_search 这种，直接摆出来没法看。
const MCP_TOOL_LABEL = {
  'mcp__ombre__breath': '浮现记忆 · OB',
  'mcp__ombre__breath_search': '翻记忆 · OB',
  'mcp__ombre__breath_advanced': '细查记忆 · OB',
  'mcp__ombre__hold': '记下来 · OB',
  'mcp__ombre__grow': '整理记忆 · OB',
  'mcp__ombre__plan': '记下承诺 · OB',
  'mcp__ombre__letter_write': '写信 · OB',
  'mcp__ombre__letter_read': '翻信 · OB',
  'mcp__ombre__trace': '改记忆 · OB',
  'mcp__ombre__anchor': '钉成坐标 · OB',
  'mcp__ombre__release': '解除坐标 · OB',
  'mcp__ombre__feel': '记下感受 · OB',
  'mcp__ombre__pulse': '记忆概况 · OB',
  'mcp__ombre__dream': '梦 · OB',
  'mcp__latent__latent_search': '翻全文 · Latent',
  'mcp__latent__latent_session_start': '换窗召回 · Latent',
  'mcp__latent__latent_append': '留下正文 · Latent',
  'mcp__latent__latent_unresolved': '还没结束的事 · Latent',
  'mcp__latent__latent_correct': '更正旧说法 · Latent',
  'mcp__latent__latent_thread_close': '收尾这一场 · Latent',
  'mcp__latent__latent_cleanup': '清理误写 · Latent',
  'WebSearch': '搜一下 · 网络',
  'ToolSearch': '找工具',
};
function prettyToolName(name) {
  const n = String(name || 'tool');
  if (MCP_TOOL_LABEL[n]) return MCP_TOOL_LABEL[n];
  // 兜底：没登记过的 mcp__服务__工具 也别把下划线摆出来
  const m = n.match(/^mcp__([^_]+)__(.+)$/);
  return m ? (m[2].replace(/_/g, ' ') + ' · ' + m[1]) : n;
}

// 直接给 spawn 用的一串参数。做成函数是为了不用在 spawn 之前另插一段变量定义 ——
// 那样又要多一个锚点，多一个会漂的地方。
function mcpArgs() {
  const f = writeMcpRuntimeConfig();
  if (!f) return '';   // 配置写不出来就退回没有工具的老路，不让这一轮挂掉
  console.log('[mcp] 这轮带上了记忆工具');
  return \` --mcp-config \${f} --strict-mcp-config --permission-mode dontAsk --disallowedTools \${CLI_DENY_TOOLS}\`;
}

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
    // 不写死中间那些标志位 —— 线上和仓库版不一样，写死一次就得改一次。
    // 只要求 claude -p 和 --output-format stream-json 在同一段命令里。
    name: 'spawn 命令带上 MCP 参数',
    find: /(\/usr\/bin\/claude -p[^`]*?)( --output-format stream-json)/,
    replace: (m, head, tail) => head + '${mcpArgs()}' + tail,
  },
  {
    // 两处都是 traceStart('tool', X.name || 'tool', X.id)，一条正则收掉
    name: '时间轴上显示人话，不显示 mcp__ 原名',
    find: /traceStart\('tool', (cb|block)\.name \|\| 'tool'/g,
    replace: (m, v) => "traceStart('tool', prettyToolName(" + v + ".name)",
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
  ['spawn 真的带上了 MCP 参数', /claude -p[^`]*\$\{mcpArgs\(\)\}[^`]*--output-format stream-json/.test(out)],
  ['工具名做了美化', /prettyToolName\(/.test(out)],
  ['WebSearch 放行了', !/'WebSearch'/.test(out.split('CLI_DENY_TOOLS')[1].split(']')[0])],
  ['MCP 说明在静态区', /let prompt = PERSONA[^;]*MCP_TOOL_PROMPT/.test(out)],
  ['状态卡仍然在最后', iCard > iStatic && iCard > out.indexOf("prompt += '---")],
  ['配置写不出来时退回老路', /if \(!f\) return '';/.test(out)],
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
