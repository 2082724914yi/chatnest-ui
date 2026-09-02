#!/usr/bin/env bash
# 装 / 更新 eventide-svc：小衍的身体状态内核（Python，本地 3100 端口）。
#   curl -fsSL .../deploy/install-eventide.sh | sudo bash
#
# 这个服务是无状态的：BodyState 由 chatnest-api 保存在 /root/chatnest-api/data/，
# 服务本身只做计算。所以随便重启、升级、重装，状态都不会丢。
# 重复跑是安全的：已经装好的部分自己跳过。
set -uo pipefail

PREFIX=${PREFIX:-/opt/eventide}
UPSTREAM_DIR="$PREFIX/upstream"
PORT=${EVENTIDE_PORT:-3100}
BRANCH=${BRANCH:-main}
UPSTREAM_REPO=${UPSTREAM_REPO:-https://github.com/chuli1122/Eventide.git}
# cc- 是私有仓库，raw 匿名拉一律 404 —— 服务代码必须放在公开的 chatnest-ui 里，
# 跟其它部署脚本同源。
RAW="https://raw.githubusercontent.com/2082724914yi/chatnest-ui/$BRANCH/deploy/eventide"
SERVICE=eventide-svc

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
skip(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }

say "1/6 检查 Python"
PY=$(command -v python3 || true)
[ -n "$PY" ] || { no "没有 python3"; exit 1; }
PYVER=$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || {
  no "需要 Python 3.9+（zoneinfo），当前 $PYVER"; exit 1; }
ok "python3 $PYVER"

# zoneinfo 在部分精简镜像上缺 tzdata，缺了时间窗口会算错，必须补上
if ! "$PY" -c 'from zoneinfo import ZoneInfo; ZoneInfo("Asia/Shanghai")' 2>/dev/null; then
  skip "缺时区库，装 tzdata"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y tzdata >/dev/null 2>&1 || true
  fi
  "$PY" -c 'from zoneinfo import ZoneInfo; ZoneInfo("Asia/Shanghai")' 2>/dev/null \
    || "$PY" -m pip install --quiet tzdata 2>/dev/null || true
fi
"$PY" -c 'from zoneinfo import ZoneInfo; ZoneInfo("Asia/Shanghai")' 2>/dev/null \
  && ok "Asia/Shanghai 时区可用" || { no "时区库装不上，事件窗口会算错"; exit 1; }

say "2/6 拉 Eventide 内核"
mkdir -p "$PREFIX"
if [ -d "$UPSTREAM_DIR/.git" ]; then
  if git -C "$UPSTREAM_DIR" pull --ff-only --quiet 2>/dev/null; then
    ok "内核已更新到最新"
  else
    skip "内核拉取失败，用本地已有版本"
  fi
else
  command -v git >/dev/null 2>&1 || { no "没有 git"; exit 1; }
  rm -rf "$UPSTREAM_DIR"
  git clone --depth 1 --quiet "$UPSTREAM_REPO" "$UPSTREAM_DIR" \
    && ok "内核已克隆到 $UPSTREAM_DIR" || { no "克隆 Eventide 失败"; exit 1; }
fi
[ -f "$UPSTREAM_DIR/src/eventide/__init__.py" ] || { no "内核目录不完整"; exit 1; }

say "3/6 拉服务代码"
FAILED=0
for f in app.py scheduler.py smoke_test.py; do
  TMP=$(mktemp "/tmp/eventide.XXXXXX.py")
  if curl -fsSL -m 60 "$RAW/$f" -o "$TMP" && [ -s "$TMP" ] && "$PY" -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$TMP"; then
    # 只在内容真的变了时才覆盖，省掉无谓的重启
    if [ -f "$PREFIX/$f" ] && cmp -s "$TMP" "$PREFIX/$f"; then
      skip "$f（没变化）"
    else
      [ -f "$PREFIX/$f" ] && cp "$PREFIX/$f" "$PREFIX/$f.bak.$(date +%Y%m%d%H%M%S)"
      mv "$TMP" "$PREFIX/$f"; ok "$f"
    fi
  else
    no "$f — 下载或语法校验失败"; FAILED=1
  fi
  rm -f "$TMP"
done
[ "$FAILED" = 0 ] || { no "服务代码没拿全，不动现有服务"; exit 1; }

say "4/6 写 systemd unit"
UNIT=/etc/systemd/system/$SERVICE.service
NEW_UNIT=$(mktemp)
cat > "$NEW_UNIT" <<EOF
[Unit]
Description=Eventide body-state service for ChatNest
After=network.target

[Service]
Type=simple
WorkingDirectory=$PREFIX
Environment=PYTHONPATH=$UPSTREAM_DIR/src
Environment=PYTHONUNBUFFERED=1
Environment=EVENTIDE_HOST=127.0.0.1
Environment=EVENTIDE_PORT=$PORT
EnvironmentFile=-$PREFIX/eventide.env
ExecStart=$PY $PREFIX/app.py
Restart=always
RestartSec=3
StandardOutput=append:$PREFIX/eventide.log
StandardError=append:$PREFIX/eventide.log

[Install]
WantedBy=multi-user.target
EOF

if [ -f "$UNIT" ] && cmp -s "$NEW_UNIT" "$UNIT"; then
  skip "unit 没变化"
  rm -f "$NEW_UNIT"
else
  mv "$NEW_UNIT" "$UNIT"; ok "unit 已写入"
fi
systemctl daemon-reload

say "5/6 启动服务"
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  ok "$SERVICE 正在运行"
else
  no "$SERVICE 起不来，最后 20 行日志："
  journalctl -u "$SERVICE" -n 20 --no-pager 2>/dev/null || tail -20 "$PREFIX/eventide.log" 2>/dev/null
  exit 1
fi

say "6/6 自检"
HEALTH=$(curl -fsS -m 10 --noproxy '*' "http://127.0.0.1:$PORT/health" 2>/dev/null || true)
if echo "$HEALTH" | grep -q '"ok": *true'; then
  ok "健康检查通过：$HEALTH"
else
  no "健康检查没过：${HEALTH:-（无响应）}"; exit 1
fi

if EVENTIDE_PORT="$PORT" "$PY" "$PREFIX/smoke_test.py" >/tmp/eventide-smoke.log 2>&1; then
  ok "冒烟测试全部通过"
else
  no "冒烟测试有失败项，详见 /tmp/eventide-smoke.log"
  tail -15 /tmp/eventide-smoke.log
fi

say "装好了"
echo "  服务      : http://127.0.0.1:$PORT （只监听本地）"
echo "  内核      : $UPSTREAM_DIR"
echo "  日志      : $PREFIX/eventide.log"
echo "  重启      : systemctl restart $SERVICE"
echo "  状态存在  : /root/chatnest-api/eventide-state.json （由 chatnest-api 管）"
echo
echo "  下一步：打后端补丁把它接进聊天"
echo "  curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/$BRANCH/deploy/apply-all.sh | sudo bash"
