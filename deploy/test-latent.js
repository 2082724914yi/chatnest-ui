// 把补丁注进 server.js 的那段 latent 代码原样抠出来，对着真服务打
const fs=require('fs'), vm=require('vm'), os=require('os'), path=require('path');
const src=fs.readFileSync(process.argv[2],'utf8');
const a=src.indexOf('// ============ Latent·显影：全文层记忆 ============');
const b=src.indexOf("const PROFILE_FILE = '/root/chatnest-api/profile.json';");
if(a<0||b<=a){console.error('抠不出来');process.exit(1)}
let block=src.slice(a,b);

// 口令改到临时 .env，别碰真的
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'latent-test-'));
fs.writeFileSync(path.join(tmp,'.env'),'LATENT_TOKEN=testtoken\n');
block=block.replace("'/root/chatnest-api/.env'", JSON.stringify(path.join(tmp,'.env')));

function obFetch(url,opts,ms=8000){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);
  return fetch(url,{...opts,signal:c.signal}).finally(()=>clearTimeout(t));}

function makeApi(url){
  const env=url?Object.assign({},process.env,{LATENT_URL:url}):Object.assign({},process.env,{LATENT_TOKEN:''});
  if(!url) delete env.LATENT_TOKEN;
  const ctx={fs,console,process:Object.assign(Object.create(process),{env}),obFetch,Date,JSON,String,Object,
             Number,setTimeout,clearTimeout,AbortController,fetch,RegExp,Error,module:{},exports:{}};
  ctx.global=ctx; vm.createContext(ctx);
  vm.runInContext(block+'\nthis._api={latentCall,parseLatentToolCalls,stripLatentToolCalls,runLatentTool,latentToken,LATENT_TOOL_PROMPT,LATENT_TOOL_LABEL};',ctx);
  return ctx._api;
}
const api=makeApi(null);
const fails=[]; const check=(n,c,d='')=>{console.log(`[${c?'OK  ':'FAIL'}] ${n}`+(!c&&d?` — ${d}`:''));if(!c)fails.push(n)};

(async()=>{
  check('从 .env 读到口令', api.latentToken()==='testtoken', api.latentToken());

  const recall=await api.latentCall('latent_session_start',{});
  check('session_start 调通', typeof recall==='string' && recall.length>10, String(recall).slice(0,120));

  const w=await api.runLatentTool('append',{text:'虚构测试：她说楼下那只三花猫今天没出来晒太阳，她绕了一圈没找到。',current_state:'没找到猫，她有点惦记',unresolvedOps:[{action:'none'}]});
  check('append 写回成功', !!(w&&!w.error), JSON.stringify(w).slice(0,200));

  const s=await api.latentCall('latent_search',{query:'三花猫'});
  check('写完能检索到', typeof s==='string' && s.includes('三花'), String(s).slice(0,200));

  const reply='嗯，我记着了。\n\n<latent tool="append">{"text":"她说明天要去还书","current_state":"还没去"}</latent>';
  const calls=api.parseLatentToolCalls(reply);
  check('标签解析出 1 条', calls.length===1&&calls[0].tool==='append', JSON.stringify(calls).slice(0,150));
  check('参数解析对', calls[0].args&&calls[0].args.text.includes('还书'), JSON.stringify(calls[0].args));
  const stripped=api.stripLatentToolCalls(reply);
  check('标签从正文剥干净', stripped==='嗯，我记着了。'&&!stripped.includes('<latent'), JSON.stringify(stripped));

  const bad=api.parseLatentToolCalls('<latent tool="append">{坏JSON</latent>');
  check('坏 JSON 不抛异常', bad.length===1&&bad[0].args===null, JSON.stringify(bad));
  const unk=await api.runLatentTool('nope',{});
  check('未知工具被挡住', !!(unk&&unk.error), JSON.stringify(unk));

  // 服务挂了必须优雅降级
  const dead=makeApi('http://127.0.0.1:59998');
  const t0=Date.now();
  const d=await dead.latentCall('latent_session_start',{});
  check('服务挂了返回 null 不抛错', d===null, JSON.stringify(d));
  check('挂了不会让她干等', Date.now()-t0<25000, `${Date.now()-t0}ms`);

  // 没口令时不该发请求
  const noTok=makeApi(null);
  check('工具说明里写了分工', /OB\s+提炼过的/.test(api.LATENT_TOOL_PROMPT)||/提炼/.test(api.LATENT_TOOL_PROMPT));
  check('工具说明里写了不要复述', /不要在正文里跟她复述/.test(api.LATENT_TOOL_PROMPT));

  fs.rmSync(tmp,{recursive:true,force:true});
  console.log();
  if(fails.length){console.log(`✗ ${fails.length} 项失败: ${fails.join(', ')}`);process.exit(1)}
  console.log('✓ 全部通过');
})();
