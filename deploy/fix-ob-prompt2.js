#!/usr/bin/env node
/* 第十七个补丁：写信重复念一遍，以及"搜索记忆"抓错工具。

   从她服务器上取回原文看清楚的两件事：

   1) 写信那轮，工具卡片里信已经真的写进 OB 了（💌letter→177eb1dc4f4d），
      正文里又把整封信一句句抄了一遍。提示词里没说"用了工具就别在正文复述"。

   2) "搜索一下蜡烛的记忆" → 调了 feel(query="蜡烛") → "还没有留下过 feel"。
      因为 OB_TOOL_PROMPT 里压根没有 breath_search，唯一带"查询"字样的就是 feel。

      更要命的是结构问题：<ob> 工具是**回复写完之后**才执行的，
      所以查询类工具（breath_search/feel/letter_read/pulse）根本来不及影响这次回复 ——
      我说"我翻了一下没找到"的时候，工具还没跑。那句话是瞎说的。

      正确做法是查询走**前置注入**：后端在生成之前就 breath_search 一次，
      把结果放进 [相关记忆]。所以这个补丁：
        · wantsRecall 的触发词补上 记忆/搜索/搜/查/找/翻
        · 提示词里明说：要找过去的事，[相关记忆] 里已经给你了，不要调工具去查

   顺带整块重写 OB_TOOL_PROMPT，把之前几个补丁陆续加的内容收拢成一份
   （grow/trace 保留，feel 的矛盾说法清掉）。

   用法：curl -fsSL .../deploy/fix-ob-prompt2.js | sudo node -
   安全：先备份，写入前语法校验，可重复执行。 */
const fs = require('fs');
const path = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(path)) { console.error('找不到文件:', path); process.exit(1); }
let s = fs.readFileSync(path, 'utf8');
const orig = s;

if (!s.includes('OB_TOOL_PROMPT')) {
  console.error('这个 server.js 里没有 OB_TOOL_PROMPT，先跑 apply-all.sh。');
  process.exit(1);
}
if (s.includes('查过去的事不要调工具')) {
  console.log('已经打过这个补丁了，无需重复执行。');
  process.exit(0);
}

// ⚠ 新提示词里必须保留 "bucket_id      必填" 这一串 ——
// 那是 fix-ob-tools.js 的幂等标记，去掉的话 apply-all 会把它重跑一遍、
// 用旧版提示词把这里覆盖回去。
const NEW = `const OB_TOOL_PROMPT = \`
你有 Ombre Brain 记忆系统。不同东西存在不同地方，别一股脑全塞记忆桶：

【hold】日常的事、想法、感受 → 存进记忆桶
  content        要记的内容（必填，逐字保存，别自己压缩）
  title          一句话标题（建议给）
  tags           标签，逗号分隔，例："家庭,情绪"（建议给，不然以后搜不到）
  domain         主题域，例："感情"/"学习"/"家庭"/"日常"（建议给）
  importance     1-10 的整数：3日常 5一般 7重要 9非常重要（必须整数）
  pinned         true = 钉成核心，永远浮现、不衰减（很重要的话才用）
  why_remembered 为什么记这条（可选）

【grow】把一整段对话/一天的事整理成一条记忆 → 存进记忆桶
  content        整理好的内容（必填，一次调用写完，别拆成很多条 hold）

【plan】承诺、答应她的事、还没做完的事 → 存进 plan 区，不衰减、不参与日常浮现
  content        承诺内容（必填）
  weight         这个承诺有多重，0.0-1.0，默认 0.5
  答应她的事用这个，别用 hold —— hold 会衰减，承诺不该衰减。

【letter_write】写信 → 存进信件区，永久保存
  author         必填。我写的填 "ai"，她写的填 "user"
  content        信的内容（必填）
  title          标题（可选）

【trace】改一条已经存在的记忆（要先知道它的 bucket_id）
  bucket_id      必填
  resolved       1 = 这件事过去了，让它沉底；0 = 重新激活
  pinned         1 = 钉成核心；importance 取消 pinned 时必须一起给
  content        整条正文替换掉

【anchor】把某条已经存在的记忆钉成坐标系（冷参考，不主动浮现）
  bucket_id      必填，是已存记忆的 ID —— 这不是新建记忆，是给已有的加标记

格式（放在回复正文之后，每个一行，她看不见）：
<ob tool="hold">{"content":"她说妈妈总拿她和弟弟比，会难过","title":"和弟弟被比较","tags":"家庭,情绪","domain":"家庭","importance":7}</ob>
<ob tool="plan">{"content":"答应她这周末一起看电影","weight":0.7}</ob>

规则：
- ⚠ 查过去的事不要调工具。这些 <ob> 标签是回复写完之后才执行的，
  查询类的结果我这次根本看不到。她问"上次说的那个""搜一下xx的记忆"时，
  相关记忆已经由系统放在上面的 [相关记忆] 里了 —— 有就直接用，
  没有就老实说没找到，不要装作"我去翻一下"然后编一个结果。
- ⚠ 存过的内容不要在正文里再念一遍。写信就说"写好了，去看看"，
  信的正文只放在 <ob> 里；存记忆也一样，别把刚存的东西复述给她听。
- 对号入座：日常事用 hold，承诺用 plan，写信用 letter_write，整段整理用 grow，别混
- tags 和 domain 尽量给，这是以后能不能找回来的关键
- 记感受就是普通 hold，domain 写"情绪"或"感情"；feel 参数不要传
  （OB 的 feel 必须挂在一条已有记忆上，日常聊天给不出来）
- 不是每句都要存：闲聊、已经记过的、临时的问题，都不存
- 绝对不要存"测试""1""哈哈"这种没内容的字 —— 打标模型会在这种输入上失控空转烧钱
- ⚠ JSON 正文里不要出现英文双引号 " —— 要引用她的话就用「」，
  写成 "content":"她说「随便你」最伤人"。直接打 " 会让整条 JSON 坏掉、记忆丢失
- 存了别告诉她，直接自然聊
- 她说"记住这个""别忘了"的时候，就存下来
- 用 hold 存的，她在设置的 Saved memories 里看得到，网页版 OB 那边也有\`;`;

