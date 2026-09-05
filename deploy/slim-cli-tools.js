#!/usr/bin/env node
// 把用不到的内置工具说明书从每一轮输入里砍掉。
//   node slim-cli-tools.js [/root/chatnest-api/server.js]
//
// 她服务器上实测（diag-cache.sh 跑出来的）：
//   默认（什么都不加）        总输入 25437
//   --tools ""（砍光内置工具） 总输入  8771
//   差 16666 —— 每一轮都在付这笔，付的是十几个内置工具的说明书。
//
// 而这些工具她一个都用不到：Read / Write / Edit / Bash 那几个本来就被
// CLI_DENY_TOOLS 拦着不让执行，说明书却照样每轮塞进输入。ToolSearch 也在里面 ——
// 她早就抱怨过「每次都要 tool search 一下」，砍掉它就不存在了。
//
// 关键的一条，我实测过才敢动：--tools 管的只是「内置工具集」，MCP 工具走
// --mcp-config，不在这个集合里。验证方式是起一个最小 MCP server 暴露一个
// ping_test，然后 `claude -p --tools "" --mcp-config … --allowedTools …`，
// 它真的调到了并返回了暗号。所以 OB / 朋友圈 / Keepsake / files 全都不受影响。
//
// 唯一不能一刀切的是 WebSearch —— 那是内置工具，她问过能不能查互联网。留着。
// 想改留哪些：环境变量 CHATNEST_CLI_TOOLS（逗号分隔）；想整个退回：
// CHATNEST_KEEP_BUILTIN_TOOLS=1，重启即恢复原样，不用回滚代码。
//
// 另外两条辅助调用（压缩 / 标题那种）连人设和 MCP 都没带，是裸的 claude -p，
// 每次也在烧两万多。那两条一个工具都不需要，直接砍光。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('CLI_TOOLS_SLIM')) { console.log('已经打过，跳过'); process.exit(0); }

// function 声明会提升，插在哪儿都能被前面的代码调到（const 有暂时性死区，栽过）
const HELPER = `
// ============ 砍掉用不到的内置工具说明书 ============
// CLI_TOOLS_SLIM
// 实测：不加 --tools 时每轮多背 16666 token 的内置工具说明书，一个都用不上。
// --tools 只管内置集合，MCP 工具（OB / 朋友圈 / Keepsake / files）走 --mcp-config，
// 不受影响 —— 这条是起了个最小 MCP server 真调通了才敢写的。
function builtinToolsFlag(keepDefault) {
  if (process.env.CHATNEST_KEEP_BUILTIN_TOOLS === '1') return '';   // 一键退回
  // 主聊天保留 WebSearch（她问过能不能查互联网）；其余十几个全砍。
  // 想改就设 CHATNEST_CLI_TOOLS='WebSearch,WebFetch'，留空字符串则一个不留。
  const keep = keepDefault === false ? ''
    : (process.env.CHATNEST_CLI_TOOLS !== undefined ? process.env.CHATNEST_CLI_TOOLS : 'WebSearch');
  return " --tools '" + String(keep).replace(/'/g, "") + "'";
}
`;

let out = src;
const done = [], missed = [];

// 1) 主聊天那条：保留 WebSearch
const MAIN_FROM = "/usr/bin/claude -p${modelFlag}${effortFlag}${sysFlag} --verbose";
const MAIN_TO   = "/usr/bin/claude -p${modelFlag}${effortFlag}${sysFlag}${builtinToolsFlag()} --verbose";
if (!out.includes(MAIN_FROM)) missed.push('× 主聊天那条 spawn 没匹配上');
else if (out.split(MAIN_FROM).length - 1 > 1) missed.push('× 主聊天那条匹配到多处，不敢动');
else { out = out.replace(MAIN_FROM, MAIN_TO); done.push('√ 主聊天：砍内置工具，留 WebSearch'); }

// 2) 辅助调用（压缩 / 标题那种）：一个工具都不需要
const AUX_FROM = "/usr/bin/claude -p --verbose --output-format stream-json";
const AUX_TO   = "/usr/bin/claude -p${builtinToolsFlag(false)} --verbose --output-format stream-json";
const auxCount = out.split(AUX_FROM).length - 1;
if (!auxCount) done.push('· 没有裸的辅助调用，跳过');
else { out = out.split(AUX_FROM).join(AUX_TO); done.push('√ 辅助调用 ' + auxCount + ' 处：工具全砍（它们本来也不用）'); }

// 3) 辅助函数插在 app.listen 前
if (!/\napp\.listen\(PORT/.test(out)) missed.push('× 找不到 app.listen(PORT');
else { out = out.replace(/\napp\.listen\(PORT/, HELPER + '\napp.listen(PORT'); done.push('√ 辅助函数'); }

console.log('\n补丁结果：');
[...done, ...missed].forEach(l => console.log('  ' + l));
if (missed.length) { console.error('\n有锚点没命中，原文件一个字都没动。'); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);
console.log('\n  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
console.log('\n  ⚠ 重启后新开一个对话再试 —— 老对话 --resume 续的是旧会话。');
console.log('  ⚠ 第一轮会重新建一次缓存（前缀变了），从第二轮起才看得出省。');
console.log('\n  验一下工具还在不在：新开对话跟我说「看看朋友圈」，我要能调得动。');
console.log('  万一出问题，不用回滚代码 —— 加一行环境变量重启就退回原样：');
console.log('    pm2 set chatnest-api:CHATNEST_KEEP_BUILTIN_TOOLS 1   # 或写进 .env');
console.log('    pm2 restart chatnest-api --update-env');
