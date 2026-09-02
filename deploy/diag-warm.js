#!/usr/bin/env node
/* 测"预热"可不可行：
   CLI 是先把认证/插件/MCP 都加载好再等输入，还是拿到输入才开始加载？
   如果是前者，就可以在她打字之前先把进程拉起来晾着，消息一到直接喂进去，
   那 20 秒就完全不用她等了。

   做法：spawn 之后先不写 stdin，晾 WARM 秒，再写入提示词，
   然后量「从写入那一刻到第一个字」用了多久。
   对照组是正常的冷启动。

   用法：curl -fsSL .../deploy/diag-warm.js | sudo node -
*/
const { spawn } = require('child_process');
const CLI = process.env.CLI || '/usr/bin/claude';
const MODEL = process.env.MODEL || 'claude-sonnet-5';
const WARM = Number(process.env.WARM || 25);
const PROMPT = '说一个字：好';

function run({ warmSec }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let tFirstOut = null, tWrite = null, tFirstText = null, sawInit = null;
    const p = spawn(CLI, ['-p', '--model', MODEL, '--verbose',
      '--include-partial-messages', '--output-format', 'stream-json'], {
      env: { ...process.env, HOME: '/root', TERM: 'dumb' },
      cwd: '/root/chatnest-api',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let buf = '';
    p.stdout.on('data', (c) => {
      if (tFirstOut === null) tFirstOut = Date.now();
      buf += c.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (sawInit === null && o.type === 'system') sawInit = Date.now();
        const s = JSON.stringify(o);
        if (tFirstText === null && s.includes('text_delta')) tFirstText = Date.now();
      }
    });
    p.stderr.on('data', () => {});
    // 晾一会儿再喂输入
    setTimeout(() => { tWrite = Date.now(); p.stdin.end(PROMPT + '\n'); }, warmSec * 1000);
    p.on('close', () => {
      const s = (a, b) => (a && b ? ((a - b) / 1000).toFixed(1) + 's' : '—');
      resolve({
        晾置: warmSec + 's',
        写入前是否已有输出: tFirstOut && tWrite && tFirstOut < tWrite ? '是' : '否',
        写入前是否已完成初始化: sawInit && tWrite && sawInit < tWrite ? '是' : '否',
        从写入到第一个字: s(tFirstText, tWrite),
        从启动到第一个字: s(tFirstText, t0)
      });
    });
    setTimeout(() => { if (!p.killed) p.kill('SIGTERM'); }, (warmSec + 120) * 1000);
  });
}

(async () => {
  console.log('\n=== 对照组：冷启动（spawn 后立刻喂输入）===');
  console.log(await run({ warmSec: 0 }));
  console.log(`\n=== 实验组：先晾 ${WARM} 秒再喂输入 ===`);
  const r = await run({ warmSec: WARM });
  console.log(r);
  console.log('\n结论：');
  const t = parseFloat(r['从写入到第一个字']);
  if (r['写入前是否已完成初始化'] === '是' && t > 0 && t < 10) {
    console.log('  可以预热。CLI 会先把该加载的都加载完再等输入，');
    console.log(`  预热之后她只需要等 ${r['从写入到第一个字']}，那 20 秒可以省掉。`);
  } else {
    console.log('  预热没用。CLI 要等拿到输入才开始干活，那 20 秒躲不掉，');
    console.log('  得换别的路子（比如常驻会话）。');
  }
  console.log();
})();