const before = s;
s = s.replace(/const OB_TOOL_PROMPT = `[\s\S]*?`;/, NEW);
if (s === before) { console.error('提示词没替换成功（没匹配到），原文件未改动。'); process.exit(1); }
if (!s.includes('bucket_id      必填')) {
  console.error('新提示词里丢了 fix-ob-tools 的幂等标记，会被 apply-all 覆盖回去，中止。');
  process.exit(1);
}
console.log('  √ OB_TOOL_PROMPT 已重写（补上 breath_search 的说明、禁止正文复述）');

// 查询类工具走**前置注入**：在生成之前就跑，把结果放进 [相关记忆]，
// 这样模型开口时手上就有资料。按她说的话分发到对应的工具，一个场景对一个工具。
const RE_OLD = "const wantsRecall = /回忆|记得|记不记得|还记|想起|上次|上回|之前|以前|那次|说过|忘了|忘记|提过|聊过/.test(message);";
const RE_NEW = `const wantsRecall = /回忆|记得|记不记得|还记|想起|上次|上回|之前|以前|那次|说过|忘了|忘记|提过|聊过|记忆|搜索|搜一下|搜下|查一下|查查|找一下|找找|翻一下|翻翻|有没有记/.test(message);
  // 她这句话该用哪个查询工具。写入类（hold/plan/letter_write…）走回复后面的 <ob> 标签，
  // 查询类必须在这里先跑完 —— <ob> 是回复写完才执行的，那时候结果模型已经看不到了。
  const _recallPick = (() => {
    if (/写给我的信|你写的信|那封信|读信|看信|信里/.test(message)) return { tool: 'letter_read', args: {}, label: 'letter_read · 翻信' };
    if (/记了多少|记忆.*多少|多少条记忆|脑子里(都)?有(什么|啥)|记忆(系统)?状态|记忆概况/.test(message)) return { tool: 'pulse', args: {}, label: 'pulse · 记忆概况' };
    if (wantsRecall) return { tool: 'breath_search', args: { query: message }, label: 'breath_search · 回忆' };
    return { tool: 'breath', args: {}, label: 'breath · 浮现记忆' };
  })();`;
if (s.includes('_recallPick')) {
  console.log('  · 查询工具分发已经在了');
} else if (s.includes(RE_OLD)) {
  s = s.replace(RE_OLD, RE_NEW);
  console.log('  √ 回忆触发词补上「搜索/记忆/查/找/翻」，并按场景分发查询工具');
} else {
  console.error('  ! 找不到 wantsRecall 那一行，触发词没改到（提示词那部分已生效）');
}

// 让前置注入真的用上分发结果（原来写死了 breath / breath_search 二选一）
const OLD_TRACE = "    const recallTrace = traceStart('tool', isFirstTurn ? 'breath · 浮现记忆' : 'breath_search · 回忆');";
const OLD_INPUT = "    recallTrace.input = isFirstTurn ? {} : { query: message.slice(0, 50) };";
const OLD_JOB = "      const job = isFirstTurn ? obCall('breath', {}) : obCall('breath_search', { query: message });";
if (s.includes(OLD_TRACE) && s.includes(OLD_INPUT) && s.includes(OLD_JOB)) {
  s = s.replace(OLD_TRACE, "    const recallTrace = traceStart('tool', _recallPick.label);");
  s = s.replace(OLD_INPUT, "    recallTrace.input = _recallPick.args.query ? { query: String(_recallPick.args.query).slice(0, 50) } : _recallPick.args;");
  s = s.replace(OLD_JOB, "      const job = obCall(_recallPick.tool, _recallPick.args);");
  console.log('  √ 前置注入改成按分发结果调用（breath / breath_search / letter_read / pulse）');
} else {
  console.error('  ! 前置注入那三行没全找到，分发没接上（提示词部分已生效）');
}

// 触发条件也要放开：她问信、问记忆概况时，原来的条件不成立就整段跳过了
const OLD_IF = "  if (isFirstTurn || wantsRecall) {";
const NEW_IF = "  if (isFirstTurn || wantsRecall || _recallPick.tool === 'letter_read' || _recallPick.tool === 'pulse') {";
if (s.includes(NEW_IF)) console.log('  · 触发条件已经放开过了');
else if (s.includes(OLD_IF)) { s = s.replace(OLD_IF, NEW_IF); console.log('  √ 问信 / 问记忆概况时也会先查再答'); }
else console.error('  ! 找不到前置注入的 if 条件');

const OLD_LOG = "    console.log(`[OB] ${isFirstTurn ? 'breath' : 'breath_search'} -> ${memories ? memories.length + ' 字' : '空'}`);";
if (s.includes(OLD_LOG)) s = s.replace(OLD_LOG, "    console.log(`[OB] ${_recallPick.tool} -> ${memories ? memories.length + ' 字' : '空'}`);");

try {
  new (require('vm').Script)(s, { filename: 'patched' });
} catch (e) {
  console.error('\n补丁后语法有问题，原文件未改动：', e.message);
  process.exit(1);
}
const bak = path + '.bak-prompt2-' + Date.now();
fs.writeFileSync(bak, orig);
fs.writeFileSync(path, s);
console.log(`\n全部打上了。备份：${bak}`);
console.log('重启后端。写完的信不会再在正文重复一遍，"搜一下xx"也会先真的搜过再回答。');
