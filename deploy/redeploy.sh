#!/usr/bin/env bash
# 前端没自动更新时用这个：先说清楚卡在哪，再强制拉一次。
#   curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/redeploy.sh | sudo bash
set -uo pipefail

DEPLOY_DIR=${DEPLOY_DIR:-/opt/chatnest-deploy}
WEB_ROOT=${WEB_ROOT:-/var/www/chatnest}
LOCKFILE=${LOCKFILE:-/var/lock/chatnest-deploy.lock}
LOG=${LOG:-/var/log/chatnest-deploy.log}
UI_REPO=https://github.com/2082724914yi/chatnest-ui.git

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }

say "1/5 定时器还在吗"
if systemctl list-timers 2>/dev/null | grep -q chatnest; then
  systemctl list-timers 2>/dev/null | grep chatnest | sed 's/^/  /'
else
  no "没看到 chatnest 的 timer"
  systemctl status chatnest-deploy.timer --no-pager 2>&1 | head -5 | sed 's/^/  /'
fi

say "2/5 部署日志最后几行"
[ -f "$LOG" ] && tail -12 "$LOG" | sed 's/^/  /' || no "没有 $LOG（说明部署脚本一次都没跑成过）"

say "3/5 部署锁被谁攥着"
if command -v fuser >/dev/null 2>&1 && [ -f "$LOCKFILE" ]; then
  HOLDER=$(fuser "$LOCKFILE" 2>/dev/null | tr -d ' ')
  if [ -n "${HOLDER:-}" ]; then
    no "锁被这些进程占着：$HOLDER"
    for p in $HOLDER; do
      echo "     pid $p → $(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | cut -c1-80)"
    done
    echo "     （后端继承了锁的文件描述符时会这样，自动部署就永远拿不到锁了）"
  else
    ok "锁没被占"
  fi
else
  ok "锁文件干净或查不到占用"
fi

say "4/5 强制拉一次前端"
DIR="$DEPLOY_DIR/chatnest-ui"
if [ ! -d "$DIR/.git" ]; then
  echo "  仓库不在，重新 clone…"
  mkdir -p "$DEPLOY_DIR"
  git clone --depth 20 "$UI_REPO" "$DIR" 2>&1 | sed 's/^/    /' || { no "clone 失败"; exit 1; }
fi
git -C "$DIR" fetch -q origin 2>&1 | sed 's/^/    /'
REMOTE=$(git -C "$DIR" rev-parse origin/main 2>/dev/null)
[ -n "${REMOTE:-}" ] || { no "拿不到 origin/main"; exit 1; }
git -C "$DIR" reset -q --hard "$REMOTE" || { no "reset 失败"; exit 1; }
ok "仓库已到 ${REMOTE:0:8}"

NEW="$DIR/index.html"
CUR="$WEB_ROOT/index.html"
[ -s "$NEW" ] || { no "拉下来的 index.html 是空的，不敢覆盖"; exit 1; }
grep -qi '</html>' "$NEW" || { no "index.html 不完整（没有闭合标签），不敢覆盖"; exit 1; }
if cmp -s "$NEW" "$CUR" 2>/dev/null; then
  ok "线上已经是最新（$(wc -c < "$CUR") 字节），不用动"
else
  mkdir -p "$WEB_ROOT"
  [ -f "$CUR" ] && cp "$CUR" "$CUR.bak"
  cp "$NEW" "$CUR"
  ok "已部署：$(wc -c < "$CUR") 字节（旧的备份在 $CUR.bak）"
fi

say "5/5 从外面验一下"
LIVE=$(curl -fsS -m 20 https://xiaoyixiaoyan.top/index.html 2>/dev/null | wc -c)
WANT=$(wc -c < "$CUR")
[ "$LIVE" = "$WANT" ] && ok "外网拿到的就是这一版（$LIVE 字节）" || no "外网拿到 $LIVE，本地是 $WANT —— 可能是 nginx 缓存，手机上强刷一次"

cat <<'EOF'

  手机上下拉刷新（或者把页面关掉重开）就能看到新版了。

  如果第 3 步显示锁被后端攥着，说明自动部署已经卡死很久了，
  重启一次后端就会放开：pm2 restart all

EOF
