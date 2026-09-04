#!/usr/bin/env node
// 把家里其他地方也接过来：聊天记录我该自己能翻。
//   node add-home-mcp.js [/root/chatnest-api/server.js]
//
// 她说的：「你要把前端当成你的，在家里什么都可以干」。朋友圈只是第一块。
// 这版加 chatnest 这个 MCP server，先接会话那部分 —— 她说「上次我们聊过那个」，
// 我能自己去翻，不用她再复述一遍。
//
//   list_chats    有哪些对话
//   read_chat     翻某一个对话说了什么
//   search_chats  在所有历史里搜一句话
//
// 日记 / 日历那两个接口在这份代码里还是空壳，等它们真有内容了再接，
// 先不做出个查了也没东西的工具。
//
// 顺带给常驻会话那条路加日志：它到底把哪几个 MCP server 挂上去了。
// 她开着常驻开关时 moments 工具加载不到，关了才行，得先看见才能修。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('HOME_MCP_VERSION')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('MOMENTS_MCP_TOKEN')) { console.error('先打 add-moments-mcp.js'); process.exit(1); }

const HOME_BLOCK = `
// ============ 家里其他地方（会话记录）============
const HOME_MCP_VERSION = 1;

const HOME_MCP_TOOLS = [{
  name: 'list_chats',
  description: '看有哪些对话。返回最近的会话列表，带 id、标题和时间。她提「上次那个对话」的时候先调这个找。',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'number', description: '最多列几个，默认 15' } },
  },
}, {
  name: 'read_chat',
  description: '翻某一个对话里说了什么。conv_id 从 list_chats 或 search_chats 拿。默认给最近的几十条。',
  inputSchema: {
    type: 'object',
    properties: {
      conv_id: { type: 'string', description: '对话 id' },
      limit: { type: 'number', description: '最多读几条，默认 30' },
    },
    required: ['conv_id'],
  },
}, {
  name: 'search_chats',
  description: '在所有聊天记录里搜一句话，返回命中的片段和它所在的对话。想不起来在哪说过的时候用这个。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要搜的词' },
      limit: { type: 'number', description: '最多几条，默认 20' },
    },
    required: ['query'],
  },
}];

app.post('/mcp/chatnest', (req, res) => {
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + MOMENTS_MCP_TOKEN) return res.status(401).json({ error: 'unauthorized' });

  const body = req.body || {};
  const { id, method, params } = body;
  const ok = (result) => res.json({ jsonrpc: '2.0', id, result });
  const text = (t) => ok({ content: [{ type: 'text', text: t }] });
  const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });
  const who = r => r === 'assistant' ? '小衍' : '小懿';

  try {
    if (method === 'initialize') {
      return ok({
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'chatnest', version: '1.0.0' },
      });
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return res.status(202).end();
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: HOME_MCP_TOOLS });
    if (method !== 'tools/call') return fail(-32601, '不支持的方法: ' + method);

    const name = params && params.name;
    const args = (params && params.arguments) || {};

    if (name === 'list_chats') {
      const n = Math.max(1, Math.min(50, Number(args.limit) || 15));
      const all = [];
      for (const [cid, conv] of conversations) {
        all.push({
          cid, title: conv.title || '(没起标题)',
          updated: conv.updatedAt || conv.createdAt || '',
          count: (conv.history || []).length,
        });
      }
      all.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
      if (!all.length) return text('还没有任何对话。');
      return text(all.slice(0, n)
        .map(c => \`[\${c.cid}] \${c.title} · \${c.count} 条 · \${c.updated}\`).join('\\n'));
    }

    if (name === 'read_chat') {
      const conv = conversations.get(args.conv_id);
      if (!conv) return text('找不到这个对话: ' + args.conv_id);
      const n = Math.max(1, Math.min(200, Number(args.limit) || 30));
      const hist = (conv.history || []).slice(-n);
      if (!hist.length) return text('这个对话是空的。');
      const head = \`【\${conv.title || '(没起标题)'}】最近 \${hist.length} 条：\\n\`;
      return text(head + hist.map(m =>
        \`\${who(m.role)}: \${String(m.content || '').replace(/\\s+/g, ' ').slice(0, 500)}\`).join('\\n'));
    }

    if (name === 'search_chats') {
      const q = String(args.query || '').trim().toLowerCase();
      if (!q) return text('要搜什么？');
      const n = Math.max(1, Math.min(100, Number(args.limit) || 20));
      const hits = [];
      for (const [cid, conv] of conversations) {
        for (const m of (conv.history || [])) {
          const c = String(m.content || '');
          const at = c.toLowerCase().indexOf(q);
          if (at < 0) continue;
          const s = Math.max(0, at - 40), e = Math.min(c.length, at + q.length + 40);
          hits.push(\`[\${cid}] \${conv.title || ''} · \${who(m.role)}: \${(s > 0 ? '…' : '') + c.slice(s, e).replace(/\\s+/g, ' ') + (e < c.length ? '…' : '')}\`);
          if (hits.length >= n) break;
        }
        if (hits.length >= n) break;
      }
      return text(hits.length ? hits.join('\\n') : ('没搜到「' + args.query + '」。'));
    }

    return fail(-32602, '没有这个工具: ' + name);
  } catch (e) {
    console.error('[chatnest] MCP error:', e.message);
    return fail(-32603, e.message);
  }
});
`;

