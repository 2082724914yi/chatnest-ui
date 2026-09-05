#!/usr/bin/env bash
# 常驻会话那条路的系统提示文件，里面到底是新的还是旧的 —— 只读，不改。
#   curl -fsSL .../deploy/diag-daemon-sys.sh | sudo bash
#
# 现象：fix-think-voice 打上了（server.js 里有 THINK_VOICE_V2），可她那边 think
# 还是老样子「她让我看相册…让我跟她聊聊这些」。
#
# 怀疑：daemon 那条路把系统提示写成文件再用 --append-system-prompt-file 指过去。
# 为了让缓存前缀逐字稳定，那个文件很可能是「已存在就不重写」—— 那么里面装的
# 还是旧的 THINK_PROMPT，补丁改了 server.js 也没用。
#
# 这里就看三件事：daemonSysFile 怎么写的、它写到哪、那个文件里现在是新是旧。

set -uo pipefail
API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
ok(){   printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){   printf '  \033[31m×\033[0m %s\n' "$*"; }
info(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){  printf '\n\033[1m%s\033[0m\n' "$*"; }
scrub(){ awk '{l=tolower($0); if (l ~ /token|secret|password|api_?key|vapid/) print "      [已隐去]"; else print "      " substr($0,1,180)}'; }

[ -f "$SRV" ] || { no "找不到 $SRV"; exit 1; }

say "1/4 server.js 里是新的吗"
if grep -qF 'THINK_VOICE_V2' "$SRV"; then ok "server.js 里的 THINK_PROMPT 是新版"
else no "server.js 里还是旧版 —— 补丁没打上，先跑 apply-all.sh"; fi

say "2/4 daemonSysFile 是怎么写的"
N=$(grep -n 'function daemonSysFile' "$SRV" | head -1 | cut -d: -f1)
if [ -n "${N:-}" ]; then
  sed -n "${N},$((N+22))p" "$SRV" | scrub
else
  no "找不到 daemonSysFile"
fi

say "3/4 它写到哪个文件"
# 把函数体里出现的路径揪出来
CANDS=$(sed -n "${N:-1},$((${N:-1}+22))p" "$SRV" 2>/dev/null \
  | grep -oE "'/[^']+'|\"/[^\"]+\"|[A-Za-z_]+ *\+ *'/[^']+'" | tr -d "'\"" | sort -u)
[ -n "${CANDS:-}" ] && printf '      %s\n' $CANDS || info "没从代码里直接看出路径"
info "再从磁盘上找找像的（按最近改动排）："
find "$API_DIR" /tmp -maxdepth 2 \( -name '*sys*prompt*' -o -name '*daemon*sys*' -o -name '*.sysprompt' -o -name 'sys-*.txt' \) \
  -type f -newermt '-30 days' -printf '%T@ %s %p\n' 2>/dev/null | sort -rn | head -5 |
  while read -r t sz p; do
    printf '      %s  %s 字节  %s\n' "$(date -d @"${t%.*}" '+%m-%d %H:%M')" "$sz" "$p"
  done

say "4/4 那些文件里装的是新是旧"
FOUND=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  FOUND=1
  if grep -qF 'THINK_VOICE_V2' "$f" 2>/dev/null; then
    ok "$(basename "$f") → 新版（有 THINK_VOICE_V2）"
  elif grep -qF '想怎么回' "$f" 2>/dev/null || grep -qF '她看不到' "$f" 2>/dev/null; then
    no "$(basename "$f") → 旧版！这就是原因：文件没跟着重写"
    info "   $f"
  else
    info "$(basename "$f") → 看不出新旧（没有这两边的标记）"
  fi
done < <(find "$API_DIR" /tmp -maxdepth 2 \( -name '*sys*prompt*' -o -name '*daemon*sys*' -o -name '*.sysprompt' -o -name 'sys-*.txt' \) -type f -newermt '-30 days' 2>/dev/null)
[ "$FOUND" = 1 ] || info "没找到候选文件 —— 把上面第 2 节那段代码贴给我，我照着找"

say "跑完了。整段贴给我。"
