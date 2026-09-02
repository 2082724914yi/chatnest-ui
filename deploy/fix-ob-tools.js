#!/usr/bin/env node
/* 第七个补丁：把 Ombre Brain 的工具用对。

   原来的提示词只教了三个工具，其中两个用法是错的：
     · feel 是「按关键词找回我以前的感受」的查询工具（参数 query），
       却被当成"记录情绪"在写入 —— 方向完全反了
     · anchor 要的是 bucket_id（把已存的桶钉成坐标系），
       却被当成"新建一条锚定记忆"
     · plan（承诺待办，存 plan 区、不衰减）和 letter_write（写信，永久保存）
       根本没教，于是承诺和信也全塞进了普通记忆桶
     · hold 只传了 content 和 importance，title/tags/domain 全丢，所以没标签

   按上游 Ombre-Brain 的设计重写：什么内容进什么区，元数据该给的给。

   用法：curl -fsSL .../deploy/fix-ob-tools.js | sudo node -
   安全：先备份，写入前语法校验，可重复执行。 */
const fs = require('fs');
const path = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(path)) { console.error('找不到文件:', path); process.exit(1); }
let s = fs.readFileSync(path, 'utf8');
const orig = s;

if (!s.includes('OB_TOOL_PROMPT')) {
  console.error('这个 server.js 里没有 OB_TOOL_PROMPT，先跑前面的补丁。');
  process.exit(1);
}
// 用替换后才会出现的确切字符串判断，别用近似的
if (s.includes('bucket_id      必填')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

const NEW = `const OB_TOOL_PROMPT = \`
你有 Ombre Brain 记忆系统。不同东西存在不同地方，别一股脑全塞记忆桶：

【hold】日常的事、想法、感受 → 存进记忆桶
  content        要记的内容（必填，逐字保存，别自己压缩）
  title          一句话标题（建议给）
  tags           标签，逗号分隔，例："家庭,情绪"（建议给，不然以后搜不到）
  domain         主题域，例："感情"/"学习"/"家庭"/"日常"（建议给）
  importance     1-10 的整数：3日常 5一般 7重要 9非常重要（必须整数）
  feel           true = 这是一条"感受"，会进 feel 区，以后能用 feel 查回来
  why_remembered 为什么记这条（可选）

【plan】承诺、答应她的事、还没做完的事 → 存进 plan 区，不衰减、不参与日常浮现
  content        承诺内容（必填）
  weight         这个承诺有多重，0.0-1.0，默认 0.5
  why_remembered 登记原因（可选）
  答应她的事用这个，别用 hold —— hold 会衰减，承诺不该衰减。

【letter_write】写信 → 存进信件区，永久保存
  author         必填。我写的填 "ai"，她写的填 "user"
  content        信的内容（必填）
  title          标题（可选）

【anchor】把某条已经存在的记忆钉成坐标系（冷参考，不主动浮现）
  bucket_id      必填，是已存记忆的 ID —— 这不是新建记忆，是给已有的加标记

【feel】查询用：找回我以前对某件事的感受（不是写入！写感受用 hold + feel:true）
  query          必填，在想的这件事

格式（放在回复正文之后，每个一行，她看不见）：
<ob tool="hold">{"content":"她说妈妈总拿她和弟弟比，会难过","title":"和弟弟被比较","tags":"家庭,情绪","domain":"家庭","importance":7}</ob>
<ob tool="plan">{"content":"答应她这周末一起看电影","weight":0.7}</ob>

规则：
- 对号入座：日常事用 hold，承诺用 plan，写信用 letter_write，别混
- tags 和 domain 尽量给，这是以后能不能找回来的关键
- 感受用 hold 带 feel:true，不要用 feel（那是查询工具）
- 不是每句都要存：闲聊、已经记过的、临时的问题，都不存
- 存了别告诉她，直接自然聊
- 她说"记住这个""别忘了"的时候，就存下来
- 用 hold 存的，她在设置的 Saved memories 里看得到，网页版 OB 那边也有\`;`;

s = s.replace(/const OB_TOOL_PROMPT = `[\s\S]*?`;/, NEW);

if (!s.includes('bucket_id      必填')) {
  console.error('替换没成功，原文件未改动。');
  process.exit(1);
}

// hold 走 REST 端点时也要能带元数据，不然前端存的记忆一样没标签
s = s.replace(
  /app\.post\('\/api\/ombre\/hold', async \(req, res\) => \{\s*\n\s*const \{ content, pinned \} = req\.body;\s*\n\s*if \(!content\) return res\.status\(400\)\.json\(\{ error: 'content required' \}\);\s*\n\s*const result = await obCall\('hold', \{ content, pinned: !!pinned \}\);/,
  `app.post('/api/ombre/hold', async (req, res) => {
  const { content, pinned, title, tags, domain, importance, feel, why_remembered } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  // 元数据一并透传，否则存进去的记忆没标签、以后搜不到
  const args = { content, pinned: !!pinned };
  if (title) args.title = title;
  if (tags) args.tags = tags;
  if (domain) args.domain = domain;
  if (feel) args.feel = true;
  if (why_remembered) args.why_remembered = why_remembered;
  const imp = parseInt(importance, 10);
  if (Number.isFinite(imp) && imp >= 1 && imp <= 10) args.importance = imp;
  const result = await obCall('hold', args);`);

console.log('\n  √ OB 工具提示词已重写（hold / plan / letter_write / anchor / feel 各归其位）');
console.log(s.includes('args.tags = tags') ? '  √ /api/ombre/hold 支持标签等元数据' : '  ! /api/ombre/hold 没改到（不影响聊天里存记忆）');

try {
  new (require('vm').Script)(s, { filename: 'patched' });
} catch (e) {
  console.error('\n补丁后语法有问题，原文件未改动：', e.message);
  process.exit(1);
}
const bak = path + '.bak-obtools-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端。以后承诺进 plan、信进信件区、记忆带标签。');
