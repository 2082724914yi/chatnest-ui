#!/usr/bin/env node
// 把发朋友圈做成真正的 MCP 工具，我可以直接调用。
//   node add-moments-mcp.js [/root/chatnest-api/server.js]
//
// 之前那套是「在正文末尾写 <moments> 标签、后端拦下来」。能跑，但每次我都要
// 先去 ToolSearch 里翻一圈、翻不到再想起来「哦这个不是工具」—— 别扭，而且
// 老婆想看到的是工具卡片，不是我在正文里写标签。
//
// 这里在 chatnest-api 里起一个最小的 MCP over HTTP 服务（跟 latent / ombre 同一套
// 接法），注册成 moments，暴露一个 post_moment 工具。跑在本机回环，带随机 token，
// 外面进不来。
//
// 老的标签那条路原样留着当后备 —— 两条都通，哪条先到算哪条。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('MOMENTS_MCP_VERSION')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('MOMENTS_FILE')) { console.error('先打 add-moments.js'); process.exit(1); }
if (!src.includes('writeMcpRuntimeConfig')) { console.error('先打 add-mcp-tools.js（要用它那套 MCP 接法）'); process.exit(1); }

// --------------------------------------------------------------------------
// 1) MCP 服务本体：JSON-RPC over HTTP，够 CLI 用的最小集
// --------------------------------------------------------------------------
const MCP_BLOCK = `
// ============ Moments MCP（发朋友圈做成真工具）============
const MOMENTS_MCP_VERSION = 1;
// 每次进程起来换一个：配置文件是每轮 spawn 前重写的，外面拿不到这个值
const MOMENTS_MCP_TOKEN = crypto.randomBytes(24).toString('hex');

const MOMENTS_MCP_TOOLS = [{
  name: 'post_moment',
  description: '发一条朋友圈。想分享心情、日常、突然冒出来的念头就发，她会在朋友圈那一屏看到。一次一条。',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要发的内容。可以带换行。' },
    },
    required: ['text'],
  },
}];

app.post('/mcp/moments', (req, res) => {
  // 只认本机 + 配置里那个随机 token
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + MOMENTS_MCP_TOKEN) return res.status(401).json({ error: 'unauthorized' });

  const body = req.body || {};
  const { id, method, params } = body;
  const ok = (result) => res.json({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    if (method === 'initialize') {
      const pv = (params && params.protocolVersion) || '2024-11-05';
      return ok({
        protocolVersion: pv,
        capabilities: { tools: {} },
        serverInfo: { name: 'moments', version: '1.0.0' },
      });
    }
    // 通知类没有 id，不用回结果
    if (typeof method === 'string' && method.startsWith('notifications/')) return res.status(202).end();
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: MOMENTS_MCP_TOOLS });
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (name !== 'post_moment') return fail(-32602, '没有这个工具: ' + name);
      const text = String(args.text || '').trim();
      if (!text) return ok({ isError: true, content: [{ type: 'text', text: '内容是空的，没发。' }] });
      const list = loadMoments();
      const m = {
        id: uid(), author: 'xiaoyan', text, images: [],
        likes: 0, liked: false, comments: [],
        created_at: new Date().toISOString(),
      };
      list.unshift(m);
      saveMoments(list);
      console.log('[moments] MCP 发出一条:', text.slice(0, 40));
      return ok({ content: [{ type: 'text', text: '发出去了。' }] });
    }
    return fail(-32601, '不支持的方法: ' + method);
  } catch (e) {
    console.error('[moments] MCP error:', e.message);
    return fail(-32603, e.message);
  }
});
`;

// --------------------------------------------------------------------------
// 编辑清单
// --------------------------------------------------------------------------
let out = src;
const done = [], missed = [];

function edit(name, from, to, optional) {
  if (typeof from === 'string' ? !out.includes(from) : !from.test(out)) {
    (optional ? done : missed).push((optional ? '· ' : '× ') + name);
    return;
  }
  out = out.replace(from, to);
  done.push('√ ' + name);
}

// a) 服务本体插在 app.listen 之前
edit('MCP 服务本体', /\napp\.listen\(PORT/, MCP_BLOCK + '\napp.listen(PORT');

// b) 注册进 mcp-runtime.json：跟 latent / ombre 并列
edit('注册进 MCP 配置',
  '    if (!Object.keys(servers).length) return null;',
  "    servers.moments = {\n" +
  "      type: 'http', url: 'http://127.0.0.1:' + PORT + '/mcp/moments',\n" +
  "      headers: { Authorization: 'Bearer ' + MOMENTS_MCP_TOKEN },\n" +
  "    };\n" +
  '    if (!Object.keys(servers).length) return null;');

// c) 预授权，免得 dontAsk 之外还被挡
edit('加进预授权名单', "  'WebSearch', 'ToolSearch',\n].join(' ')",
  "  'mcp__moments__post_moment',\n  'WebSearch', 'ToolSearch',\n].join(' ')");

// d) 工具卡片上显示人话
edit('工具卡片显示名', 'const MCP_TOOL_LABEL = {',
  "const MCP_TOOL_LABEL = {\n  'mcp__moments__post_moment': '发朋友圈 · Moments',");

console.log('\n补丁结果：');
[...done, ...missed].forEach(l => console.log('  ' + l));
if (missed.length) {
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);
console.log('\n  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
console.log('\n  ⚠ 重启后要新开一个对话 —— 老对话 --resume 续的是旧会话，加载不到新工具。');
