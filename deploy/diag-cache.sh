#!/usr/bin/env bash
# 缓存诊断：先看清楚现在到底花在哪，再谈怎么省。
#   curl -fsSL .../deploy/diag-cache.sh | sudo bash
#
# 只读 server.js，不改任何东西。
# ⚠ 会花一点点额度：末尾实测两次 `claude -p`，每次就说一个字，加起来不到一轮聊天。
#   不想花就 NO_PROBE=1 sudo bash，前面几节照样出结果。
#
# 想验的三件事（都来自「离」那篇 claude-p-save-tokens 和 CLI 自己的 --help）：
#
# 1. sysFlag 是 --system-prompt（整张替换）还是 --append-system-prompt（在默认那张
#    臃肿提示后面追加）。追加的话，Claude Code 自带的那套 agent 提示还压在前面。
# 2. 有没有 --tools。不加的话，十几个内置工具（Read/Write/Bash/Grep/WebSearch/
#    ToolSearch…）的说明书每轮都在输入里。--tools "" 能把它们全砍掉，
#    而 MCP 工具（OB / 朋友圈 / Keepsake / files）走的是 --mcp-config，不在这个集合里，
#    照理不受影响 —— 这一条本脚本会实测，不靠猜。
# 3. 实际命中率。前缀稳不稳，只有账单说了算。

set -uo pipefail
API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
ok(){   printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){   printf '  \033[31m×\033[0m %s\n' "$*"; }
info(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){  printf '\n\033[1m%s\033[0m\n' "$*"; }
scrub(){ awk '{l=tolower($0); if (l ~ /token|secret|password|api_?key|vapid/) print "      [已隐去]"; else print "      " substr($0,1,190)}'; }

[ -f "$SRV" ] || { no "找不到 $SRV"; exit 1; }

say "1/5 起 CLI 的那条命令，到底带了什么参数"
grep -n "stdbuf -o0 /usr/bin/claude -p" "$SRV" | cut -d: -f1 | head -3 | while read -r n; do
  echo "  ── 第 $n 行 ──"
  sed -n "${n}p" "$SRV" | scrub
done
say "   那几个 flag 变量是怎么拼出来的"
grep -nE "(sysFlag|modelFlag|mcpArgs)\s*=" "$SRV" | head -6 | cut -d: -f1 | while read -r n; do
  sed -n "${n}p" "$SRV" | scrub
done

say "2/5 系统提示：替换还是追加"
A=$(grep -c -- '--append-system-prompt' "$SRV" 2>/dev/null || true)
R=$(grep -c -- '--system-prompt' "$SRV" 2>/dev/null || true)
info "出现 --append-system-prompt ： ${A:-0} 次"
info "出现 --system-prompt（含上面那些）： ${R:-0} 次"
if [ "${A:-0}" -gt 0 ]; then
  no "在用「追加」—— Claude Code 自带那张 agent 系统提示还压在你的人设前面"
  info "  它是稳定的，所以能命中缓存，但每轮仍按缓存价读一遍，而且占着上下文"
else
  ok "没用追加"
fi

say "3/5 内置工具的说明书有没有被砍掉"
if grep -q -- "--tools" "$SRV"; then
  ok "命令里有 --tools"
  grep -n -- "--tools" "$SRV" | head -3 | cut -d: -f1 | while read -r n; do sed -n "${n}p" "$SRV" | scrub; done
else
  no "没有 --tools —— 十几个内置工具的说明书每轮都在输入里"
  info "  你其实用不到它们：CLI_DENY_TOOLS 本来就拦着不让执行，但说明书照样占 token"
fi
if grep -q -- '--exclude-dynamic-system-prompt-sections' "$SRV"; then
  ok "有 --exclude-dynamic-system-prompt-sections"
else
  info "没有 --exclude-dynamic-system-prompt-sections（把 cwd/env/git 这些每台机器不同的段落"
  info "  挪出系统提示，前缀更稳。注意：只对默认系统提示生效，用了 --system-prompt 就无效）"
fi

say "4/5 最近几轮的实际账单"
FOUND=0
for f in "$API_DIR"/*.json "$API_DIR"/logs/*.json; do
  [ -f "$f" ] || continue
  case "$(basename "$f")" in auth-tokens.json|push-subs.json|.env) continue;; esac
  node -e '
    const fs=require("fs");let d;
    try{d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(e){process.exit(0)}
    const rows=[];
    const walk=(o,depth)=>{
      if(!o||typeof o!=="object"||depth>4)return;
      if(o.usage&&typeof o.usage==="object")rows.push(o.usage);
      else if(("input_tokens" in o)||("cache_read_input_tokens" in o))rows.push(o);
      if(Array.isArray(o))o.slice(-40).forEach(x=>walk(x,depth+1));
      else Object.values(o).slice(0,60).forEach(x=>walk(x,depth+1));
    };
    walk(d,0);
    if(!rows.length)process.exit(0);
    const last=rows.slice(-6);
    console.log("      来自 "+process.argv[1].split("/").pop()+"，最近 "+last.length+" 条：");
    let sIn=0,sRead=0,sWrite=0;
    for(const u of last){
      const i=u.input_tokens||0, r=u.cache_read_input_tokens||0, w=u.cache_creation_input_tokens||0, o=u.output_tokens||0;
      sIn+=i;sRead+=r;sWrite+=w;
      const tot=i+r+w;
      const pct=tot?Math.round(r/tot*100):0;
      console.log("        新付 "+String(i).padStart(6)+"  缓存读 "+String(r).padStart(7)+"  缓存写 "+String(w).padStart(6)+"  出 "+String(o).padStart(5)+"   命中 "+pct+"%");
    }
    const tot=sIn+sRead+sWrite;
    if(tot)console.log("      合计命中率 "+Math.round(sRead/tot*100)+"%（缓存读 / 总输入）");
  ' "$f" && FOUND=1
done
[ "$FOUND" = 1 ] || info "没在 JSON 里找到 usage 记录 —— 去前端「设置 → 统计」看那一屏，截图给我"

say "5/5 实测：内置工具到底占多少"
if [ "${NO_PROBE:-0}" = 1 ]; then
  info "跳过（NO_PROBE=1）"
else
  info "跑两次 claude -p，每次只说一个字。加起来不到一轮聊天的量。"
  probe(){ # probe 说明 额外参数...
    local label="$1"; shift
    local out
    out=$(cd "$API_DIR" && timeout 180 /usr/bin/claude -p "$@" --output-format json "说：好" 2>/dev/null)
    printf '%s' "$out" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        let j={};try{j=JSON.parse(s)}catch(e){console.log("        （没拿到账单，可能超时或没登录）");process.exit(0)}
        const u=j.usage||{};
        const i=u.input_tokens||0,r=u.cache_read_input_tokens||0,w=u.cache_creation_input_tokens||0;
        console.log("        新付 "+i+"  缓存读 "+r+"  缓存写 "+w+"  → 这轮总输入 "+(i+r+w));
      });'
  }
  echo "      ① 默认（什么都不加）："
  probe "默认"
  echo "      ② 砍掉全部内置工具（--tools \"\"）："
  probe "无工具" --tools ""
  info "两者之差 ≈ 内置工具说明书每轮占的量"
  info "注意 ② 里 MCP 工具没接（没带 --mcp-config），所以这只是内置那部分的对比"
fi

say "跑完了。整段贴给我。里面没有聊天内容，带钥匙的行都顶掉了。"
