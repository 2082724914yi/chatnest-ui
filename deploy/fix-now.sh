#!/usr/bin/env bash
# 一条命令搞定：打 cotState 热修 + 用正确身份重启 + 验证真的好了。
#   curl -fsSL .../deploy/fix-now.sh | sudo bash
#
# 为什么合成一条：分两行贴到手机终端容易黏连（sudo node - 和 pm2 restart 粘在一起
# 会变成 node: bad option: -pm2），而且 pm2 必须以 root 身份跑，
# 普通用户的 pm2 看不见 root 管的进程（No process found 就是这么来的）。
set -uo pipefail

API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
PORT=${PORT:-3000}
RAW=https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }
[ -f "$SRV" ] || { no "找不到 $SRV"; exit 1; }

say "1/4 打 cotState 热修"
TMP=$(mktemp /tmp/hotfix.XXXXXX.js)
if curl -fsSL -m 60 "$RAW/hotfix-cotstate.js" -o "$TMP" && [ -s "$TMP" ]; then
  node "$TMP" "$SRV" 2>&1 | sed 's/^/  /'
  rm -f "$TMP"
else
  no "热修脚本下载失败"; rm -f "$TMP"; exit 1
fi
grep -q '_cotSafe' "$SRV" && ok "保护已就位" || { no "热修没打上，停手"; exit 1; }
node -c "$SRV" 2>/dev/null && ok "语法通过" || { no "语法有错，停手"; exit 1; }

say "2/4 重启（root 身份的 pm2）"
RESTARTED=""
if command -v pm2 >/dev/null 2>&1; then
  # 进程名不一定叫 chatnest，从 pm2 自己的列表里找
  NAMES=$(pm2 jlist 2>/dev/null | python3 -c "
import sys,json
try:
    for a in json.load(sys.stdin):
        n=a.get('name')
        if n: print(n)
except Exception: pass
" 2>/dev/null)
  if [ -n "${NAMES:-}" ]; then
    echo "$NAMES" | while read -r n; do
      [ -z "$n" ] && continue
      pm2 restart "$n" --update-env >/dev/null 2>&1 && echo "  重启了 pm2 进程: $n"
    done
    RESTARTED="pm2"
  fi
fi
if [ -z "$RESTARTED" ]; then
  for svc in chatnest chatnest-api; do
    systemctl list-unit-files 2>/dev/null | grep -q "^$svc.service" && \
      systemctl restart "$svc" && { echo "  systemctl 重启 $svc"; RESTARTED="systemd"; break; }
  done
fi
if [ -z "$RESTARTED" ]; then
  PID=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
  [ -n "${PID:-}" ] && { kill "$PID" 2>/dev/null; sleep 2; kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null; }
  ( cd "$API_DIR" && exec 9>&- 2>/dev/null; nohup node server.js >> /var/log/chatnest-api.log 2>&1 & )
  echo "  手动重启（nohup）"
fi

say "3/4 等服务起来"
UP=0
for _ in $(seq 1 30); do sleep 1; curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { UP=1; break; }; done
[ "$UP" = 1 ] && ok "服务已就绪" || { no "起不来，看日志：pm2 logs --lines 40"; exit 1; }

say "4/4 真发一条消息，验证不再崩"
RESP=$(curl -fsS -N -m 180 -X POST "http://127.0.0.1:$PORT/api/chat" \
  -H 'Content-Type: application/json' \
  -d '{"message":"在吗"}' 2>/dev/null)
DONE=$(printf '%s' "$RESP" | grep -c 'event: done')
CID=$(printf '%s' "$RESP" | python3 -c "
import sys,json
for l in sys.stdin:
    if l.startswith('data: ') and 'conversation_id' in l:
        print(json.loads(l[6:])['conversation_id']); break
" 2>/dev/null)
if [ "$DONE" -ge 1 ]; then
  ok "收到 done 事件（之前这里是崩溃点）"
else
  no "还是没有 done，把 pm2 logs --lines 40 的输出发回来"; exit 1
fi
if [ -n "${CID:-}" ]; then
  N=$(curl -fsS -m 20 "http://127.0.0.1:$PORT/api/sessions/$CID/messages" 2>/dev/null \
      | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('messages',[])))" 2>/dev/null)
  [ "${N:-0}" -ge 2 ] && ok "会话存下来了（$N 条消息）" || no "会话还是没存上（$N 条）"
fi
curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && ok "进程活着，没崩" || no "进程又崩了"

cat <<'EOF'

  好了。去手机上打开 https://xiaoyixiaoyan.top 下拉刷新，
  新建一个对话发条消息试试 —— 这次退出去再进来，它应该还在。

  刚才那条"在吗"是脚本自己发的测试消息，看着碍眼就在列表里删掉。

EOF
