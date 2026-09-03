// 把补丁生成的分支代码抠出来，用真实形状的会话数据打一遍
const fs=require('fs'), vm=require('vm'), os=require('os'), path=require('path');
const src=fs.readFileSync(process.argv[2],'utf8');
const a=src.indexOf('// ============ 消息编辑与对话分支 ============');
const b=src.indexOf("const PROFILE_FILE = '/root/chatnest-api/profile.json';");
if(a<0||b<=a){console.error('抠不出来');process.exit(1)}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'br-'));
let block=src.slice(a,b).replace("'/root/chatnest-api/branches'", JSON.stringify(path.join(tmp,'branches')));

let n=0; const uid=()=>'x'+(++n);
function makeApi(dir){
  const blk=src.slice(a,b).replace("'/root/chatnest-api/branches'", JSON.stringify(dir));
  const ctx={fs,require,console,uid,Date,JSON,String,Array,module:{},exports:{}};
  ctx.global=ctx; vm.createContext(ctx);
  vm.runInContext(blk+'\nthis._api={saveBranch,loadBranch,listBranches,forkForEdit,forkForRetry,mergeRetryBranches};',ctx);
  return ctx._api;
}
const api=makeApi(path.join(tmp,'branches'));

const fails=[]; const check=(n,c,d='')=>{console.log(`[${c?'OK  ':'FAIL'}] ${n}`+(!c&&d?` — ${d}`:''));if(!c)fails.push(n)};
const mk=()=>({history:[
  {id:'m1',role:'user',content:'今天天气怎么样'},
  {id:'m2',role:'assistant',content:'晴天，适合出门'},
  {id:'m3',role:'user',content:'推荐个餐厅吧'},
  {id:'m4',role:'assistant',content:'推荐 xx 火锅'},
  {id:'m5',role:'user',content:'那甜品呢'},
  {id:'m6',role:'assistant',content:'楼下那家'},
]});

// 1. 编辑：截断 + 存分支
let conv=mk();
const r=api.forkForEdit(conv,'conv-1','m3');
check('编辑分叉成功', r.ok, JSON.stringify(r));
check('截断到编辑点之前', conv.history.length===2 && conv.history.at(-1).id==='m2', JSON.stringify(conv.history.map(m=>m.id)));
check('被截掉的存了 4 条', r.removed===4, String(r.removed));
const saved=api.loadBranch('conv-1',r.branch_id);
check('分支能读回来', !!saved && saved.messages.length===4, JSON.stringify(saved&&saved.messages.map(m=>m.id)));
check('分支里带着被编辑的那条本身', saved.messages[0].id==='m3', saved.messages[0].id);
check('分支记了分叉点', saved.meta.fork_id==='m3', JSON.stringify(saved.meta));
check('分支记了编辑前的原文', /推荐个餐厅/.test(saved.meta.original_content), saved.meta.original_content);

// 2. 编辑不存在的消息：不能截断
conv=mk();
const r2=api.forkForEdit(conv,'conv-1','nope');
check('编辑不存在的消息不动历史', !r2.ok && conv.history.length===6, JSON.stringify(r2));

// 3. 重新生成：旧回复被摘下来
conv=mk();
const old=api.forkForRetry(conv,'conv-1','m6');
check('摘下了旧回复', !!old && old.id==='m6', JSON.stringify(old));
check('历史截断到用户那句', conv.history.length===5 && conv.history.at(-1).id==='m5', JSON.stringify(conv.history.map(m=>m.id)));
const merged=api.mergeRetryBranches({id:'m7',role:'assistant',content:'新回答：对面那家',time:'t'},old);
check('新回复带上了两个版本', merged.branches.length===2, JSON.stringify(merged.branches.map(b=>b.content)));
check('旧版本在第一个', /楼下那家/.test(merged.branches[0].content), merged.branches[0].content);
check('当前指向最新', merged.branch_idx===1 && merged.branch_count===2, `${merged.branch_idx}/${merged.branch_count}`);

// 4. 再重生成一次：三个版本，旧的都在
const old2={...merged};
const merged2=api.mergeRetryBranches({id:'m8',role:'assistant',content:'第三次',time:'t'},old2);
check('第三次重生成保住了前两版', merged2.branches.length===3, JSON.stringify(merged2.branches.map(b=>b.content)));

// 5. 没有 retry 时不该乱加 branches
const plain=api.mergeRetryBranches({id:'m9',role:'assistant',content:'普通回复'},null);
check('普通回复不加分支', !plain.branches, JSON.stringify(plain));

// 6. 分支列表
const list=api.listBranches('conv-1');
check('列得出分支', list.length>=2, JSON.stringify(list.map(x=>x.id)));
check('列表带预览', list.every(x=>typeof x.preview==='string'), JSON.stringify(list[0]));

// 7. 存盘失败时绝不截断（把目录做成只读）
conv=mk();
// 以 root 跑时 chmod 拦不住，改成把 BRANCH_DIR 指到一个「文件」下面，mkdir 必然 ENOTDIR
const blocker=path.join(tmp,'iam-a-file');
fs.writeFileSync(blocker,'x');
const brokenApi=makeApi(path.join(blocker,'branches'));
const r3=brokenApi.forkForEdit(conv,'conv-ro','m3');
check('存不下就不截断（历史完好）', !r3.ok && conv.history.length===6, `${JSON.stringify(r3)} len=${conv.history.length}`);

fs.rmSync(tmp,{recursive:true,force:true});
console.log();
if(fails.length){console.log(`✗ ${fails.length} 项失败: ${fails.join(', ')}`);process.exit(1)}
console.log('✓ 全部通过');
