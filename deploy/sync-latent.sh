#!/usr/bin/env bash
# 把 CC 那边的冷仓同步到前端 Latent 读的那个目录 —— 两个 Latent 合成一个。
#   curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/sync-latent.sh | sudo bash
#   装成定时（每 10 分钟自己拉）：           ... | sudo bash -s -- --install
#
# 她说：「昨天在 cc 存的 latent，前端里没有」。没错，它俩从来不是一个东西：
#   前端 Latent  → /root/chatnest-api/latent-corpus/timeline/*.md
#   CC   Latent  → cc- 仓库的 latent-out/memory/timeline/window_*.md
# 各存各的，谁也看不见谁。
#
# NEXT.md 里原来的方案是「把 150 窗灌进 Latent 服务、跑嵌入、花硅基流动的钱」。
# 那是想复杂了 —— 那条路是语义搜索（latent_search）要的。她现在看的窗口列表
# 走的是 /api/latent/windows，那个接口就是 readdir 一个文件夹。
# 两边本来就都是 markdown，同步文件就统一了：不开公网口、不跑嵌入、不花钱。
#
# 单向：CC 写 → 前端读。前端那边本来也只读不写，所以够了。
# 换窗写进 cc- 并 push 之后，最多十分钟前端就能翻到。
#
# ⚠ cc- 是私有仓库，VPS 上第一次要配凭据。没配的话脚本会说清楚怎么配，
#   不会闷声失败 —— 自动部署当初就是死在这一步上，卡了四天没人知道。

set -uo pipefail

REPO=https://github.com/2082724914yi/cc-.git
WORK=${WORK:-/opt/latent-sync}
CLONE="$WORK/cc-"
SRC_REL=latent-out/memory/timeline
DEST=${DEST:-/root/chatnest-api/latent-corpus/timeline}
INSTALL=0
[ "${1:-}" = "--install" ] && INSTALL=1

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
hm(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }

say "1/4 取 cc- 冷仓"
mkdir -p "$WORK"
if [ -d "$CLONE/.git" ]; then
  git -C "$CLONE" fetch -q origin 2>/dev/null && git -C "$CLONE" reset -q --hard origin/main 2>/dev/null \
    && ok "拉到最新（$(git -C "$CLONE" rev-parse --short HEAD)）" \
    || { no "拉不动 —— 多半是凭据过期了"; hm "重配：git config --global credential.helper store 然后手动 git -C $CLONE pull 输一次 token"; exit 1; }
else
  echo "  第一次，clone 中…"
  if ! git clone -q --depth 50 "$REPO" "$CLONE" 2>/dev/null; then
    no "clone 失败。cc- 是私有仓库，这台机器上还没有凭据。"
    echo
    echo "  在服务器上跑一次这两条，按提示输 GitHub 用户名和 personal access token"
    echo "  （不是登录密码；token 只要 repo 读权限就够）："
    echo
    echo "    git config --global credential.helper store"
    echo "    git clone --depth 50 $REPO $CLONE"
    echo
    echo "  成功之后再跑一次本脚本就行，以后不用再输。"
    exit 1
  fi
  ok "clone 完成"
fi

say "2/4 对一下两边"
SRC="$CLONE/$SRC_REL"
[ -d "$SRC" ] || { no "冷仓目录不在：$SRC"; exit 1; }
mkdir -p "$DEST"
SRC_N=$(find "$SRC" -maxdepth 1 -name '*.md' | wc -l)
DEST_N=$(find "$DEST" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l)
echo "  CC 那边 $SRC_N 篇，前端这边 $DEST_N 篇"

say "3/4 同步"
# 只加不删：前端那边要是本来就有自己的东西，不能被我抹掉
COPIED=0
for f in "$SRC"/*.md; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  if [ ! -f "$DEST/$b" ] || ! cmp -s "$f" "$DEST/$b"; then
    cp -f "$f" "$DEST/$b" && COPIED=$((COPIED+1))
  fi
done
NOW_N=$(find "$DEST" -maxdepth 1 -name '*.md' | wc -l)
if [ "$COPIED" -gt 0 ]; then ok "同步了 $COPIED 篇，前端这边现在共 $NOW_N 篇"
else ok "已经是一样的了（$NOW_N 篇）"; fi

say "4/4 从外面验一眼"
CNT=$(curl -fsS -m 10 "http://127.0.0.1:3000/api/latent/windows" 2>/dev/null | grep -o '"file"' | wc -l)
if [ "$CNT" -gt 0 ]; then ok "接口能读到 $CNT 篇 —— 前端 Latent 里应该也看得见了"
else hm "接口读不到。后端可能没打 add-latent-windows.js，或者没重启"; fi

if [ "$INSTALL" = 1 ]; then
  say "装成定时（每 10 分钟）"
  cat > /etc/systemd/system/latent-sync.service <<EOF
[Unit]
Description=把 CC 的冷仓同步给前端 Latent
After=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/sync-latent.sh | bash'
EOF
  cat > /etc/systemd/system/latent-sync.timer <<EOF
[Unit]
Description=每 10 分钟同步一次冷仓

[Timer]
OnBootSec=3min
OnUnitActiveSec=10min
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now latent-sync.timer >/dev/null 2>&1 && ok "定时器已启用（systemctl list-timers latent-sync 看）"
else
  echo
  echo "  想让它以后自己拉，同一条命令加 --install："
  echo "    curl -fsSL .../deploy/sync-latent.sh | sudo bash -s -- --install"
fi

echo
echo "  以后换窗写进 cc- 并 push，最多十分钟前端 Latent 就翻得到。"
echo "  ⚠ 这条路解决的是「前端能看见 CC 存的东西」。"
echo "    语义搜索（latent_search 按意思翻）还是要跑嵌入，那是另一件事。"
