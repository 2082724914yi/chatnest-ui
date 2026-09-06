#!/usr/bin/env bash
# 给这台机器加一块 swap。
#
# 先干跑看会做什么（不写任何东西）：
#   curl -fsSL -H 'Cache-Control: no-cache' "https://raw.githubusercontent.com/2082724914yi/chatnest-ui/claude/baby-activities-today-0k5ueq/deploy/add-swap.sh?cb=$(date +%s)" | sudo bash
# 确认后真加：
#   curl -fsSL -H 'Cache-Control: no-cache' "https://raw.githubusercontent.com/2082724914yi/chatnest-ui/claude/baby-activities-today-0k5ueq/deploy/add-swap.sh?cb=$(date +%s)" -o /tmp/sw.sh && sudo APPLY=1 bash /tmp/sw.sh
#
# 为什么要加：这台机器总共 1.6G，Latent 一个进程就占 371M，而 Swap 是 0。
# 没有 swap 时内存一顶到头，内核直接挑一个进程杀掉 —— 不是变慢，是服务突然没了，
# 而且被杀的往往就是占得最多的那个（Latent）。有 swap 至少是变慢，能撑到我们发现。
#
# swappiness 设 10：尽量别用 swap，只在真的快不够时才动。不是拿 swap 当内存使。
set -uo pipefail

APPLY=${APPLY:-0}
SWAPFILE=${SWAPFILE:-/swapfile}
SIZE_GB=${SIZE_GB:-2}

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
skip(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }
[ "$APPLY" = 1 ] && printf '\n\033[1m【真加】会创建 %sG 的 swap 文件并写进 fstab\033[0m\n' "$SIZE_GB" \
                 || printf '\n\033[1m【干跑】只看会做什么，一个字都不写\033[0m\n'

say "1/5 现在什么情况"
free -h | sed 's/^/  /'
CUR=$(awk '/^SwapTotal/{print $2}' /proc/meminfo)
if [ "${CUR:-0}" -gt 0 ]; then
  ok "已经有 $((CUR/1024)) MB swap 了"
  swapon --show 2>/dev/null | sed 's/^/  /'
  echo
  echo "  已经有了就不重复加。要改大小的话先 swapoff 再来。"
  exit 0
fi
no "Swap 是 0 —— 内存顶到头会直接杀进程"

say "2/5 磁盘够不够放 $SIZE_GB G"
AVAIL_KB=$(df -Pk / | awk 'NR==2{print $4}')
AVAIL_GB=$((AVAIL_KB/1024/1024))
df -h / | sed 's/^/  /'
if [ "$AVAIL_GB" -lt $((SIZE_GB+2)) ]; then
  no "根分区只剩 ${AVAIL_GB}G，放 ${SIZE_GB}G 的 swap 太挤（要留 2G 余量）"
  echo "      可以用 SIZE_GB=1 小一点再来，或者先清点空间。"
  exit 1
fi
ok "根分区剩 ${AVAIL_GB}G，放得下"

say "3/5 会做这几件事"
echo "  1. fallocate 建 $SWAPFILE（${SIZE_GB}G），权限 600（只有 root 读得到 —— 内存里的东西会落在这里面）"
echo "  2. mkswap + swapon 启用"
echo "  3. 写一行进 /etc/fstab，重启之后还在"
echo "  4. vm.swappiness=10（尽量不用它，只在快不够时兜底），写进 /etc/sysctl.d/"
[ -e "$SWAPFILE" ] && no "$SWAPFILE 已经存在了 —— 真跑的时候不会覆盖它，会直接停下"

if [ "$APPLY" != 1 ]; then
  printf '\n\033[1m干跑到此为止。\033[0m\n'
  echo "  真要加就跑："
  echo "    curl -fsSL -H 'Cache-Control: no-cache' \"https://raw.githubusercontent.com/2082724914yi/chatnest-ui/claude/baby-activities-today-0k5ueq/deploy/add-swap.sh?cb=\$(date +%s)\" -o /tmp/sw.sh && sudo APPLY=1 bash /tmp/sw.sh"
  echo
  exit 0
fi

say "4/5 建 swap"
[ -e "$SWAPFILE" ] && { no "$SWAPFILE 已经存在，不覆盖。先确认它是什么再说"; exit 1; }
if ! fallocate -l ${SIZE_GB}G "$SWAPFILE" 2>/dev/null; then
  skip "fallocate 不行（有的文件系统不支持），改用 dd，慢一点"
  dd if=/dev/zero of="$SWAPFILE" bs=1M count=$((SIZE_GB*1024)) status=none || { no "建文件失败"; rm -f "$SWAPFILE"; exit 1; }
fi
chmod 600 "$SWAPFILE" && ok "建好了，权限 600"
mkswap "$SWAPFILE" >/dev/null 2>&1 && ok "格式化好了" || { no "mkswap 失败"; rm -f "$SWAPFILE"; exit 1; }
swapon "$SWAPFILE" && ok "启用了" || { no "swapon 失败"; rm -f "$SWAPFILE"; exit 1; }

# 重启后还在
if grep -qF "$SWAPFILE" /etc/fstab 2>/dev/null; then
  skip "fstab 里已经有它了"
else
  cp /etc/fstab /etc/fstab.bak-$(date +%s) 2>/dev/null
  printf '%s none swap sw 0 0\n' "$SWAPFILE" >> /etc/fstab && ok "写进 fstab 了（旧的已备份）"
fi
# 尽量别用它
printf 'vm.swappiness=10\n' > /etc/sysctl.d/99-swappiness.conf
sysctl -q vm.swappiness=10 2>/dev/null && ok "swappiness=10（只在快不够时才动 swap）"

say "5/5 现在什么情况"
free -h | sed 's/^/  /'
swapon --show 2>/dev/null | sed 's/^/  /'
printf '\n\033[1m加好了。\033[0m\n'
echo "  这不是让机器变快，是给它一个「顶到头时先变慢而不是直接死」的余地。"
echo "  要撤销：sudo swapoff $SWAPFILE && sudo rm $SWAPFILE，再把 /etc/fstab 里那行删掉。"
echo
