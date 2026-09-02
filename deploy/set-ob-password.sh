#!/usr/bin/env bash
# 设置 OB Dashboard 密码 —— 前端 Memory 页空白就是卡在这一步。
#
# 先下载再跑（不能用管道，管道会占掉 stdin，就没法让你输密码了）：
#   curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/set-ob-password.sh -o /tmp/set-ob.sh
#   sudo bash /tmp/set-ob.sh
#
# 密码只会：① 拿去 OB 试登录 ② 写进 /root/chatnest-api/.env（权限 600）
# 不回显、不进命令历史、不打日志、不进 git。
set -uo pipefail

API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
ENV_FILE="$API_DIR/.env"
PORT=${PORT:-3000}

ok(){   printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){   printf '  \033[31m×\033[0m %s\n' "$*"; }
say(){  printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑：sudo bash /tmp/set-ob.sh"; exit 1; }
[ -f "$SRV" ] || { no "找不到 $SRV"; exit 1; }

if ! grep -q "loadEnvFile" "$SRV"; then
  no "server.js 还没打 fix-ob-dashboard.js 这个补丁，先跑："
  echo "     curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/apply-all.sh | sudo bash"
  exit 1
fi

# OB 地址：优先用已配的环境变量 / .env，否则从 server.js 里读
OB_URL="${OMBRE_DASHBOARD_URL:-}"
[ -z "$OB_URL" ] && [ -f "$ENV_FILE" ] && OB_URL=$(grep -m1 '^OMBRE_DASHBOARD_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
[ -z "$OB_URL" ] && OB_URL=$(grep -m1 "^const OMBRE_URL = '" "$SRV" | sed "s/.*'\(.*\)'.*/\1/")
OB_URL=${OB_URL%/}
[ -n "$OB_URL" ] || { no "读不出 Ombre Brain 的地址"; exit 1; }

say "要设置的是 OB Dashboard 的登录密码"
echo "  就是你在浏览器里打开 $OB_URL 时输的那个密码。"
echo "  （不是 MCP 的 token —— 那个是另一套，现在后端就是拿它去登录才一直失败的。）"
echo

# 最多试三次，试通了才写文件
ATTEMPT=0
while :; do
  ATTEMPT=$((ATTEMPT+1))
  printf '  密码（输入时不显示）: '
  # 优先读终端，这样即使脚本是被管道喂进来的也还能输入
  if [ -r /dev/tty ]; then IFS= read -rs OBPW < /dev/tty; else IFS= read -rs OBPW; fi
  echo
  if [ -z "${OBPW:-}" ]; then no "没输入"; [ "$ATTEMPT" -ge 3 ] && exit 1 || continue; fi

  # 用文件传密码，不放进命令行（命令行 ps 能看见）
  BODY=$(mktemp); chmod 600 "$BODY"
  OBPW="$OBPW" python3 -c "
import json,os,sys
sys.stdout.write(json.dumps({'password': os.environ['OBPW']}))
" > "$BODY" 2>/dev/null || { printf '{"password":"%s"}' "$OBPW" > "$BODY"; }

  CODE=$(curl -s -m 20 -o /tmp/.oblogin.out -w '%{http_code}' \
         -X POST "$OB_URL/auth/login" -H 'Content-Type: application/json' \
         --data-binary @"$BODY" 2>/dev/null)
  rm -f "$BODY"

  if [ "${CODE:-000}" = 200 ]; then
    ok "密码对，OB 认了"
    rm -f /tmp/.oblogin.out
    break
  fi
  no "OB 不认这个密码（HTTP ${CODE:-连不上}）"
  [ -s /tmp/.oblogin.out ] && sed 's/^/      /' /tmp/.oblogin.out && echo
  rm -f /tmp/.oblogin.out
  if [ "$ATTEMPT" -ge 3 ]; then
    echo
    echo "  试了三次都不对。去 $OB_URL 用浏览器登一次确认密码，再回来跑这个脚本。"
    exit 1
  fi
  echo "  再试一次。"
done

say "写进 $ENV_FILE"
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
TMP=$(mktemp); chmod 600 "$TMP"
grep -v '^OMBRE_DASHBOARD_PASSWORD=' "$ENV_FILE" 2>/dev/null | grep -v '^OMBRE_DASHBOARD_URL=' > "$TMP" || true
{
  echo "OMBRE_DASHBOARD_URL=$OB_URL"
  printf 'OMBRE_DASHBOARD_PASSWORD='; printf '%s\n' "$OBPW"
} >> "$TMP"
mv "$TMP" "$ENV_FILE"; chmod 600 "$ENV_FILE"
unset OBPW
ok "已写入（权限 600，只有 root 读得到）"

say "重启后端"
RESTARTED=""
if command -v pm2 >/dev/null 2>&1; then
  NAMES=$(pm2 jlist 2>/dev/null | python3 -c "
import sys,json
try:
    for a in json.load(sys.stdin):
        if a.get('name'): print(a['name'])
except Exception: pass
" 2>/dev/null)
  if [ -n "${NAMES:-}" ]; then
    echo "$NAMES" | while read -r n; do
      [ -z "$n" ] && continue
      pm2 restart "$n" --update-env >/dev/null 2>&1 && echo "  重启 pm2 进程: $n"
    done
    RESTARTED="pm2"
  fi
fi
if [ -z "$RESTARTED" ]; then
  PID=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
  [ -n "${PID:-}" ] && { kill "$PID" 2>/dev/null; sleep 2; kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null; }
  ( cd "$API_DIR" && exec 9>&- 2>/dev/null; nohup node server.js >> /var/log/chatnest-api.log 2>&1 & )
  echo "  手动重启"
fi

UP=0
for _ in $(seq 1 30); do sleep 1; curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { UP=1; break; }; done
[ "$UP" = 1 ] && ok "服务已就绪" || { no "起不来，看 pm2 logs --lines 40"; exit 1; }

say "验证记忆页能不能读到东西"
OUT=$(curl -fsS -m 30 "http://127.0.0.1:$PORT/api/ombre-dashboard/status" 2>/dev/null)
echo "$OUT" | grep -q '"available":true' && ok "Dashboard 通了：$OUT" || { no "还是不通：$OUT"; exit 1; }

N=$(curl -fsS -m 30 "http://127.0.0.1:$PORT/api/ombre-dashboard/buckets" 2>/dev/null \
    | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('items',[])))" 2>/dev/null)
[ "${N:-0}" -gt 0 ] && ok "读到 $N 条记忆" || no "接口通了但一条都没读到，把上面输出发回来"

cat <<'EOF'

  好了。手机上把页面下拉刷新，再点首页那张 Memory 卡片。
  记忆列表、搜索、筛选、点开看详情，应该都有了。

EOF
