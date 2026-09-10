#!/usr/bin/env bash
# 自动部署为什么不动了 —— 一条命令问全。
#   curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/diag-autodeploy.sh | sudo bash
# 确认是锁卡住之后，带 FIX=1 再跑一次就顺手修掉：
#   curl -fsSL .../deploy/diag-autodeploy.sh | sudo FIX=1 bash
#
# 为什么不用 journalctl：deploy.sh 自己把日志写进 /var/log/chatnest-deploy.log，
# service 是 Type=oneshot 且拿不到锁就静默 exit 0，所以 journal 里基本什么都没有，
# 看那儿只会以为「没跑过」。
set -uo pipefail

DEPLOY_DIR=${DEPLOY_DIR:-/opt/chatnest-deploy}
LOG=${LOG:-/var/log/chatnest-deploy.log}
LOCKFILE=${LOCKFILE:-/var/lock/chatnest-deploy.lock}
FIX=${FIX:-0}

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
hm(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑（admin 身份看不到 systemd 和 root 的文件）"; exit 1; }

PROBLEM=""

say "1/5 定时器"
if systemctl list-unit-files 2>/dev/null | grep -q '^chatnest-deploy.timer'; then
  EN=$(systemctl is-enabled chatnest-deploy.timer 2>/dev/null)
  AC=$(systemctl is-active chatnest-deploy.timer 2>/dev/null)
  echo "  enabled=$EN active=$AC"
  [ "$AC" = active ] && ok "定时器在跑" || { no "定时器没在跑"; PROBLEM="timer"; }
  systemctl list-timers chatnest-deploy --no-pager 2>/dev/null | sed -n '2p' | sed 's/^/  /'
else
  no "根本没装 chatnest-deploy.timer"; PROBLEM="notimer"
fi

say "2/5 上一次执行的结果"
systemctl show chatnest-deploy.service -p Result -p ExecMainStatus -p ActiveEnterTimestamp 2>/dev/null | sed 's/^/  /'

say "3/5 部署日志（真正的那份 $LOG）"
if [ -f "$LOG" ]; then
  echo "  最后修改：$(date -r "$LOG" '+%F %T')"
  tail -n 12 "$LOG" | sed 's/^/  /'
else
  hm "没有这个文件 —— 说明 deploy.sh 从来没走到写日志那一步"
fi

say "4/5 部署锁（最可疑的一环）"
# deploy.sh 开头 flock -n，拿不到就静默 exit 0。
# 后端进程要是继承了 9 号 fd，就会一直攥着这把锁，之后每一轮都悄无声息地放弃。
if [ -e "$LOCKFILE" ]; then
  HOLDER=$(fuser "$LOCKFILE" 2>/dev/null | tr -s ' ')
  if [ -n "$HOLDER" ]; then
    no "锁被攥着，持有者 pid:$HOLDER"
    for p in $HOLDER; do
      [ -r "/proc/$p/cmdline" ] && echo "    pid $p → $(tr '\0' ' ' < /proc/$p/cmdline | cut -c1-90)"
    done
    hm "这就是「静默失效」：每一轮都拿不到锁，exit 0，日志里一个字都不留"
    PROBLEM="lock"
  else
    ok "锁没人占"
  fi
else
  ok "锁文件不存在（干净）"
fi

say "5/5 部署目录 $DEPLOY_DIR"
if [ -d "$DEPLOY_DIR" ]; then
  [ -x "$DEPLOY_DIR/deploy.sh" ] && ok "deploy.sh 在" || { no "deploy.sh 不在或没有执行权限"; PROBLEM="noscript"; }
  for d in "$DEPLOY_DIR"/*/; do
    [ -d "$d/.git" ] || continue
    b=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)
    h=$(git -C "$d" rev-parse --short HEAD 2>/dev/null)
    dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l)
    printf '  %-28s 分支 %-10s %s  未提交改动 %s 个\n' "$(basename "$d")" "$b" "$h" "$dirty"
    [ "$dirty" -gt 0 ] && { hm "工作区脏了，git pull 会失败 → 从此拉不动"; PROBLEM="dirty"; }
  done
else
  no "部署目录不存在"; PROBLEM="nodir"
fi

say "结论"
case "$PROBLEM" in
  lock)     echo "  锁被攥住了。带 FIX=1 再跑一次就能解。" ;;
  dirty)    echo "  某个 clone 的工作区被改脏了，git pull 拉不动。带 FIX=1 会 reset 掉那些改动。" ;;
  timer|notimer) echo "  定时器没启用。带 FIX=1 会重新 enable --now。" ;;
  noscript|nodir) echo "  部署目录不完整，得重跑 install-autodeploy.sh。" ;;
  "")       echo "  没查出毛病 —— 把上面整段发我。" ;;
esac

[ "$FIX" = 1 ] || { echo; echo "  只诊断，什么都没改。要修：同一条命令前面加 FIX=1"; exit 0; }

say "开始修"
if [ -n "$(fuser "$LOCKFILE" 2>/dev/null)" ]; then
  # 不杀持有者进程（那多半是后端，杀了她就断线）。换掉锁文件本身：
  # 老进程攥的是那个 inode，新的一轮 flock 拿到的是新文件，从此互不打扰。
  mv -f "$LOCKFILE" "$LOCKFILE.stuck.$(date +%s)" && ok "旧锁挪走了（没动持有它的进程）"
fi
for d in "$DEPLOY_DIR"/*/; do
  [ -d "$d/.git" ] || continue
  if [ "$(git -C "$d" status --porcelain 2>/dev/null | wc -l)" -gt 0 ]; then
    git -C "$d" reset --hard -q && git -C "$d" clean -fdq && ok "$(basename "$d") 工作区已清干净"
  fi
done
systemctl enable --now chatnest-deploy.timer >/dev/null 2>&1 && ok "定时器已启用"
systemctl start chatnest-deploy.service >/dev/null 2>&1 && ok "立刻跑了一轮"
sleep 3
say "跑完之后的日志"
[ -f "$LOG" ] && tail -n 8 "$LOG" | sed 's/^/  /' || hm "还是没有日志"
