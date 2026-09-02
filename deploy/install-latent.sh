#!/usr/bin/env bash
# 装 / 更新 latent-svc：Latent·显影记忆库（Python，本地 8765 端口）。
#   curl -fsSL .../deploy/install-latent.sh | sudo bash
#
# 跟 OB 并存，分工不同：
#   OB     提炼层 —— 核心准则、承诺、重要的话，每开新窗主动浮现
#   Latent 全文层 —— 完整叙述 + 未解决事项，平时不出现，问到了才查
#
# 语料只在这台机器上（/root/chatnest-api/latent-corpus），不出本机。
# 重复跑是安全的：已经装好的部分自己跳过。
set -uo pipefail

PREFIX=${PREFIX:-/opt/latent}
UPSTREAM_DIR="$PREFIX/upstream"
DATA_DIR=${LATENT_DATA_DIR:-/root/chatnest-api}
CORPUS_DIR="$DATA_DIR/latent-corpus"
THREADS_FILE="$DATA_DIR/latent-threads.jsonl"
PORT=${LATENT_PORT:-8765}
TZNAME=${LATENT_TZ:-Asia/Shanghai}
UPSTREAM_REPO=${UPSTREAM_REPO:-https://github.com/oliscatt/Latent-memory.git}
ENVFILE="$DATA_DIR/.env"
SERVICE=latent-svc

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
skip(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }

say "1/6 检查 Python"
PY=$(command -v python3 || true)
[ -n "$PY" ] || { no "没有 python3"; exit 1; }
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
  || { no "需要 Python 3.10+"; exit 1; }
ok "python3 $("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])')（默认档零第三方依赖）"

say "2/6 拉 Latent 内核"
mkdir -p "$PREFIX"
if [ -d "$UPSTREAM_DIR/.git" ]; then
  git -C "$UPSTREAM_DIR" pull --ff-only --quiet 2>/dev/null && ok "内核已更新" || skip "拉取失败，用本地版本"
else
  command -v git >/dev/null 2>&1 || { no "没有 git"; exit 1; }
  rm -rf "$UPSTREAM_DIR"
  git clone --depth 1 --quiet "$UPSTREAM_REPO" "$UPSTREAM_DIR" \
    && ok "内核已克隆到 $UPSTREAM_DIR" || { no "克隆失败"; exit 1; }
fi
[ -f "$UPSTREAM_DIR/src/mcp_server.py" ] || { no "内核目录不完整"; exit 1; }

say "3/6 自检内核零件"
FAILED=0
for m in memory_retrieval unresolved_state session_recall session_thread; do
  if (cd "$UPSTREAM_DIR/src" && timeout 120 "$PY" "$m.py" --selftest >/dev/null 2>&1); then
    ok "$m"
  else
    no "$m 自检没过"; FAILED=1
  fi
done
[ "$FAILED" = 0 ] || { no "内核自检有失败项，不往下装"; exit 1; }

say "4/6 准备语料目录和口令"
mkdir -p "$CORPUS_DIR"
chmod 700 "$CORPUS_DIR"
[ -f "$THREADS_FILE" ] || : > "$THREADS_FILE"
chmod 600 "$THREADS_FILE"
ok "语料 $CORPUS_DIR（700，只有 root 能读）"

# 口令只生成一次，之后每次复用；不打印出来，也不进 Git
if [ -f "$ENVFILE" ] && grep -q '^LATENT_TOKEN=' "$ENVFILE"; then
  skip "口令已存在，沿用"
else
  TOKEN=$("$PY" -c 'import secrets; print(secrets.token_urlsafe(32))')
  touch "$ENVFILE"; chmod 600 "$ENVFILE"
  printf '\nLATENT_TOKEN=%s\n' "$TOKEN" >> "$ENVFILE"
  unset TOKEN
  ok "已生成口令并写入 $ENVFILE（600 权限，不回显）"
fi
LATENT_TOKEN=$(grep '^LATENT_TOKEN=' "$ENVFILE" | tail -1 | cut -d= -f2-)
[ -n "$LATENT_TOKEN" ] || { no "口令读不出来"; exit 1; }

say "5/6 写 systemd unit 并启动"
UNIT=/etc/systemd/system/$SERVICE.service
NEW_UNIT=$(mktemp)
# 时区必须显式给：不给的话它按宿主探测，容器里常常是 UTC，归窗和日期标注会整体错一截
cat > "$NEW_UNIT" <<EOF
[Unit]
Description=Latent memory service for ChatNest
After=network.target

[Service]
Type=simple
WorkingDirectory=$UPSTREAM_DIR/src
Environment=PYTHONUNBUFFERED=1
EnvironmentFile=$ENVFILE
ExecStart=$PY $UPSTREAM_DIR/src/mcp_server.py \\
  --corpus $CORPUS_DIR --threads $THREADS_FILE \\
  --http 127.0.0.1:$PORT --token \${LATENT_TOKEN} --timezone $TZNAME
Restart=always
RestartSec=3
StandardOutput=append:$PREFIX/latent.log
StandardError=append:$PREFIX/latent.log

[Install]
WantedBy=multi-user.target
EOF

if [ -f "$UNIT" ] && cmp -s "$NEW_UNIT" "$UNIT"; then
  skip "unit 没变化"; rm -f "$NEW_UNIT"
else
  mv "$NEW_UNIT" "$UNIT"; ok "unit 已写入"
fi
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 3
if systemctl is-active --quiet "$SERVICE"; then
  ok "$SERVICE 正在运行"
else
  no "$SERVICE 起不来，最后 20 行："
  tail -20 "$PREFIX/latent.log" 2>/dev/null
  exit 1
fi

say "6/6 自检"
TOOLS=$(curl -s --noproxy '*' -m 15 -X POST "http://127.0.0.1:$PORT/" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $LATENT_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 2>/dev/null)
COUNT=$(printf '%s' "$TOOLS" | grep -o '"latent_[a-z_]*"' | sort -u | wc -l)
if [ "${COUNT:-0}" -ge 6 ]; then
  ok "六个工具都在（实际 $COUNT 个）："
  printf '%s' "$TOOLS" | grep -o '"latent_[a-z_]*"' | sort -u | tr -d '"' | sed 's/^/      /'
else
  no "工具没列全（拿到 ${COUNT:-0} 个），检查日志：$PREFIX/latent.log"; exit 1
fi

# 时区错了不会报错，只会让归窗和日期标注整体偏 —— 这里明着核一次
SVC_TZ=$(grep -o 'timezone[^ ]*' "$PREFIX/latent.log" 2>/dev/null | tail -1)
grep -q "没配 --timezone" "$PREFIX/latent.log" 2>/dev/null \
  && no "日志里还有未配时区的告警，检查 unit" || ok "时区已显式设为 $TZNAME"

say "装好了"
echo "  服务    : http://127.0.0.1:$PORT （只监听本地）"
echo "  内核    : $UPSTREAM_DIR"
echo "  语料    : $CORPUS_DIR （700，不出本机，不进 Git）"
echo "  线头    : $THREADS_FILE"
echo "  口令    : 存在 $ENVFILE 的 LATENT_TOKEN（600，别打印出来）"
echo "  日志    : $PREFIX/latent.log"
echo "  重启    : systemctl restart $SERVICE"
echo
echo "  下一步：打后端补丁把它接进聊天"
echo "  curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/apply-all.sh | sudo bash"