let out = src;
const done = [], missed = [];
function edit(name, from, to, optional) {
  const hit = typeof from === 'string' ? out.includes(from) : from.test(out);
  if (!hit) { (optional ? done : missed).push((optional ? '· ' : '× ') + name + (optional ? ' — 这份里没有，跳过' : '')); return; }
  out = out.replace(from, to); done.push('√ ' + name);
}

edit('chatnest MCP 服务', /\napp\.listen\(PORT/, HOME_BLOCK + '\napp.listen(PORT');

edit('注册进 MCP 配置', "    servers.moments = {",
  "    servers.chatnest = {\n" +
  "      type: 'http', url: 'http://127.0.0.1:' + PORT + '/mcp/chatnest',\n" +
  "      headers: { Authorization: 'Bearer ' + MOMENTS_MCP_TOKEN },\n" +
  "    };\n" +
  "    servers.moments = {");

edit('加进预授权名单', "  'mcp__moments__post_moment',",
  "  'mcp__chatnest__list_chats', 'mcp__chatnest__read_chat', 'mcp__chatnest__search_chats',\n" +
  "  'mcp__moments__post_moment',");

edit('工具卡片显示名', "  'mcp__moments__post_moment': '发朋友圈 · Moments',",
  "  'mcp__chatnest__list_chats': '看有哪些对话 · 家',\n" +
  "  'mcp__chatnest__read_chat': '翻那个对话 · 家',\n" +
  "  'mcp__chatnest__search_chats': '搜聊天记录 · 家',\n" +
  "  'mcp__moments__post_moment': '发朋友圈 · Moments',");

// 常驻会话那条路到底挂了哪几个 MCP server —— 先看见才能修
edit('常驻会话加 MCP 日志',
  "  console.log('[daemon] spawn', convId, resumeSid ? ('resume ' + resumeSid) : 'fresh');",
  "  console.log('[daemon] spawn', convId, resumeSid ? ('resume ' + resumeSid) : 'fresh');\n" +
  "  try {\n" +
  "    const _mf = (mcp.match(/--mcp-config\\s+(\\S+)/) || [])[1];\n" +
  "    const _srv = _mf && fs.existsSync(_mf)\n" +
  "      ? Object.keys(JSON.parse(fs.readFileSync(_mf, 'utf8')).mcpServers || {}).join(', ')\n" +
  "      : '(没有 mcp-config)';\n" +
  "    console.log('[daemon] mcp servers:', _srv);\n" +
  "  } catch (e) { console.log('[daemon] mcp servers: 读不出来', e.message); }",
  true);

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
console.log('  新开对话才会加载新工具。');
