#!/usr/bin/env bash
# 朋友圈补丁打上之后服务起不来 —— 先诊断，再就地修，最后重启。
#   curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/rescue-moments.sh | sudo bash
#
# 病因：早期那版补丁给六个路由挂了 requireAuth，但 server.js 里从来没有
# 这个中间件。Express 注册路由时拿到 undefined 就抛错，服务直接起不来。
# 而 MOMENTS_FILE 这个标记已经写进去了，apply-all.sh 之后只会说"已打过"
# 跳过，好版本永远盖不上来。这里把 requireAuth 摘掉即可，其它补丁不动。
set -uo pipefail

API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
PORT=${PORT:-3000}

ok(){   printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){   printf '  \033[31m×\033[0m %s\n' "$*"; }
skip(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){  printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }
[ -f "$SRV" ] || { no "找不到 $SRV"; exit 1; }

say "1/5 现在什么情况"
if curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  ok "服务在跑 —— 那问题不在这儿，下面照样体检一遍"
  WAS_UP=1
else
  no "服务没在跑"
  WAS_UP=0
fi

grep -qF 'MOMENTS_FILE' "$SRV" && ok "朋友圈补丁在 server.js 里" || skip "还没打朋友圈补丁"

# 病灶：引用了 requireAuth，但全文没有它的定义
USES=$(grep -c 'requireAuth' "$SRV" 2>/dev/null || true)
DEFINED=$(grep -cE 'function requireAuth|const requireAuth|let requireAuth|var requireAuth' "$SRV" 2>/dev/null || true)
if [ "$USES" -gt 0 ] && [ "$DEFINED" = 0 ]; then
  no "找到病灶：$USES 处用了 requireAuth，但它从来没被定义过"
  SICK=1
else
  [ "$USES" = 0 ] && ok "没有 requireAuth 残留" || ok "requireAuth 有定义，不是这个问题"
  SICK=0
fi

say "2/5 让它自己说哪儿错了"
BOOT=$(cd "$API_DIR" && PORT=59999 timeout 8 node server.js 2>&1 | head -25)
if printf '%s' "$BOOT" | grep -qiE 'running on|listening'; then
  ok "单独跑能起来"
  BOOT_OK=1
else
  BOOT_OK=0
  no "单独跑起不来，它说："
  printf '%s\n' "$BOOT" | grep -viE '^\s*at |^\s*$' | head -8 | sed 's/^/      /'
fi

say "3/5 修"
if [ "$SICK" = 1 ]; then
  BK="$SRV.bak.$(date +%Y%m%d%H%M%S)"
  cp "$SRV" "$BK"
  # 只摘中间件位置上的 requireAuth，别的一个字不碰
  sed -i "s/, requireAuth,/,/g; s/(requireAuth, /(/g" "$SRV"
  LEFT=$(grep -c 'requireAuth' "$SRV" 2>/dev/null || true)
  if [ "$LEFT" -gt 0 ]; then
    no "还剩 $LEFT 处没摘干净，回退，把这段发回来："
    grep -n 'requireAuth' "$SRV" | head -5 | sed 's/^/      /'
    cp "$BK" "$SRV"; exit 1
  fi
  if node -c "$SRV" 2>/dev/null; then
    ok "requireAuth 已摘干净，语法通过（备份：$BK）"
  else
    no "改完语法反而不对，已回退"
    cp "$BK" "$SRV"; exit 1
  fi
elif [ "$BOOT_OK" = 0 ]; then
  no "不是 requireAuth 的问题，上面第 2 步那几行就是真正的原因"
  echo "      最近的备份（要回退就 cp 回去）："
  ls -t "$API_DIR"/server.js.bak* 2>/dev/null | head -3 | sed 's/^/        /'
  exit 1
else
  skip "没什么要修的"
fi

say "4/5 重启"
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

say "5/5 验"
UP=0
for _ in $(seq 1 30); do
  sleep 1
  curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { UP=1; break; }
done
if [ "$UP" != 1 ]; then
  no "还是起不来，日志最后 20 行："
  (pm2 logs --lines 20 --nostream 2>/dev/null || tail -20 /var/log/chatnest-api.log) | sed 's/^/      /'
  exit 1
fi
ok "服务起来了"

M=$(curl -fsS -m 8 "http://127.0.0.1:$PORT/api/moments" 2>/dev/null)
if printf '%s' "$M" | grep -q '"moments"'; then
  N=$(printf '%s' "$M" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('moments',[])))" 2>/dev/null || echo '?')
  ok "朋友圈接口通了（现在 $N 条）"
else
  no "朋友圈接口还不对：$(printf '%s' "$M" | head -c 120)"
fi

cat <<'EOF'

  好了。手机上把页面彻底关掉再开。

EOF
