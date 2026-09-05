#!/usr/bin/env bash
# 影子推送要接进哪儿 —— 只看，不改任何东西。
#   curl -fsSL .../deploy/diag-shadow.sh | sudo bash
#
# 影子路由的做法是：借用她正在聊的那条真会话，在末尾临时塞一条伪造的 user 消息，
# 用**跟聊天完全一样的 system prompt** 走一遍，把生成的话存回真会话。
# 所以我得先看清楚三件事：会话长什么样、CLI 怎么调、系统提示在哪拼。
#
# 只打印函数签名和字段名，不打印聊天内容、不打印 token、不打印 .env。

set -uo pipefail
API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"

ok(){   printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){   printf '  \033[31m×\033[0m %s\n' "$*"; }
info(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){  printf '\n\033[1m%s\033[0m\n' "$*"; }
# 只截取到行首那段声明，避免把字符串常量里的内容带出来
sig(){ sed -n "${1}p" "$SRV" | sed 's/[[:space:]]\+/ /g' | cut -c1-170; }

[ -f "$SRV" ] || { no "找不到 $SRV"; exit 1; }
info "server.js $(wc -l < "$SRV") 行"

say "1/5 CLI 是怎么起的"
for pat in "spawn(" "execFile(" "'-p'" '"-p"' "--resume" "--mcp-config" "--append-system-prompt" "--system-prompt"; do
  n=$(grep -cF -- "$pat" "$SRV" 2>/dev/null || true)
  [ "${n:-0}" != 0 ] && info "$pat → $n 处"
done
say "   起进程那几行"
grep -nE "(spawn|execFile)\s*\(" "$SRV" | head -6 | while IFS=: read -r n _; do
  echo "      $n: $(sig "$n")"
done

say "2/5 会话存在哪、字段叫什么"
for pat in "conv.history" "loadConv" "saveConv" "CONV_DIR" "SESSIONS_DIR" "conversation_id"; do
  n=$(grep -cF -- "$pat" "$SRV" 2>/dev/null || true)
  [ "${n:-0}" != 0 ] && info "$pat → $n 处"
done
grep -nE "(function (loadConv|saveConv|readConv|writeConv)|const (CONV_DIR|SESSIONS_DIR))" "$SRV" | head -5 | while IFS=: read -r n _; do
  echo "      $n: $(sig "$n")"
done
say "   存 assistant 消息那一行（影子推送要照着它落库）"
grep -nE "history\.push\(\{[^}]*role:\s*'assistant'" "$SRV" | head -3 | while IFS=: read -r n _; do
  echo "      $n: $(sig "$n")"
done

say "3/5 系统提示在哪拼"
for v in SYSTEM_PREFIX daemonSysFile PERSONA MOMENTS_TOOL_PROMPT KEEPSAKE_TOOL_PROMPT; do
  n=$(grep -cF -- "$v" "$SRV" 2>/dev/null || true)
  [ "${n:-0}" != 0 ] && info "$v → $n 处"
done
grep -nE "(const|let|var) SYSTEM_PREFIX|function daemonSysFile" "$SRV" | head -3 | while IFS=: read -r n _; do
  echo "      $n: $(sig "$n")"
done

say "4/5 影子消息的素材有哪些现成的"
for pat in "loadMoments" "SUMMARY" "摘要" "compaction" "buildHandoff" "PROFILE_FILE" "latent"; do
  n=$(grep -cF -- "$pat" "$SRV" 2>/dev/null || true)
  [ "${n:-0}" != 0 ] && info "$pat → $n 处"
done

say "5/5 哪条会话是「当前活跃」的"
# 影子推送要往最近在聊的那条里塞。看会话文件是怎么组织的（只看文件名和时间，不看内容）
for d in "$API_DIR/conversations" "$API_DIR/sessions" "$API_DIR/convs" "$API_DIR/data"; do
  [ -d "$d" ] || continue
  n=$(find "$d" -maxdepth 2 -name '*.json' 2>/dev/null | wc -l)
  ok "$d 有 $n 个 json"
  find "$d" -maxdepth 2 -name '*.json' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -3 |
    while read -r t f; do info "   最近改动: $(basename "$f")  $(date -d @"${t%.*}" '+%m-%d %H:%M')"; done
  # 最近那条的字段名（只打 key，不打 value）
  RECENT=$(find "$d" -maxdepth 2 -name '*.json' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
  [ -n "${RECENT:-}" ] && node -e '
    const fs=require("fs");
    let d; try{d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(e){process.exit(0)}
    console.log("      顶层字段: "+Object.keys(d).join(", "));
    const h=d.history||d.messages||[];
    if(Array.isArray(h)&&h.length){
      console.log("      共 "+h.length+" 条消息");
      const last=h[h.length-1];
      console.log("      单条消息的字段: "+Object.keys(last).join(", "));
      console.log("      role 取值: "+[...new Set(h.map(m=>m&&m.role))].join(" / "));
    }
  ' "$RECENT"
done

say "跑完了。整段贴给我 —— 里面只有字段名和函数签名，没有聊天内容，没有 token。"
