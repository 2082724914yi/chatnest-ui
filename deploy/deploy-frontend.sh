#!/usr/bin/env bash
# 直接把最新前端放到 nginx 真正在读的那个目录里。
# 不依赖 git、不依赖定时器、不依赖那个部署锁 —— 从 GitHub 直接下，找到真目录，覆盖，再从外网验一遍。
#   curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/deploy-frontend.sh | sudo bash
set -uo pipefail

RAW_URL=https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/index.html
SITE=${SITE:-https://xiaoyixiaoyan.top/index.html}

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }

say "1/5 下载最新前端"
NEW=$(mktemp /tmp/index.XXXXXX.html)
curl -fsSL -m 120 "$RAW_URL" -o "$NEW" || { no "下载失败（网络？）"; exit 1; }
NEWSIZE=$(wc -c < "$NEW")
[ "$NEWSIZE" -gt 100000 ] || { no "下下来只有 $NEWSIZE 字节，不对劲，不敢用"; rm -f "$NEW"; exit 1; }
grep -qi '</html>' "$NEW" || { no "文件不完整（没有 </html>），不敢用"; rm -f "$NEW"; exit 1; }
grep -q 'obToolsBtn' "$NEW" || { no "这份里没有工具台，可能拉到了旧版本"; rm -f "$NEW"; exit 1; }
ok "拿到 $NEWSIZE 字节（含工具台，完整）"

say "2/5 线上现在是哪一版"
LIVE_SIZE=$(curl -fsS -m 25 "$SITE" 2>/dev/null | wc -c)
echo "  外网拿到：$LIVE_SIZE 字节"
if [ "$LIVE_SIZE" = "$NEWSIZE" ]; then
  ok "线上已经是最新的了，那就是手机缓存 —— 把页面彻底关掉重开，或者换个浏览器试试"
  rm -f "$NEW"; exit 0
fi

say "3/5 找 nginx 真正在读的目录"
ROOTS=$(nginx -T 2>/dev/null | awk '$1=="root"{gsub(/;/,"",$2); print $2}' | sort -u)
[ -n "${ROOTS:-}" ] && echo "$ROOTS" | sed 's/^/  配置里的 root: /' || no "读不到 nginx 配置（nginx -T 失败）"

# 真目标 = 目录里的 index.html 大小正好等于外网那份
TARGETS=""
for r in $ROOTS; do
  f="$r/index.html"
  [ -f "$f" ] || continue
  sz=$(wc -c < "$f")
  echo "     $f → $sz 字节"
  [ "$sz" = "$LIVE_SIZE" ] && TARGETS="$TARGETS $f"
done
# 配置里找不到就全盘找一遍同样大小的
if [ -z "${TARGETS// /}" ]; then
  echo "  配置里的 root 对不上，全盘找同样大小的 index.html…"
  while IFS= read -r f; do
    # git 工作区里的那份是仓库副本，不是 nginx 在读的，别去动它
    [ -d "$(dirname "$f")/.git" ] && { echo "     跳过（git 副本）$f"; continue; }
    echo "     $f"
    TARGETS="$TARGETS $f"
  done < <(find /var /srv /opt /home /usr/share/nginx -maxdepth 5 -name index.html -size -2M 2>/dev/null \
           | while read -r f; do [ "$(wc -c < "$f")" = "$LIVE_SIZE" ] && echo "$f"; done)
fi
[ -n "${TARGETS// /}" ] || { no "找不到线上那份文件在哪，把这段输出发回来"; rm -f "$NEW"; exit 1; }

say "4/5 覆盖"
for f in $TARGETS; do
  cp "$f" "$f.bak-$(date +%s)" 2>/dev/null
  cp "$NEW" "$f" && ok "已写入 $f（$(wc -c < "$f") 字节，旧的已备份）"
done
rm -f "$NEW"
nginx -s reload 2>/dev/null && ok "nginx 已 reload" || true

say "5/5 从外网再验一次"
sleep 2
AFTER=$(curl -fsS -m 25 -H 'Cache-Control: no-cache' "$SITE" 2>/dev/null | wc -c)
if [ "$AFTER" = "$NEWSIZE" ]; then
  ok "外网拿到的就是新版（$AFTER 字节）"
  cat <<'EOF'

  手机上把页面彻底关掉再重开（下拉刷新有时候不换缓存）。
  新版一眼能认出来：标题栏右边多了个 🧰，最后一栏从「日志」变成「标签」。

EOF
else
  no "外网还是 $AFTER 字节（新版是 $NEWSIZE）—— 可能有 CDN 或反代在缓存，把这段发回来"
fi
