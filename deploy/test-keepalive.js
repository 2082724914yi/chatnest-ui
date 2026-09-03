// 把补丁生成的保活代码抠出来，用假时钟跑：有输出时一帧不发，真静默才补。
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[2], 'utf8');

const a = src.indexOf('  // 保活：SSE 头一设好就开始');
const b = src.indexOf('})();', a);
if (a < 0 || b < 0) { console.error('抠不出保活代码'); process.exit(1); }
const block = src.slice(a, b + 5);

const fails = [];
const check = (n, c, d = '') => { console.log(`[${c ? 'OK  ' : 'FAIL'}] ${n}` + (!c && d ? ` — ${d}` : '')); if (!c) fails.push(n); };

// 假时钟 + 假 res
let now = 1000000;
const written = [];
let ended = false;
const timers = [];
const res = {
  write: (s) => { written.push(String(s)); return true; },
  once: () => {},
  get writableEnded() { return ended; },
  socket: { uncork: () => {} },
};
const ctx = {
  res,
  Date: { now: () => now },
  setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  clearInterval: () => {},
  console,
};
ctx.global = ctx;
vm.createContext(ctx);
vm.runInContext(block + '\nthis._stop = _stopKeepAlive;', ctx);

const tick = () => timers.forEach(t => t.fn());
const pings = () => written.filter(s => s.startsWith(': ping')).length;

// 一直有输出：一帧 ping 都不该发
for (let i = 0; i < 10; i++) { now += 3000; res.write('event: delta\ndata: {"text":"x"}\n\n'); tick(); }
check('有输出时不发 ping', pings() === 0, `发了 ${pings()} 帧`);
check('正常输出照样写出去', written.filter(s => s.startsWith('event:')).length === 10, String(written.length));

// 静默 10 秒：还没到 14 秒门槛，不该发
now += 10000; tick();
check('静默 10 秒还不发', pings() === 0, `发了 ${pings()} 帧`);

// 静默到 15 秒：该补一帧
now += 5000; tick();
check('静默超过 14 秒补一帧', pings() === 1, `发了 ${pings()} 帧`);

// 刚发完就再 tick：ping 自己也重置了计时，不该连发
tick();
check('发完不连刷', pings() === 1, `发了 ${pings()} 帧`);

// 再静默一轮：该补第二帧
now += 15000; tick();
check('持续静默会继续补', pings() === 2, `发了 ${pings()} 帧`);

// 恢复输出后又安静下来：计时从最后一次真实输出算
res.write('event: delta\ndata: {"text":"y"}\n\n');
now += 10000; tick();
check('有输出后重新计时', pings() === 2, `发了 ${pings()} 帧`);
now += 5000; tick();
check('再次静默才补', pings() === 3, `发了 ${pings()} 帧`);

// 连接结束后不该再写
ended = true;
now += 60000; tick();
check('连接结束后不再发', pings() === 3, `发了 ${pings()} 帧`);

// ping 必须是完整的一帧，不能是半截
check('ping 是完整 SSE 注释帧', written.filter(s => s.startsWith(': ping')).every(s => s === ': ping\n\n'),
  JSON.stringify(written.find(s => s.startsWith(': ping'))));

console.log();
if (fails.length) { console.log(`✗ ${fails.length} 项失败: ${fails.join(', ')}`); process.exit(1); }
console.log('✓ 全部通过');
