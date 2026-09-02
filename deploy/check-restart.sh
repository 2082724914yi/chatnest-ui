#!/usr/bin/env bash
# 查清楚：补丁到底写进文件没有？跑的是不是新代码？然后干净地重启一次。
#   curl -fsSL .../deploy/check-restart.sh | sudo bash
set -uo pipefail
API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
PORT=${PORT:-3000}
API_LOG=${API_LOG:-/var/log/chatnest-api.log}

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }
[ -f "$SRV" ] || { no "找不到 $SRV"; exit 1; }

say "1/4 文件里补丁在不在"
grep -q -- '--include-partial-messages' "$SRV" && ok "流式参数" || no "流式参数（patch-server.js 没打上）"
grep -q 'isFirstTurn'      "$SRV" && ok "按需回忆（fix-recall）"        || no "按需回忆（fix-recall 没打上）"
grep -q 'PROFILE_FILE'     "$SRV" && ok "记忆落盘（fix-memory-think）"  || no "记忆落盘（fix-memory-think 没打上）"
grep -q 'rememberIntoProfile' "$SRV" && ok "双向同步（fix-memory-sync）" || no "双向同步（fix-memory-sync 没打上）"
echo "  文件改动时间: $(date -r "$SRV" '+%m-%d %H:%M:%S')"

say "2/4 正在跑的是哪个进程"
find_pid(){
  local p c
  p=$(ss -lptnH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  [ -n "${p:-}" ] && { echo "$p"; return 0; }
  p=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
  [ -n "${p:-}" ] && { echo "$p"; return 0; }
  for c in $(pgrep -f 'node .*server\.js' 2>/dev/null); do
    [ "$(readlink -f "/proc/$c/cwd" 2>/dev/null)" = "$(readlink -f "$API_DIR")" ] && { echo "$c"; return 0; }
  done
  return 1
}
PID=$(find_pid || true)
if [ -n "${PID:-}" ]; then
  echo "  pid       : $PID"
  echo "  启动于    : $(ps -o lstart= -p "$PID" 2>/dev/null | sed 's/^ *//')"
  echo "  已运行    : $(ps -o etime= -p "$PID" 2>/dev/null | sed 's/^ *//')"
  # 进程启动时间早于文件修改时间 = 跑的是旧代码
  PS=$(stat -c %Y /proc/"$PID" 2>/dev/null || echo 0)
  FS=$(stat -c %Y "$SRV" 2>/dev/null || echo 0)
  if [ "$PS" -lt "$FS" ]; then
    no "进程比文件还老 —— 它跑的是改之前的代码，必须重启"
  else
    ok "进程启动于文件修改之后"
  fi
else
  no "找不到进程（可能没在跑）"
fi

say "3/4 重启"
pgrep -f 'node .*server\.js' 2>/dev/null | while read -r c; do
  [ "$(readlink -f "/proc/$c/cwd" 2>/dev/null)" = "$(readlink -f "$API_DIR")" ] || continue
  ENVF=/tmp/.chatnest-env.$$
  [ -r "/proc/$c/environ" ] && tr '\0' '\n' < "/proc/$c/environ" > "$ENVF" 2>/dev/null
  kill "$c" 2>/dev/null
  for _ in $(seq 1 12); do sleep 0.5; kill -0 "$c" 2>/dev/null || break; done
  kill -0 "$c" 2>/dev/null && { kill -9 "$c" 2>/dev/null; sleep 1; }
  echo "  已停掉旧进程 $c"
done
sleep 1
if command -v pm2 >/dev/null 2>&1 && pm2 pid chatnest >/dev/null 2>&1; then
  pm2 restart chatnest >/dev/null 2>&1 && echo "  用 pm2 重启"
elif systemctl list-unit-files 2>/dev/null | grep -q '^chatnest.service'; then
  systemctl restart chatnest && echo "  用 systemctl 重启"
else
  ENVF=$(ls -t /tmp/.chatnest-env.* 2>/dev/null | head -1)
  (
    cd "$API_DIR" || exit 1
    exec 9>&- 2>/dev/null || true
    if [ -n "${ENVF:-}" ] && [ -s "$ENVF" ]; then
      while IFS= read -r l; do case "$l" in [A-Za-z_]*=*) export "$l" 2>/dev/null || true ;; esac; done < "$ENVF"
    fi
    nohup node server.js >> "$API_LOG" 2>&1 &
  )
  echo "  用 nohup 重启"
fi
rm -f /tmp/.chatnest-env.* 2>/dev/null

UP=0
for _ in $(seq 1 25); do sleep 1; curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { UP=1; break; }; done
NEW=$(find_pid || true)
[ "$UP" = 1 ] && ok "服务已起来（pid ${PID:-?} → ${NEW:-?}）" || { no "起不来！看日志: tail -50 $API_LOG"; exit 1; }

say "4/4 验证新代码真的在跑"
R=$(curl -fsS -m 10 -X POST "http://127.0.0.1:$PORT/api/profile/memory" \
     -H 'Content-Type: application/json' \
     -d '{"content":"【自检，稍后自动删除】补丁生效验证"}' 2>/dev/null)
if echo "$R" | grep -q '"memory"'; then
  ok "新代码在跑：接口返回了 memory 字段"
  N=$(curl -fsS -m 10 "http://127.0.0.1:$PORT/api/profile" 2>/dev/null | grep -o '"content"' | wc -l)
  echo "  当前记忆条数: $N"
  echo
  echo "  自检那条记得去 Saved memories 里删掉。"
else
  no "还是旧代码：返回 $R"
  echo "  文件改了但进程没换成新的，把这段输出发回来。"
fi
echo
