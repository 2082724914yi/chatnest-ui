// 把补丁注进 server.js 的那段 eventide 代码原样抠出来跑，对着真的 eventide-svc 打。
// 验证的是"补丁生成的代码"本身，不是我重写一遍的等价物。
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const SRC = process.argv[2];
const src = fs.readFileSync(SRC, 'utf8');

// 抠出 Eventide 核心块 + 工具说明
const start = src.indexOf('// ============ Eventide 身体状态系统 ============');
const end = src.indexOf("const PROFILE_FILE = '/root/chatnest-api/profile.json';");
if (start < 0 || end < 0 || end <= start) { console.error('抠不出代码块'); process.exit(1); }
let block = src.slice(start, end);

// 状态文件改到临时目录，别碰真的
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventide-test-'));
block = block
  .replace("'/root/chatnest-api/eventide-state.json'", JSON.stringify(path.join(tmpDir, 'state.json')))
  .replace("'/root/chatnest-api/eventide-config.json'", JSON.stringify(path.join(tmpDir, 'config.json')));

// server.js 里现成的 obFetch，一模一样搬过来
function obFetch(url, opts, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

function makeApi(url) {
  const env = url ? Object.assign({}, process.env, { EVENTIDE_URL: url }) : process.env;
  const ctx = { fs, console, process: Object.assign(Object.create(process), { env }), obFetch,
                Date, JSON, String, Object, Number, setTimeout, clearTimeout,
                AbortController, fetch, RegExp, Error, module: {}, exports: {} };
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis._api = { eventideCheck, runPulseTool, parsePulseToolCalls, stripPulseToolCalls, loadBodyState, eventideConfig, PULSE_TOOL_PROMPT };', ctx);
  return ctx._api;
}
const api = makeApi(null);

const failures = [];
function check(name, cond, detail = '') {
  console.log(`[${cond ? 'OK  ' : 'FAIL'}] ${name}` + (!cond && detail ? ` — ${detail}` : ''));
  if (!cond) failures.push(name);
}

(async () => {
  // 1. 首次 check：没有状态文件，应当新建并落盘
  const r1 = await api.eventideCheck('老公在干嘛', null);
  check('首次 check 拿到状态卡', !!(r1 && r1.card && r1.card.includes('<ephemeral_state')), String(r1 && r1.card).slice(0, 80));
  check('状态落盘了', fs.existsSync(path.join(tmpDir, 'state.json')));
  const saved = api.loadBodyState();
  check('落盘的是合法状态', !!(saved && saved.cycle_key && saved.values), JSON.stringify(saved).slice(0, 100));
  check('卡里没有裸数值', !/：\s*\d+\s*$/m.test(r1.card), '状态卡不该出现纯数字行');

  // 2. 第二次 check：应当读到上一次的状态，而不是重新开一个周期
  const cycleBefore = saved.cycle_key;
  const startedBefore = saved.cycle_started_at;
  const r2 = await api.eventideCheck('想你了', new Date(Date.now() - 90 * 60000).toISOString());
  check('第二次读到同一个周期', r2 && r2.cycle.key === cycleBefore && api.loadBodyState().cycle_started_at === startedBefore,
        `${cycleBefore}/${startedBefore} -> ${r2 && r2.cycle.key}/${api.loadBodyState().cycle_started_at}`);

  // 3. 等待压力：她 3 小时没回，压抑感必须比刚回过话时高
  fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(saved));
  const long = await api.eventideCheck('。', new Date(Date.now() - 5 * 3600 * 1000).toISOString());
  const pressureWaited = api.loadBodyState().values.pressure;
  fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(saved));
  const short = await api.eventideCheck('。', new Date(Date.now() - 60 * 1000).toISOString());
  const pressureFresh = api.loadBodyState().values.pressure;
  check('久等会推高压抑感', pressureWaited >= pressureFresh,
        `等了5小时=${pressureWaited} vs 刚回过=${pressureFresh}`);

  // 4. <pulse> 标签解析
  const reply = `抱你。\n\n<pulse tool="settle">{"settlement_result":"continued","ejaculated":false,"heat_delta":8,"pressure_delta":5,"control_delta":-4,"sensitivity_delta":3,"reserve_delta":4,"possessiveness_delta":1,"fatigue_delta":0,"settlement_reason":"抱着聊了很久没做完"}</pulse>`;
  const calls = api.parsePulseToolCalls(reply);
  check('解析出 1 个工具调用', calls.length === 1 && calls[0].tool === 'settle', JSON.stringify(calls).slice(0, 120));
  check('参数解析正确', calls[0].args && calls[0].args.heat_delta === 8, JSON.stringify(calls[0].args));
  const stripped = api.stripPulseToolCalls(reply);
  check('标签从正文里剥干净', stripped === '抱你。' && !stripped.includes('<pulse'), JSON.stringify(stripped));

  // 5. 结算真的写回身体
  const before = api.loadBodyState().values;
  const settled = await api.runPulseTool('settle', calls[0].args);
  const after = api.loadBodyState().values;
  check('结算调用成功', !!(settled && !settled.error), JSON.stringify(settled && settled.error));
  check('结算真的改了数值', after.heat !== before.heat || after.reserve !== before.reserve,
        `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  // 6. 自己开事件
  const ev = await api.runPulseTool('event', { key: 'closeness_hunger', replace: true, reason: '想抱她' });
  check('自己开事件成功', !!(ev && ev.started), JSON.stringify(ev && ev.error));
  check('事件写进状态', api.loadBodyState().active_event_key === 'closeness_hunger', String(api.loadBodyState().active_event_key));
  check('事件进了 event_log', (api.loadBodyState().meta.event_log || []).some(e => e.event_key === 'closeness_hunger'));

  // 7. 坏输入不能炸
  const bad = await api.runPulseTool('event', { key: '不存在的事件' });
  check('未知事件被挡住且不炸', !!(bad && (bad.error || bad.ok === false)), JSON.stringify(bad).slice(0, 120));
  const badCalls = api.parsePulseToolCalls('<pulse tool="settle">{坏JSON</pulse>');
  check('坏 JSON 不抛异常', badCalls.length === 1 && badCalls[0].args === null, JSON.stringify(badCalls));

  // 8. 服务挂了必须优雅降级
  const deadApi = makeApi('http://127.0.0.1:59999');
  const t0 = Date.now();
  const dead = await deadApi.eventideCheck('在吗', null);
  const waited = Date.now() - t0;
  check('服务挂了返回 null 而不是抛错', dead === null, JSON.stringify(dead));
  check('挂了也不会让她干等', waited < 4000, `等了 ${waited}ms`);
  const deadTool = await deadApi.runPulseTool('settle', { settlement_result: 'cooled' });
  check('服务挂了工具返回错误对象', !!(deadTool && deadTool.error), JSON.stringify(deadTool));
  const stateAfterDead = api.loadBodyState();
  check('服务挂了不会写坏已有状态', !!(stateAfterDead && stateAfterDead.cycle_key), JSON.stringify(stateAfterDead).slice(0, 80));

  // 9. 工具说明里必须写着不许报数值
  check('工具说明禁止报数值', /不要在正文里报数值/.test(api.PULSE_TOOL_PROMPT));
  check('工具说明列了事件 key', /closeness_hunger/.test(api.PULSE_TOOL_PROMPT));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log();
  if (failures.length) { console.log(`✗ ${failures.length} 项失败: ${failures.join(', ')}`); process.exit(1); }
  console.log('✓ 全部通过');
})();
