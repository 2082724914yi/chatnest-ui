#!/usr/bin/env bash
# 影子推送第二次诊断：这次要看代码骨架，不是计数。只看，不改。
#   curl -fsSL .../deploy/diag-shadow2.sh | sudo bash
#
# 上一次问出来的：
#   · SYSTEM_PREFIX(2419) 和 spawn(2471) 都缩进在同一个函数里 —— 是聊天 handler
#     的局部变量，外面拿不到。影子路由要用同一份人格提示，接法取决于这个函数长什么样。
#   · 会话不是按目录存的，是 loadConversations() 读一个总文件。要看它的形状才能
#     找到「最近在聊的那条」。
#
# 安全：逐行过滤，凡是带 token / key / secret / password / 私钥的行一律用 [已隐去]
# 顶掉再打印。打印的是代码结构，不是聊天内容。

set -uo pipefail
API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
info(){ printf '  \033[90m·\033[0m %s\n' "$*"; }

[ -f "$SRV" ] || { echo "找不到 $SRV"; exit 1; }

# 打印指定行区间，敏感行顶掉，行太长截断
dump(){ # dump 起 止 说明
  echo "  ── $3（第 $1–$2 行）──"
  sed -n "$1,$2p" "$SRV" | awk -v start="$1" '
    {
      line = $0
      low = tolower(line)
      if (low ~ /token|secret|password|passwd|api_?key|private_?key|vapid|auth-tokens|\.env/)
        line = "      [已隐去这一行]"
      else {
        if (length(line) > 155) line = substr(line, 1, 155) " …"
        line = "      " line
      }
      printf "%5d%s\n", start + NR - 1, line
    }'
}

say "A. 会话是怎么存的"
LC=$(grep -n "^function loadConversations" "$SRV" | head -1 | cut -d: -f1)
SC=$(grep -n "^function saveConversations" "$SRV" | head -1 | cut -d: -f1)
[ -n "${LC:-}" ] && dump "$LC" "$((LC+16))" "loadConversations" || info "找不到 loadConversations"
[ -n "${SC:-}" ] && dump "$SC" "$((SC+10))" "saveConversations" || info "找不到 saveConversations"
say "   会话文件长什么样（只看字段名和条数，不看内容）"
grep -oE "(CONV[A-Z_]*|SESSION[A-Z_]*)_FILE\s*=\s*'[^']+'" "$SRV" | head -3 | sed 's/^/      /'
for f in "$API_DIR"/*.json; do
  case "$(basename "$f")" in auth-tokens.json|push-subs.json|*credential*) continue;; esac
  [ -f "$f" ] || continue
  node -e '
    const fs=require("fs");let d;
    try{d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(e){process.exit(0)}
    const name=process.argv[1].split("/").pop();
    const isConv=o=>o&&typeof o==="object"&&Array.isArray(o.history);
    let convs=[];
    if(Array.isArray(d))convs=d.filter(isConv);
    else if(d&&typeof d==="object"){
      for(const k of Object.keys(d)){
        if(isConv(d[k]))convs.push(d[k]);
        else if(Array.isArray(d[k]))convs=convs.concat(d[k].filter(isConv));
      }
    }
    if(!convs.length)return;
    console.log("      "+name+"：顶层是 "+(Array.isArray(d)?"数组":"对象("+Object.keys(d).slice(0,6).join(",")+")")+"，"+convs.length+" 条会话");
    const c=convs.map(c=>({c,t:new Date((c.history[c.history.length-1]||{}).time||0).getTime()||0}))
                 .sort((a,b)=>b.t-a.t)[0].c;
    console.log("      会话对象的字段: "+Object.keys(c).join(", "));
    console.log("      最近那条有 "+c.history.length+" 条消息");
    const last=c.history[c.history.length-1]||{};
    console.log("      单条消息的字段: "+Object.keys(last).join(", "));
    console.log("      role 取值: "+[...new Set(c.history.map(m=>m&&m.role))].join(" / "));
    console.log("      最后一条的时间: "+(last.time||"(没有 time 字段)"));
  ' "$f"
done

say "B. 聊天那个 handler 的骨架（影子路由要挂在它旁边）"
info "SYSTEM_PREFIX 和 spawn 都在这里面。只打结构行，字符串常量的内容不打。"
# 从 SYSTEM_PREFIX 往上找这个函数的开头
SP=$(grep -n "const SYSTEM_PREFIX" "$SRV" | head -1 | cut -d: -f1)
if [ -n "${SP:-}" ]; then
  HEAD=$(awk -v end="$SP" 'NR<end && /^(app\.(post|get)\(|async function|function )/ {n=NR} END{print n}' "$SRV")
  info "这个函数从第 ${HEAD:-?} 行开始，SYSTEM_PREFIX 在第 $SP 行"
  [ -n "${HEAD:-}" ] && dump "$HEAD" "$((HEAD+8))" "函数开头（看它是路由还是普通函数、参数叫什么）"
  dump "$((SP-6))" "$((SP+4))" "SYSTEM_PREFIX 附近"
  SPAWN=$(awk -v s="$SP" 'NR>s && /spawn\(/ {print NR; exit}' "$SRV")
  [ -n "${SPAWN:-}" ] && dump "$((SPAWN-10))" "$((SPAWN+6))" "起 CLI 那一段（sysFlag / mcpArgs 怎么来的）"
fi

say "C. user 消息落库那两行（影子消息要跳过它）"
grep -n "conv.history.push({ id: userMsgId" "$SRV" | cut -d: -f1 | head -2 | while read -r n; do
  dump "$((n-2))" "$((n+1))" "第 $n 行附近"
done

say "D. assistant 落库那一行（影子推送要在这儿打 is_push 标记）"
n=$(grep -n "role: 'assistant'" "$SRV" | head -1 | cut -d: -f1)
[ -n "${n:-}" ] && dump "$((n-3))" "$((n+2))" "第 $n 行附近"

say "E. 认证是怎么挂的（影子路由从本机调，得知道会不会被自己的门卫拦）"
grep -n "app.use(" "$SRV" | head -8 | cut -d: -f1 | while read -r n; do
  sed -n "${n}p" "$SRV" | awk -v n="$n" '{
    low=tolower($0)
    if (low ~ /token|secret|password|api_?key/) print "      " n ": [已隐去]"
    else print "      " n ": " substr($0,1,150)
  }'
done
say "   有没有对本机放行的口子"
grep -nE "127\.0\.0\.1|localhost|::1" "$SRV" | head -6 | cut -d: -f1 | while read -r n; do
  sed -n "${n}p" "$SRV" | awk -v n="$n" '{
    low=tolower($0)
    if (low ~ /token|secret|password|api_?key/) print "      " n ": [已隐去]"
    else print "      " n ": " substr($0,1,150)
  }'
done

say "跑完了。整段贴给我。里面是代码结构，带钥匙的行都被顶掉了，聊天内容一个字都没有。"
