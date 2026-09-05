#!/usr/bin/env node
// 记忆页和 Pulse 页的字：轻一点、暖一点。
//   node fix-memory-pulse-type.js [/var/www/chatnest/index.html]
//
// 在真浏览器里量了一遍算出来的样式，两件事：
//
// 1. 「.profile-title 衬线 500」那条我上次就写了，从来没生效过。
//    后面那个压缩块里又写了一遍 `font:600 22px var(--font-sans)`，
//    在文件里靠后、权重相同 —— 后来者赢。所以那个标题一直是 600 的黑体，
//    整屏就它最重。只能再写一遍压回去。
//    （这类事没法用眼睛发现，得让浏览器把 computed style 报出来。）
//
// 2. 正文颜色是 #201f1d。数值上不是纯黑，但铺在那个奶油粉底上就是一块死黑。
//    换成 #3b332b —— 偏暖的深褐灰，跟这屏已有的 #77736c / #8B7263 是一家的。
//    对白底还有 10:1 的对比度，读起来不费劲，只是不压人了。
//
// 顺带：--font-serif 里中文那截回退到 PingFang（无衬线），所以中文标题不管怎么
// 设都是黑体。加一个 --font-serif-cn，把 Songti SC 排在 PingFang 前面，
// 中文标题才真的有衬线。只给这两屏的大标题用，不动全局。
//
// 暗色守卫：#memoryPanel 是 ID 选择器，特异性比 html[data-chat-bg="dark"] .xxx 高，
// 不加 :not() 的话会把暗色模式的浅色字压成深色 —— 那一屏就全黑了。
//
// 重复执行安全：已经打过就退出。

const fs = require('fs');

const target = process.argv[2] || '/var/www/chatnest/index.html';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('--font-serif-cn')) { console.log('已经打过，跳过'); process.exit(0); }

const CSS = `
/* ===== 记忆页 / Pulse 页：字轻一点、暖一点 ===== */
/* --font-serif 里中文那截落到 PingFang（无衬线），所以中文标题一直是黑体。
   这里把宋体排到 PingFang 前面，只给这两屏的大标题用，不动全局。 */
:root{--font-serif-cn:ui-serif,Georgia,'Songti SC','STSong','Source Han Serif SC','Noto Serif CJK SC','PingFang SC',serif}

/* 全都夹一层 :not([data-chat-bg="dark"])：#memoryPanel 是 ID，特异性比暗色那几条
   html[data-chat-bg="dark"] .xxx 都高，不夹的话暗色模式整屏字会被压成深色。 */
html:not([data-chat-bg="dark"]) #memoryPanel{color:#3b332b}

/* 这条是补上次那次漏的 —— 后面压缩块里的 600 黑体一直压着它 */
html:not([data-chat-bg="dark"]) #memoryPanel .profile-title,
html:not([data-chat-bg="dark"]) .pulse-panel .profile-title{
  font:500 22px/1.18 var(--font-serif-cn);letter-spacing:.05em;color:#3b332b}

html:not([data-chat-bg="dark"]) .mem-gate-name{
  font:500 17px/1.3 var(--font-serif-cn);letter-spacing:.04em;color:#3b332b}

html:not([data-chat-bg="dark"]) .pulse-cycle-name{
  font:400 29px/1.2 var(--font-serif-cn);letter-spacing:.09em;color:#3b332b}

/* 正文那几处也一起提一档，不然标题暖了、正文还压着，看着更花 */
html:not([data-chat-bg="dark"]) #memoryPanel .profile-name-input,
html:not([data-chat-bg="dark"]) #memoryPanel .profile-memory-textarea,
html:not([data-chat-bg="dark"]) #memoryPanel .profile-preferences-textarea,
html:not([data-chat-bg="dark"]) #memoryPanel .profile-card,
html:not([data-chat-bg="dark"]) #memoryPanel .profile-nav-row{color:#3b332b}
`;

// 锚点用表盘那段 CSS 的最后一行 —— 唯一，而且在样式表里靠后，压得住前面那些。
// 千万别拿 '</style>' 当锚点：页面里有内联 SVG，rfind 会打到 SVG 自己的 </style> 上，
// CSS 会被塞进那个 SVG 里，整段静默失效（这个坑踩过一次）。
const ANCHOR = '.usg-note b{font-weight:600;color:var(--text-primary)}';
if (src.split(ANCHOR).length - 1 !== 1) {
  console.error('  × 找不到锚点（或者不止一处），先打 add-usage-panel.js。原文件没动。');
  process.exit(1);
}
let out = src.split(ANCHOR).join(ANCHOR + '\n' + CSS);

const checks = [
  ['文件完整', /<\/html>/i.test(out)],
  ['新字族变量定义了', out.includes("--font-serif-cn:ui-serif")],
  ['宋体排在苹方前面', /'Songti SC'[^}]*'PingFang SC'/.test(out)],
  ['补上了被压掉的那条标题规则', /#memoryPanel \.profile-title/.test(out)],
  ['每一条都夹了暗色守卫', (out.match(/html:not\(\[data-chat-bg="dark"\]\) #memoryPanel/g) || []).length >= 2
    && !/\n#memoryPanel\{color:#3b332b\}/.test(out)],
  // 页面里有 15 个 </style>，绝大多数是内联 SVG 自己的，第一个在文件很靠前的位置。
  // 所以不能拿 indexOf('</style>') 比 —— 要比的是「锚点所在那个 style 块的收尾」。
  // （我第一版这条自检就是这么写错的，它把好补丁判成了坏补丁。）
  ['CSS 落在样式表里，没跑到 SVG 里去',
    out.indexOf('--font-serif-cn') > out.indexOf(ANCHOR)
    && out.indexOf('--font-serif-cn') < out.indexOf('</style>', out.indexOf(ANCHOR))],
  ['只插了一次', (out.match(/--font-serif-cn:/g) || []).length === 1],
  ['没弄丢别的', ['usgSheetBody', 'ctxMeterFill', 'topbarLedger', 'ks-sheet', 'mem-gate-name', 'pulse-cycle-name']
    .every(k => (src.includes(k) ? out.includes(k) : true))],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

console.log('\n补丁结果：');
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('\n  · 中文有没有衬线要看手机上装没装宋体 —— iOS 有 Songti SC，应该能吃到。');
console.log('    看着不对就说，颜色和字重都能再调。');
