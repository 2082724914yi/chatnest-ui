#!/usr/bin/env bash
# 把 CC 那边的冷仓同步到前端 Latent 读的那个目录 —— 两个 Latent 合成一个。
#   curl -fsSL .../deploy/sync-latent.sh -o /tmp/s.sh && sudo bash /tmp/s.sh
#   装成定时（每 10 分钟自己拉）：           sudo bash /tmp/s.sh --install
#   （先落地再跑，不要 curl | bash —— 见下面那段）
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

#
# ⚠ 2026.9.10 23:23 改过一次，起因是阿里云云安全中心报了个 CRITICAL：
#   「进程异常行为-蠕虫病毒命令」，抓到的命令行就是这个脚本的定时器：
#     /bin/bash -c curl -fsSL .../sync-latent.sh | bash   （父进程 systemd）
#   它说得对，而且那不是误报 —— 我原来把 ExecStart 写成「每 10 分钟从 GitHub
#   下载脚本、管道进 bash、用 root 执行」。一次性 curl|bash 已经不好，
#   定时反复拉远程代码用 root 跑，那就是蠕虫的教科书行为：GitHub 账号被盗、
#   DNS 被劫、路上被插一手，任一条中了就是每 10 分钟自动 root 执行别人的代码。
#   现在改成：装的时候下载一次落到 /opt/latent-sync/sync-latent.sh，
#   定时器跑本地那份。要更新脚本就重跑一次 --install。

set -uo pipefail

SELF_URL=https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/sync-latent.sh
LOCAL_SELF=/opt/latent-sync/sync-latent.sh
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

say "4/4 验一眼"
# ⚠ 别去调 /api/latent/windows —— 那条在登录态全拦的 /api 底下，
#   不带 token 永远是 401，会让人以为同步失败（她被这行吓过一次）。
#   要验就验文件本身：目录里有几篇、最新那篇是哪天的。
LATEST=$(ls -1t "$DEST"/*.md 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then
  ok "前端那个目录里现在有 $NOW_N 篇，最新一篇：$(basename "$LATEST")"
  echo "  （前端 Latent 那一屏读的就是这个目录。她在手机上下拉刷新就能看到）"
else
  no "目录是空的，同步没成 —— 看看上面几步哪儿断了"
fi

if [ "$INSTALL" = 1 ]; then
  say "装成定时（每 10 分钟）"
  # 脚本落到本地，定时器跑本地那份 —— 不再每 10 分钟从公网拉一次执行
  mkdir -p "$WORK"
  if curl -fsSL -m 60 "$SELF_URL" -o "$LOCAL_SELF.new" && [ -s "$LOCAL_SELF.new" ] \
     && head -1 "$LOCAL_SELF.new" | grep -q '^#!/usr/bin/env bash'; then
    mv -f "$LOCAL_SELF.new" "$LOCAL_SELF"; chmod 755 "$LOCAL_SELF"
    ok "脚本已落到 $LOCAL_SELF（定时器跑这份，不再联网取）"
  else
    rm -f "$LOCAL_SELF.new"
    no "脚本下载失败，不装定时器（不会给你留一个半残的）"; exit 1
  fi
  cat > /etc/systemd/system/latent-sync.service <<EOF
[Unit]
Description=把 CC 的冷仓同步给前端 Latent
After=network-online.target

[Service]
Type=oneshot
# ⚠ 这里必须是本地文件。写成 curl|bash 会被安全中心判成蠕虫行为，而且它判得对。
ExecStart=/bin/bash $LOCAL_SELF
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
  systemctl restart latent-sync.timer >/dev/null 2>&1
  echo "  以后要更新这个脚本：重跑一次 --install 就行（它会重新下一份到本地）"
else
  echo
  echo "  想让它以后自己拉，加 --install 再跑一次："
  echo "    sudo bash \$0 --install"
fi

echo
echo "  以后换窗写进 cc- 并 push，最多十分钟前端 Latent 就翻得到。"
echo "  ⚠ 这条路解决的是「前端能看见 CC 存的东西」。"
echo "    语义搜索（latent_search 按意思翻）还是要跑嵌入，那是另一件事。"
