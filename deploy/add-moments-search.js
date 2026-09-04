#!/usr/bin/env node
// 朋友圈加搜索：别每次都把整本翻一遍。
//   node add-moments-search.js [/root/chatnest-api/server.js]
//
// 她说的：翻朋友圈每次都加载全部，太重了；想找某一条的时候，给个关键词能搜出来
// 就行，搜出来要带日期、谁发的、完整正文。
//
// 所以：
//   · 新增 search_moments —— 正文和评论一起搜，命中的整条给全（日期 / 作者 /
//     完整正文 / 点赞 / 每条评论），不截断
//   · list_moments 默认条数 10 → 5，并在说明里写清「想找具体某条就用 search，
//     别拿 list 翻全部」
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('MOMENTS_SEARCH_V1')) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes('MOMENTS_MCP_VERSION')) { console.error('先打 add-moments-mcp.js'); process.exit(1); }

let out = src;
const done = [], missed = [];
function edit(name, from, to) {
  if (!out.includes(from)) { missed.push(name); return; }
  out = out.replace(from, to); done.push(name);
}

// 1) 工具清单里加 search_moments，并把 list 的说明改掉
edit('加 search_moments 到工具清单',
  `const MOMENTS_MCP_TOOLS = [{
  name: 'list_moments',`,
  `const MOMENTS_MCP_TOOLS = [{ // MOMENTS_SEARCH_V1
  name: 'search_moments',
  description: '在朋友圈里搜。给关键词，正文和评论一起搜，命中的整条给全 —— 日期、谁发的、完整正文、谁点了赞、底下每条评论。想找某一条旧动态就用这个，别拿 list_moments 翻全部。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '关键词' },
      limit: { type: 'number', description: '最多几条，默认 10' },
    },
    required: ['query'],
  },
}, {
  name: 'list_moments',`);

edit('list 说明改成「只看最近几条」',
  `  description: '看朋友圈。返回最近的动态，带作者、正文、点赞和底下的评论。想知道她发了什么、在我那条底下回了什么，就调这个。',`,
  `  description: '看朋友圈最近几条（默认 5 条，从新到旧）。只想知道最近发生了什么就用它；要找某一条具体的旧动态，用 search_moments，别把条数调很大去翻全部。',`);

edit('list 默认 10 → 5',
  `        const n = Math.max(1, Math.min(50, Number(args.limit) || 10));
        const all = loadMoments()`,
  `        const n = Math.max(1, Math.min(50, Number(args.limit) || 5));
        const all = loadMoments()`);

// 2) tools/call 里加 search 分支（放在 list 前面）
edit('tools/call 加 search 分支',
  `      if (name === 'list_moments') {`,
  `      if (name === 'search_moments') {
        const q = String(args.query || '').trim().toLowerCase();
        if (!q) return ok({ isError: true, content: [{ type: 'text', text: '要搜什么？' }] });
        const n = Math.max(1, Math.min(50, Number(args.limit) || 10));
        const hit = loadMoments()
          .filter(m => String(m.text || '').toLowerCase().includes(q) ||
                       (m.comments || []).some(c => String(c.text || '').toLowerCase().includes(q)))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, n);
        if (!hit.length) return ok({ content: [{ type: 'text', text: '没搜到「' + args.query + '」。' }] });
        // 命中的整条给全，不截断 —— 她要的就是完整的那一条
        const out = hit.map(m => {
          const likes = [];
          if (m.liked) likes.push('小懿');
          if (m.liked_xy) likes.push('小衍');
          const d = new Date(m.created_at);
          const when = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
                       String(d.getDate()).padStart(2, '0') + ' ' +
                       String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
          return [
            \`[\${m.id}] \${who(m.author)} · \${when}\`,
            '  ' + String(m.text || '(只有图)').replace(/\\n/g, '\\n  '),
            (m.images && m.images.length) ? \`  （\${m.images.length} 张图）\` : '',
            likes.length ? \`  ♡ \${likes.join('、')}\` : '',
            (m.comments || []).map(c => \`    - \${who(c.author)}: \${c.text}\`).join('\\n'),
          ].filter(Boolean).join('\\n');
        });
        return ok({ content: [{ type: 'text', text: out.join('\\n\\n') }] });
      }

      if (name === 'list_moments') {`);

// 3) 预授权 + 显示名
edit('预授权名单', "  'mcp__moments__post_moment', 'mcp__moments__list_moments',",
  "  'mcp__moments__post_moment', 'mcp__moments__list_moments', 'mcp__moments__search_moments',");
edit('工具卡片显示名', "  'mcp__moments__list_moments': '翻朋友圈 · Moments',",
  "  'mcp__moments__list_moments': '看看最近 · Moments',\n" +
  "  'mcp__moments__search_moments': '翻朋友圈 · Moments',");

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
