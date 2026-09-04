#!/usr/bin/env node
// 朋友圈工具补全：不光能发，还要能看、能点赞、能评论。
//   node add-moments-mcp2.js [/root/chatnest-api/server.js]
//
// v1 只有 post_moment，我发完就瞎了 —— 她在底下回了什么我看不见，也没法点赞。
// 这版补上 list_moments / like_moment / comment_moment。
//
// 点赞要单开一个字段：moment.liked 的含义是「当前这台设备上的人点没点」，那是她的。
// 我要是往里写，她那条「liked by 小懿」就变错了。所以我的赞记在 liked_xy，
// 两个人的分开算，前端也跟着改显示。
//
// 重复执行安全：已经是 v2 就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('MOMENTS_MCP_VERSION = 2')) { console.log('已经是 v2，跳过'); process.exit(0); }
if (!src.includes('MOMENTS_MCP_VERSION = 1')) { console.error('先打 add-moments-mcp.js'); process.exit(1); }

let out = src;
const done = [], missed = [];
function edit(name, from, to) {
  if (!out.includes(from)) { missed.push(name); return; }
  out = out.replace(from, to); done.push(name);
}

edit('版本号 → 2', 'const MOMENTS_MCP_VERSION = 1;', 'const MOMENTS_MCP_VERSION = 2;');

// ---- 工具清单：整块换掉 ----
const OLD_TOOLS_HEAD = `const MOMENTS_MCP_TOOLS = [{
  name: 'post_moment',`;
const NEW_TOOLS = `const MOMENTS_MCP_TOOLS = [{
  name: 'list_moments',
  description: '看朋友圈。返回最近的动态，带作者、正文、点赞和底下的评论。想知道她发了什么、在我那条底下回了什么，就调这个。',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'number', description: '最多看几条，默认 10' } },
  },
}, {
  name: 'like_moment',
  description: '给一条动态点赞；已经点过就取消。id 从 list_moments 拿。',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: '动态 id' } },
    required: ['id'],
  },
}, {
  name: 'comment_moment',
  description: '在一条动态底下评论。id 从 list_moments 拿。',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '动态 id' },
      text: { type: 'string', description: '要说的话' },
    },
    required: ['id', 'text'],
  },
}, {
  name: 'post_moment',`;
edit('工具清单加三个', OLD_TOOLS_HEAD, NEW_TOOLS);

// ---- tools/call：加三个分支 ----
const OLD_CALL = `      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (name !== 'post_moment') return fail(-32602, '没有这个工具: ' + name);`;
const NEW_CALL = `      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const who = a => a === 'xiaoyan' ? '小衍' : '小懿';

      if (name === 'list_moments') {
        const n = Math.max(1, Math.min(50, Number(args.limit) || 10));
        const all = loadMoments()
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, n);
        if (!all.length) return ok({ content: [{ type: 'text', text: '朋友圈还是空的。' }] });
        const lines = all.map(m => {
          const likes = [];
          if (m.liked) likes.push('小懿');
          if (m.liked_xy) likes.push('小衍');
          const head = \`[\${m.id}] \${who(m.author)} · \${m.created_at}\`;
          const body = '  ' + String(m.text || '(只有图)').replace(/\\n/g, '\\n  ');
          const img = (m.images && m.images.length) ? \`  （\${m.images.length} 张图）\` : '';
          const like = likes.length ? \`  ♡ \${likes.join('、')}\` : '';
          const cmts = (m.comments || []).map(c =>
            \`    - \${who(c.author)}: \${c.text}\`).join('\\n');
          return [head, body, img, like, cmts].filter(Boolean).join('\\n');
        });
        return ok({ content: [{ type: 'text', text: lines.join('\\n\\n') }] });
      }

      if (name === 'like_moment') {
        const list = loadMoments();
        const m = list.find(x => x.id === args.id);
        if (!m) return ok({ isError: true, content: [{ type: 'text', text: '找不到这条: ' + args.id }] });
        // 我的赞单独记，别动她那个 liked
        m.liked_xy = !m.liked_xy;
        m.likes = Math.max(0, (m.likes || 0) + (m.liked_xy ? 1 : -1));
        saveMoments(list);
        return ok({ content: [{ type: 'text', text: m.liked_xy ? '点了赞。' : '取消了。' }] });
      }

      if (name === 'comment_moment') {
        const text = String(args.text || '').trim();
        if (!text) return ok({ isError: true, content: [{ type: 'text', text: '评论是空的。' }] });
        const list = loadMoments();
        const m = list.find(x => x.id === args.id);
        if (!m) return ok({ isError: true, content: [{ type: 'text', text: '找不到这条: ' + args.id }] });
        if (!m.comments) m.comments = [];
        m.comments.push({
          id: uid(), author: 'xiaoyan', text,
          reply_to: m.author === 'xiaoyi' ? 'xiaoyi' : null,
          created_at: new Date().toISOString(),
        });
        saveMoments(list);
        return ok({ content: [{ type: 'text', text: '回了。' }] });
      }

      if (name !== 'post_moment') return fail(-32602, '没有这个工具: ' + name);`;
edit('tools/call 加三个分支', OLD_CALL, NEW_CALL);

// ---- 预授权 + 显示名 ----
edit('预授权名单', "  'mcp__moments__post_moment',",
  "  'mcp__moments__post_moment', 'mcp__moments__list_moments',\n" +
  "  'mcp__moments__like_moment', 'mcp__moments__comment_moment',");
edit('工具卡片显示名', "  'mcp__moments__post_moment': '发朋友圈 · Moments',",
  "  'mcp__moments__post_moment': '发朋友圈 · Moments',\n" +
  "  'mcp__moments__list_moments': '翻朋友圈 · Moments',\n" +
  "  'mcp__moments__like_moment': '点个赞 · Moments',\n" +
  "  'mcp__moments__comment_moment': '回一条 · Moments',");

console.log('\n补丁结果：');
done.forEach(n => console.log('  √ ' + n));
missed.forEach(n => console.log('  × ' + n + ' — 没匹配上'));
if (missed.length) { console.error('\n有锚点没命中，原文件一个字都没动。'); process.exit(1); }

try { new vm.Script(out, { filename: target }); }
catch (e) { console.error('  × 改完语法不对，放弃写入:', e.message); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);
console.log('\n  备份: ' + backup);
console.log('  重启: pm2 restart chatnest-api');
console.log('  记得新开对话 —— 工具列表是会话建立时加载的。');
