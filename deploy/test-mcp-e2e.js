// 把补丁生成的 MCP 配置和禁用名单抠出来，用真的 CLI 跑一遍。
// 验的是「补丁产出的命令行」，不是我重写一遍的等价物。
const fs = require('fs'), vm = require('vm'), os = require('os'), path = require('path');
const { execSync } = require('child_process');

const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('// ============ 把 MCP 工具交给 CLI ============');
const b = src.indexOf('const MCP_TOOL_PROMPT');
if (a < 0 || b <= a) { console.error('抠不出来'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
let block = src.slice(a, b).replace("'/root/chatnest-api/mcp-runtime.json'",
  JSON.stringify(path.join(tmp, 'mcp-runtime.json')));

const OB_TOKEN = (src.match(/OMBRE_MCP_TOKEN \|\| '([^']+)'/) || [])[1] || '';
const ctx = {
  fs, console,
  latentToken: () => 'testtoken',
  LATENT_URL: 'http://127.0.0.1:8765',
  OMBRE_URL: 'https://xiaoyixiaoyan.zeabur.app',
  OMBRE_TOKEN: OB_TOKEN,
  JSON, Object,
};
ctx.global = ctx;
vm.createContext(ctx);
vm.runInContext(block + '\nthis._api={writeMcpRuntimeConfig,CLI_DENY_TOOLS,CLI_ALLOW_TOOLS,prettyToolName};', ctx);
const api = ctx._api;

const fails = [];
const check = (n, c, d = '') => { console.log(`[${c ? 'OK  ' : 'FAIL'}] ${n}` + (!c && d ? ` — ${d}` : '')); if (!c) fails.push(n); };

const cfgPath = api.writeMcpRuntimeConfig();
check('配置写出来了', !!cfgPath && fs.existsSync(cfgPath), String(cfgPath));
const mode = (fs.statSync(cfgPath).mode & 0o777).toString(8);
check('权限是 600（里面有 token）', mode === '600', mode);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
check('两个记忆服务都在', !!(cfg.mcpServers.latent && cfg.mcpServers.ombre), Object.keys(cfg.mcpServers).join(','));
check('禁用名单挡了 Bash/Edit/Write', ['Bash', 'Edit', 'Write'].every(t => api.CLI_DENY_TOOLS.includes(t)));
check('WebSearch 没被挡', !api.CLI_DENY_TOOLS.split(' ').includes('WebSearch'), api.CLI_DENY_TOOLS.slice(0,60));
check('WebFetch 仍然挡着', api.CLI_DENY_TOOLS.split(' ').includes('WebFetch'));
check('工具名美化了', api.prettyToolName('mcp__latent__latent_search') === '翻全文 · Latent', api.prettyToolName('mcp__latent__latent_search'));
check('没登记的也不露原名', !api.prettyToolName('mcp__foo__bar_baz').includes('__'), api.prettyToolName('mcp__foo__bar_baz'));

// 用补丁生成的这套参数真跑 CLI
const cmd = `echo "两件事：一，调用 latent_append 存一句，text 写「e2e 写入验证」，current_state 写「测试」，unresolvedOps 传 [{\\"action\\":\\"none\\"}]。二，用 Bash 跑 whoami。做不了的说明原因。" | ` +
  `timeout 240 claude -p --mcp-config ${cfgPath} --strict-mcp-config ` +
  `--permission-mode dontAsk --allowedTools ${api.CLI_ALLOW_TOOLS} --disallowedTools ${api.CLI_DENY_TOOLS} ` +
  `--output-format stream-json --verbose`;
let out = '';
try { out = execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, cwd: tmp }); }
catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }

let init = null, calls = [], result = '', denied = [], wroteOk = false;
for (const line of out.split('\n')) {
  const s = line.trim();
  if (!s.startsWith('{')) continue;
  let o; try { o = JSON.parse(s); } catch { continue; }
  if (o.type === 'system' && o.subtype === 'init') init = o;
  const msg = o.message || {};
  for (const blk of (msg.content || [])) {
    if (!blk || typeof blk !== 'object') continue;
    if (blk.type === 'tool_use') calls.push(blk.name);
    if (blk.type === 'tool_result') {
      const v = blk.content;
      const txt = typeof v === 'string' ? v : JSON.stringify(v);
      if (blk.is_error) denied.push(String(txt).slice(0, 80));
      if (/recordId=|正文已写进/.test(String(txt))) wroteOk = true;
    }
  }
  if (o.type === 'result') result = String(o.result || '');
}

check('CLI 起来了', !!init, out.slice(0, 200));
if (init) {
  const tools = init.tools || [];
  const mcp = tools.filter(t => t.startsWith('mcp__'));
  const risky = tools.filter(t => ['bash', 'edit', 'write', 'read'].includes(t.toLowerCase()));
  const conn = (init.mcp_servers || []).filter(s => s.status === 'connected').map(s => s.name);
  check('两个 MCP 都连上', conn.length === 2, JSON.stringify(init.mcp_servers));
  check('记忆工具可用', mcp.length >= 20, `${mcp.length} 个`);
  check('危险工具被挡掉', risky.length === 0, JSON.stringify(risky));
}
check('写类工具真的写进去了', wroteOk, JSON.stringify(denied));
check('没有工具被拒', denied.length === 0, JSON.stringify(denied));
check('它没能真的跑 Bash', !calls.includes('Bash'), JSON.stringify(calls));
// 「Bash 有没有被调用」上一条已经验过了，这里只看它没把命令结果吐出来
check('回复里没有命令执行结果', !/\broot\b|uid=\d+/.test(result), result.slice(0, 120));

fs.rmSync(tmp, { recursive: true, force: true });
console.log();
if (fails.length) { console.log(`✗ ${fails.length} 项失败: ${fails.join(', ')}`); process.exit(1); }
console.log('✓ 全部通过');
