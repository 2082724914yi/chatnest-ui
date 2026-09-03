#!/usr/bin/env node
// 保活提前，而且只在真空闲时发。
//   node fix-keepalive.js [/root/chatnest-api/server.js]
//
// 现在的心跳是 CLI spawn 的时候才起，而在那之前还有一长串等待：
// Latent 召回、Pulse 推进、OB 召回，每段都可能几十秒。那段完全没有保活。
// 中转站那条路径更彻底 —— 它在心跳启动之前就 return 了，从头到尾没有心跳。
//
// 静默超过代理的 read timeout，连接就被掐，而且网关这边什么都不会报
// （它压根不知道对面没了，还在认真干活）。
//
// 改成：请求一进来就起保活，且只在**真的**静默超过 14 秒时才发一帧。
// 不是无脑每 2 秒一发 —— 那既浪费，又跟正在写的流抢时序。
// 判断方式是包一层 res.write 记录最后写入时间，只有真闲着才补。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes('_stopKeepAlive')) { console.log('已经打过，跳过'); process.exit(0); }

const KEEPALIVE = `
  // 保活：SSE 头一设好就开始，覆盖到后面所有的召回等待。
  // 只在真静默 >14s 时补一帧，正常有输出的时候一帧都不发。
  const _stopKeepAlive = (() => {
    const _origWrite = res.write.bind(res);
    let _lastWrite = Date.now();
    res.write = (...args) => { _lastWrite = Date.now(); return _origWrite(...args); };
    const _t = setInterval(() => {
      if (res.writableEnded) return;
      if (Date.now() - _lastWrite < 14000) return;
      // 走包装后的 write，发完重新计时，不会每 5 秒刷一帧
      try { res.write(': ping\\n\\n'); if (res.socket) res.socket.uncork(); } catch (e) {}
    }, 5000);
    const stop = () => clearInterval(_t);
    res.once('close', stop);
    res.once('finish', stop);
    return stop;
  })();
`;

const edits = [
  {
    name: '保活提前到请求开头',
    find: "  res.setHeader('X-Accel-Buffering', 'no');",
    replace: "  res.setHeader('X-Accel-Buffering', 'no');\n" + KEEPALIVE,
  },
  {
    name: '撤掉原来那个每 2 秒盲发的心跳',
    find: /\n *\/\/ Heartbeat to keep SSE alive during CLI startup \(auth, loading\)\n *const heartbeat = setInterval\(\(\) => \{[^\n]*\}, 2000\);/,
    replace: () => "\n  // 保活已经在请求开头起了，覆盖范围比这里宽，这儿不用再来一个",
  },
  {
    name: '原来的 clearInterval 改成停保活',
    find: /clearInterval\(heartbeat\);/g,
    replace: () => '_stopKeepAlive();',
  },
];

let out = src;
const missed = [];
for (const e of edits) {
  const before = out;
  out = out.replace(e.find, e.replace);
  if (out === before) missed.push(e.name);
}

console.log('\n补丁结果：');
if (missed.length) {
  for (const e of edits) console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 没匹配上' : '  √ ' + e.name);
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

const iHead = out.indexOf("res.setHeader('X-Accel-Buffering', 'no')");
const iKeep = out.indexOf('_stopKeepAlive = ');
const checks = [
  ['保活在 SSE 头之后就起', iKeep > iHead && iHead > 0],
  ['没有残留的旧心跳', !out.includes('const heartbeat = setInterval')],
  ['没有残留的 clearInterval(heartbeat)', !out.includes('clearInterval(heartbeat)')],
  ['连接关掉会自己停', /res\.once\('close', stop\)/.test(out)],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
if (bad.length) { console.error('  × 自检没过：' + bad.join('、') + '，放弃写入'); process.exit(1); }

try {
  new vm.Script(out, { filename: target });
} catch (e) {
  console.error('  × 改完之后语法不对，放弃写入:', e.message);
  process.exit(1);
}

const backup = target + '.bak.' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

for (const e of edits) console.log('  √ ' + e.name);
for (const c of checks) console.log('  √ ' + c[0]);
console.log('\n  备份: ' + backup);
console.log('  接下来: pm2 restart chatnest-api');
