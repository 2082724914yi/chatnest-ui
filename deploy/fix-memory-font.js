#!/usr/bin/env node
// 记忆页和 Pulse 页的字，跟主页对齐。
//   node fix-memory-font.js [/var/www/chatnest/index.html]
//
// 这两页的标题一律是 var(--font-sans) 600 —— 在花底子上就是一块黑，
// 跟主页那种衬线斜体不是一家的。全部换成 --font-serif，字重压到 500，
// 纯英文的标题（Pulse / Latent / Ombre Brain）跟主页卡片一样走斜体。
//
// 只动字，不动结构和颜色。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');

const target = process.argv[2] || '/var/www/chatnest/index.html';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('profile-title is-en')) { console.log('已经打过，跳过'); process.exit(0); }

const CSS = `
/* ===== 记忆页 / Pulse 页的字，跟主页对齐 ===== */
.profile-title{font:500 22px/1.15 var(--font-serif);letter-spacing:.02em}
/* 英文标题跟主页卡片一样斜体；中文标题斜体不好看，所以按内容加类，不一刀切 */
.profile-title.is-en{font-style:italic;font-weight:600;letter-spacing:.01em}
.profile-subtitle{font-family:var(--font-serif)}
.profile-section-title,.pulse-section-title{font-family:var(--font-serif);letter-spacing:.05em}
.profile-nav-row-title{font-family:var(--font-serif)}
.mem-gate-name{font:500 17px/1.25 var(--font-serif);letter-spacing:.02em}
.mem-gate-sub{font-family:var(--font-serif)}
.ob-nav-item{font:500 14px/1.2 var(--font-serif)}
.lt-block{font-family:var(--font-serif)}
.lt-empty{font-family:var(--font-serif)}
.profile-empty{font-family:var(--font-serif)}
`;

const edits = [
  {
    name: '字体规则',
    find: '/* 只有用户真选了深色壁纸才翻成浅色字。',
    replace: CSS + '\n/* 只有用户真选了深色壁纸才翻成浅色字。',
  },
  {
    name: 'Pulse 标题走斜体',
    find: '<div class="profile-title" id="pulseTitle">Pulse</div>',
    replace: '<div class="profile-title is-en" id="pulseTitle">Pulse</div>',
  },
  {
    name: 'Latent 标题走斜体',
    find: '<div class="profile-title">Latent</div>',
    replace: '<div class="profile-title is-en">Latent</div>',
  },
  {
    name: 'Ombre Brain 标题走斜体',
    find: '<div class="profile-title">Ombre Brain</div>',
    replace: '<div class="profile-title is-en">Ombre Brain</div>',
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  const before = out;
  out = out.split(e.find).join(e.replace);
  if (out === before) missed.push(e.name);
}

console.log('\n补丁结果：');
if (missed.length) {
  for (const e of edits) console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 锚点没匹配上' : '  √ ' + e.name);
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['文件完整', /<\/html>/i.test(out)],
  ['标题换成衬线了', /\.profile-title\{font:500 22px\/1\.15 var\(--font-serif\)/.test(out)],
  ['英文标题斜体', out.includes('.profile-title.is-en{font-style:italic')],
  ['三个英文标题都加上了', (out.match(/class="profile-title is-en"/g) || []).length === 3],
  ['中文标题没被斜体', !/记忆<\/div>[\s\S]{0,40}is-en/.test(out)],
  ['门的名字也换了', /\.mem-gate-name\{font:500 17px\/1\.25 var\(--font-serif\)/.test(out)],
  ['没弄丢别的功能', ['pulseTabBar', 'memoryPicker', 'obToolsBtn', 'latentUnresolvedOut']
    .every(k => (src.includes(k) ? out.includes(k) : true))],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

for (const e of edits) console.log('  √ ' + e.name);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
