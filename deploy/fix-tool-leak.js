#!/usr/bin/env node
// 工具标签别再漏进聊天气泡。
//   node fix-tool-leak.js [/root/chatnest-api/server.js]
//
// 流式输出时，feedText 只把 <think> 和 <ob> 藏起来，<pulse> 和 <latent> 没管。
// 于是我一做身体结算（<pulse tool="settle">{…json…}</pulse>）或写全文记忆
// （<latent tool="append">{…}</latent>），那段 JSON 就当普通文字流进了气泡。
// 存下来的消息是干净的（跑完 stripPulse/stripLatent 会剥掉），但她眼睁睁看着它流进来。
//
// 把"藏标签"从写死的 think/ob 两种，改成一张表：think 进思考栏，
// ob/pulse/latent 整段吞掉不发（但留在 fullResponse 里，给流式跑完后的解析器）。
//
// 重复执行安全：已经打过就直接退出。

const fs = require('fs');
const vm = require('vm');

const target = process.argv[2] || '/root/chatnest-api/server.js';
if (!fs.existsSync(target)) { console.error('找不到', target); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
if (src.includes("thinkState === 'hidden'")) { console.log('已经打过，跳过'); process.exit(0); }
if (!src.includes("thinkState === 'ob'")) { console.error('找不到 feedText 的标签处理，先打前面的补丁'); process.exit(1); }

const OLD_IDLE = `      if (thinkState === 'idle') {
        const iT = thinkBuf.indexOf('<think>');
        const iO = thinkBuf.indexOf('<ob ');
        let idx = -1, which = '';
        if (iT >= 0 && (iO < 0 || iT < iO)) { idx = iT; which = 'think'; }
        else if (iO >= 0) { idx = iO; which = 'ob'; }
        if (which) {
          const before = thinkBuf.slice(0, idx);
          if (before) { fullResponse += before; sse(res, 'delta', { text: before }); }
          if (which === 'think') {
            thinkBuf = thinkBuf.slice(idx + 7);
            thinkState = 'inside';
            thinkTrace = traceStart('thinking', 'Think process');
          } else {
            thinkBuf = thinkBuf.slice(idx);   // <ob 本身也留着，等收全再一起进 fullResponse
            thinkState = 'ob';
          }
          continue;
        }
        const keep = Math.max(tagTail(thinkBuf, '<think>'), tagTail(thinkBuf, '<ob '));
        const out = thinkBuf.slice(0, thinkBuf.length - keep);
        if (out) { fullResponse += out; sse(res, 'delta', { text: out }); }
        thinkBuf = thinkBuf.slice(thinkBuf.length - keep);
        return;
      }
      if (thinkState === 'ob') {
        const jo = thinkBuf.indexOf('</ob>');
        if (jo >= 0) {
          fullResponse += thinkBuf.slice(0, jo + 5);   // 留给 parseOBToolCalls，但不发给她
          thinkBuf = thinkBuf.slice(jo + 5);
          thinkState = 'idle';
          continue;
        }
        const keepO = tagTail(thinkBuf, '</ob>');
        fullResponse += thinkBuf.slice(0, thinkBuf.length - keepO);
        thinkBuf = thinkBuf.slice(thinkBuf.length - keepO);
        return;
      }`;

const NEW_IDLE = `      if (thinkState === 'idle') {
        // 要藏起来的标签。think 进思考栏；ob/pulse/latent 是写回工具，
        // 整段吞掉不发给她（但留在 fullResponse 里，给流式跑完后的解析器）。
        const HIDE_TAGS = [
          { open: '<think>', kind: 'think' },
          { open: '<ob ', kind: 'hidden', close: '</ob>' },
          { open: '<pulse', kind: 'hidden', close: '</pulse>' },
          { open: '<latent', kind: 'hidden', close: '</latent>' },
        ];
        let best = null;
        for (const tg of HIDE_TAGS) {
          const i = thinkBuf.indexOf(tg.open);
          if (i >= 0 && (!best || i < best.idx)) best = { idx: i, tg: tg };
        }
        if (best) {
          const before = thinkBuf.slice(0, best.idx);
          if (before) { fullResponse += before; sse(res, 'delta', { text: before }); }
          if (best.tg.kind === 'think') {
            thinkBuf = thinkBuf.slice(best.idx + best.tg.open.length);
            thinkState = 'inside';
            thinkTrace = traceStart('thinking', 'Think process');
          } else {
            thinkBuf = thinkBuf.slice(best.idx);   // 开标签也留着，等收全一起进 fullResponse
            thinkState = 'hidden';
            hiddenClose = best.tg.close;
          }
          continue;
        }
        // 半个开标签留在尾巴，等下一段拼上再判断
        let keep = 0;
        for (const tg of HIDE_TAGS) keep = Math.max(keep, tagTail(thinkBuf, tg.open));
        const out = thinkBuf.slice(0, thinkBuf.length - keep);
        if (out) { fullResponse += out; sse(res, 'delta', { text: out }); }
        thinkBuf = thinkBuf.slice(thinkBuf.length - keep);
        return;
      }
      if (thinkState === 'hidden') {
        const jo = thinkBuf.indexOf(hiddenClose);
        if (jo >= 0) {
          fullResponse += thinkBuf.slice(0, jo + hiddenClose.length);   // 留给解析器，但不发给她
          thinkBuf = thinkBuf.slice(jo + hiddenClose.length);
          thinkState = 'idle';
          continue;
        }
        const keepO = tagTail(thinkBuf, hiddenClose);
        fullResponse += thinkBuf.slice(0, thinkBuf.length - keepO);
        thinkBuf = thinkBuf.slice(thinkBuf.length - keepO);
        return;
      }`;

const edits = [
  {
    name: '藏标签改成认全部四种',
    find: OLD_IDLE,
    replace: NEW_IDLE,
  },
  {
    name: '声明 hiddenClose',
    find: "  let thinkState = 'idle', thinkBuf = '', thinkTrace = null;",
    replace: "  let thinkState = 'idle', thinkBuf = '', thinkTrace = null, hiddenClose = '';",
  },
  {
    name: 'flushText 也认 hidden',
    find: "    if (thinkState === 'ob') { fullResponse += thinkBuf; thinkBuf = ''; thinkState = 'idle'; return; }",
    replace: "    if (thinkState === 'hidden') { fullResponse += thinkBuf; thinkBuf = ''; thinkState = 'idle'; return; }",
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
  for (const e of edits) console.log(missed.includes(e.name) ? '  × ' + e.name + ' — 没匹配上' : '  √ ' + e.name);
  console.error('\n有锚点没命中，原文件一个字都没动。');
  process.exit(1);
}

const checks = [
  ['hidden 状态进来了', out.includes("thinkState === 'hidden'")],
  ['四种标签都在表里', /open: '<think>'/.test(out) && /open: '<ob /.test(out)
    && /open: '<pulse'/.test(out) && /open: '<latent'/.test(out)],
  ['hiddenClose 声明了', /thinkTrace = null, hiddenClose = ''/.test(out)],
  ['旧的写死 ob 状态没了', !out.includes("thinkState === 'ob'")],
  ['解析器还在（标签留在 fullResponse）', /parsePulseToolCalls/.test(out) && /parseLatentToolCalls/.test(out)],
  ['真 MCP 工具照旧走 trace', /traceStart\('tool', prettyToolName/.test(out)],
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
