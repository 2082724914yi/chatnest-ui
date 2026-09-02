#!/usr/bin/env node
// 给自动部署的 deploy.sh 补一道前端护栏。
//   node guard-frontend-deploy.js [/opt/chatnest-deploy/deploy.sh]
//
// 为什么需要：deploy.sh 同步前端时只检查「非空」和「有闭合标签」，然后整份 cp 覆盖。
// 而仓库里的 index.html 会落后于线上（线上有仓库没有的功能）。这种情况下
// 一次自动部署就会静默删掉线上才有的东西，没有任何提示。
// deploy-frontend.sh 有 obToolsBtn 校验挡着，deploy.sh 没有。
//
// 补上之后：新版比现有明显变小、或者弄丢了现有版本里的关键标记，就拒绝部署并记日志。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');

const target = process.argv[2] || '/opt/chatnest-deploy/deploy.sh';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('_frontend_keeps_features')) { console.log('已经打过，跳过'); process.exit(0); }

const FN = `
# 新版前端不许把现有功能弄丢。仓库落后于线上时，整份覆盖会静默删掉线上才有的东西。
# 两道：体积不许明显缩水；现有版本里有的关键标记，新版必须也有。
_frontend_keeps_features(){
  local new=$1 cur=$2 mark newsize cursize
  [ -f "$cur" ] || return 0
  newsize=$(wc -c < "$new"); cursize=$(wc -c < "$cur")
  if [ "\${cursize:-0}" -gt 0 ] && [ $(( newsize * 100 / cursize )) -lt 97 ]; then
    log "前端护栏：新版 $newsize 字节，比现有 $cursize 缩水超过 3%，拒绝"
    return 1
  fi
  for mark in obToolsBtn memoryPanel pulsePanel sessionList composer; do
    if grep -q "$mark" "$cur" 2>/dev/null && ! grep -q "$mark" "$new" 2>/dev/null; then
      log "前端护栏：现有版本有 $mark，新版里没有，拒绝"
      return 1
    fi
  done
  return 0
}
`;

const edits = [
  {
    name: '护栏函数',
    find: '\nhealth(){',
    replace: FN + '\nhealth(){',
  },
  {
    name: '前端同步接上护栏',
    find: `  elif cmp -s "$NEW" "$CUR" 2>/dev/null; then
    log "前端内容无变化"
  else`,
    replace: `  elif cmp -s "$NEW" "$CUR" 2>/dev/null; then
    log "前端内容无变化"
  elif ! _frontend_keeps_features "$NEW" "$CUR"; then
    log "前端没通过护栏，这次不部署（原因见上一行）"
  else`,
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  if (!out.includes(e.find)) { missed.push(e.name); continue; }
  out = out.replace(e.find, e.replace);
}

console.log('\n补丁结果：');
if (missed.length) {
  for (const e of edits) console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 锚点没匹配上' : '  √ ' + e.name);
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);
fs.chmodSync(target, 0o755);

for (const e of edits) console.log('  √ ' + e.name);
console.log('\n  备份: ' + backup);
console.log('  用 bash -n 自查一下语法：bash -n ' + target);
