#!/usr/bin/env bash
# 打完补丁之后的收尾：换前端 + 重启后端 + 验证补丁真的生效了。
#   curl -fsSL .../deploy/finish-setup.sh | sudo bash
set -uo pipefail

WEB_ROOT=${WEB_ROOT:-/var/www/chatnest}
API_DIR=${API_DIR:-/root/chatnest-api}
PORT=${PORT:-3000}
API_LOG=${API_LOG:-/var/log/chatnest-api.log}
RAW=https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main

say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
bad(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }

[ "$(id -u)" = 0 ] || { bad "要用 sudo 跑"; exit 1; }

health(){ curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }
find_pid(){
  local p cand
  p=$(ss -lptnH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  [ -n "${p:-}" ] && { echo "$p"; return 0; }
  p=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
  [ -n "${p:-}" ] && { echo "$p"; return 0; }
  for cand in $(pgrep -f 'node .*server\.js' 2>/dev/null); do
    [ "$(readlink -f "/proc/$cand/cwd" 2>/dev/null)" = "$(readlink -f "$API_DIR")" ] && { echo "$cand"; return 0; }
  done
  return 1
}

# ---------- 1. 确认补丁在 ----------
say "1/4 检查后端补丁"
if grep -q -- '--include-partial-messages' "$API_DIR/server.js" 2>/dev/null; then
  ok "补丁已打上"
else
  bad "$API_DIR/server.js 里没有补丁，先跑 patch-server.js"
  exit 1
fi

# ---------- 2. 换前端 ----------
say "2/4 更新前端"
mkdir -p "$WEB_ROOT"
TMP=$(mktemp)
if curl -fsSL -m 120 -o "$TMP" "$RAW/index.html" && [ -s "$TMP" ] && grep -qi '</html>' "$TMP"; then
  [ -f "$WEB_ROOT/index.html" ] && cp "$WEB_ROOT/index.html" "$WEB_ROOT/index.html.bak"
  cp "$TMP" "$WEB_ROOT/index.html"
  ok "前端已更新（$(wc -c < "$WEB_ROOT/index.html") 字节）"
  grep -q 'createTimeline' "$WEB_ROOT/index.html" && ok "时间轴组件在里面" || warn "没找到时间轴组件，版本可能不对"
else
  bad "前端下载失败或文件不完整，保持原样没动"
fi
rm -f "$TMP"

# ---------- 3. 重启后端 ----------
say "3/4 重启后端"
OLD=$(find_pid || true)
RESTARTED=""
if command -v pm2 >/dev/null 2>&1 && pm2 pid chatnest >/dev/null 2>&1; then
  pm2 restart chatnest >/dev/null 2>&1 && RESTARTED="pm2"
fi
if [ -z "$RESTARTED" ]; then
  for svc in chatnest chatnest-api; do
    if systemctl list-unit-files 2>/dev/null | grep -q "^$svc.service"; then
      systemctl restart "$svc" && RESTARTED="systemd($svc)" && break
    fi
  done
fi
if [ -z "$RESTARTED" ]; then
  ENVF=$(mktemp)
  if [ -n "$OLD" ]; then
    [ -r "/proc/$OLD/environ" ] && tr '\0' '\n' < "/proc/$OLD/environ" > "$ENVF" 2>/dev/null
    kill "$OLD" 2>/dev/null
    for _ in $(seq 1 10); do sleep 0.5; kill -0 "$OLD" 2>/dev/null || break; done
    kill -0 "$OLD" 2>/dev/null && { kill -9 "$OLD" 2>/dev/null; sleep 1; }
  fi
  (
    cd "$API_DIR" || exit 1
    if [ -s "$ENVF" ]; then
      while IFS= read -r l; do case "$l" in [A-Za-z_]*=*) export "$l" 2>/dev/null || true ;; esac; done < "$ENVF"
    fi
    nohup node server.js >> "$API_LOG" 2>&1 &
  )
  rm -f "$ENVF"
  RESTARTED="手动(nohup)"
fi
ok "重启方式：$RESTARTED（旧进程 ${OLD:-未知}）"

UP=0
for _ in $(seq 1 20); do sleep 1; health && { UP=1; break; }; done
NEW=$(find_pid || true)
if [ "$UP" = 1 ]; then
  ok "服务已就绪（进程 ${OLD:-?} → ${NEW:-?}）"
  [ -n "$OLD" ] && [ "$OLD" = "${NEW:-}" ] && warn "进程号没变，可能没真正重启"
else
  bad "服务起不来！看日志：tail -50 $API_LOG"
  bad "要回退就把 $API_DIR/server.js.bak-* 里最新的那个复制回 server.js"
  exit 1
fi

# ---------- 4. 验证补丁真的在跑 ----------
say "4/4 验证补丁生效"
CID=$(curl -fsS -m 10 "http://127.0.0.1:$PORT/api/sessions" 2>/dev/null \
      | grep -o '"conv_id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "${CID:-}" ]; then
  BODY=$(curl -fsS -m 15 "http://127.0.0.1:$PORT/api/sessions/$CID/messages" 2>/dev/null)
  echo "$BODY" | grep -q '"traces"'   && ok "messages 接口返回 traces 字段" || bad "没有 traces 字段"
  echo "$BODY" | grep -q '"thinking"' && ok "messages 接口返回 thinking 字段" || bad "没有 thinking 字段"
else
  warn "还没有历史会话，跳过这项（发条消息后就能验证）"
fi

cat <<EOF

$(printf '\033[1m弄完了。\033[0m')

  手机上打开 https://xiaoyixiaoyan.top 强制刷新一下（下拉刷新，
  或者关掉标签页重开），然后发条消息试试。

  该看到的：字是一个一个蹦出来的，不是等半天整段出现；
  正文上方有「思考过程」和工具调用的时间轴，点开能看内容。

EOF
