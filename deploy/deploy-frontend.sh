#!/usr/bin/env bash
# 直接把最新前端放到 nginx 真正在读的那个目录里。
# 不依赖 git、不依赖定时器、不依赖那个部署锁 —— 从 GitHub 直接下，找到真目录，覆盖，再从外网验一遍。
#   curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/deploy-frontend.sh | sudo bash
set -uo pipefail

# 默认 main。补丁还在分支上没合过去时用 BRANCH=分支名 覆盖。
BRANCH=${BRANCH:-main}
RAW_URL=https://raw.githubusercontent.com/2082724914yi/chatnest-ui/$BRANCH/index.html
RAW_SW=https://raw.githubusercontent.com/2082724914yi/chatnest-ui/$BRANCH/sw.js
SITE=${SITE:-https://xiaoyixiaoyan.top/index.html}
SITE_SW=${SITE_SW:-https://xiaoyixiaoyan.top/sw.js}

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }

say "1/5 下载最新前端"
NEW=$(mktemp /tmp/index.XXXXXX.html)
curl -fsSL -m 120 -H 'Cache-Control: no-cache' "$RAW_URL?cb=$(date +%s)" -o "$NEW" || { no "下载失败（网络？）"; exit 1; }
NEWSIZE=$(wc -c < "$NEW")
[ "$NEWSIZE" -gt 100000 ] || { no "下下来只有 $NEWSIZE 字节，不对劲，不敢用"; rm -f "$NEW"; exit 1; }
grep -qi '</html>' "$NEW" || { no "文件不完整（没有 </html>），不敢用"; rm -f "$NEW"; exit 1; }
grep -q 'obToolsBtn' "$NEW" || { no "这份里没有工具台，可能拉到了旧版本"; rm -f "$NEW"; exit 1; }
ok "拿到 $NEWSIZE 字节（含工具台，完整）"

# sw.js 也要传 —— 推送全靠它接。拿不到不算致命（老站点可能还没有这个文件）
NEWSW=$(mktemp /tmp/sw.XXXXXX.js)
if curl -fsSL -m 60 -H 'Cache-Control: no-cache' "$RAW_SW?cb=$(date +%s)" -o "$NEWSW" && [ -s "$NEWSW" ]; then
  SWSIZE=$(wc -c < "$NEWSW"); ok "sw.js 拿到 $SWSIZE 字节"
else
  rm -f "$NEWSW"; NEWSW=""; SWSIZE=0
  no "sw.js 没拉到，这次只更新 index.html"
fi

say "2/5 线上现在是哪一版"
LIVE_SIZE=$(curl -fsS -m 25 "$SITE" 2>/dev/null | wc -c)
LIVE_SW=$(curl -fsS -m 25 "$SITE_SW" 2>/dev/null | wc -c || echo 0)
echo "  外网拿到：index.html $LIVE_SIZE 字节，sw.js $LIVE_SW 字节"
# 两个都一样才算没事干 —— 之前只看 index.html，sw.js 就永远更新不上
if [ "$LIVE_SIZE" = "$NEWSIZE" ] && { [ -z "$NEWSW" ] || [ "$LIVE_SW" = "$SWSIZE" ]; }; then
  ok "线上已经是最新的了，那就是手机缓存 —— 把页面彻底关掉重开，或者换个浏览器试试"
  rm -f "$NEW" "$NEWSW"; exit 0
fi
[ "$LIVE_SIZE" = "$NEWSIZE" ] && echo "  index.html 已是最新，但 sw.js 要更新（$LIVE_SW → $SWSIZE）"

say "3/5 找 nginx 真正在读的目录"
# nginx 不一定叫 nginx、也不一定在 PATH 里（宝塔装在 /www/server、openresty 装在自己目录）。
# 最靠谱的是从**正在跑的** master 进程反查它自己的二进制，那份必然是线上在用的那个。
# 认定之前先问它一句 -v：pgrep 那条会匹配到任何命令行里带这串字的进程，
# 光看"能执行"会把 bash 自己当成 nginx。
_is_nginx(){ [ -n "${1:-}" ] && [ -x "$1" ] && "$1" -v 2>&1 | grep -qi nginx; }
NGINX_BIN=""
_c=$(command -v nginx 2>/dev/null || true)
_is_nginx "${_c:-}" && NGINX_BIN="$_c"
if [ -z "$NGINX_BIN" ]; then
  for p in $(pgrep -f 'nginx: master' 2>/dev/null || true); do
    b=$(readlink -f "/proc/$p/exe" 2>/dev/null || true)
    _is_nginx "${b:-}" && { NGINX_BIN="$b"; break; }
  done
fi
if [ -z "$NGINX_BIN" ]; then
  for c in /usr/sbin/nginx /usr/local/nginx/sbin/nginx /www/server/nginx/sbin/nginx \
           /usr/local/openresty/nginx/sbin/nginx /opt/nginx/sbin/nginx; do
    _is_nginx "$c" && { NGINX_BIN="$c"; break; }
  done
fi
# -T 把配置 dump 到 stdout，"syntax is ok / test is successful" 走的是 stderr，那是正常信息不是报错。
# 所以先看它到底成功没有（退出码），再谈找不找得到 root —— 这两件事不是一回事。
NGX_CONF=$("${NGINX_BIN:-nginx}" -T 2>/dev/null); NGX_RC=$?
NGX_ERR=$("${NGINX_BIN:-nginx}" -T 2>&1 >/dev/null | head -4)
# root 那行前面有缩进、后面可能跟注释，路径也可能带引号：整行抓，别只看第一个字段
ROOTS=$(printf '%s\n' "$NGX_CONF" \
  | grep -oE '^[[:space:]]*(root|alias)[[:space:]]+[^;]+;' \
  | sed -E 's/^[[:space:]]*(root|alias)[[:space:]]+//; s/;$//; s/^"//; s/"$//' \
  | sort -u)
if [ -n "${ROOTS:-}" ]; then
  echo "  用的 nginx: ${NGINX_BIN:-nginx}"
  echo "$ROOTS" | sed 's/^/  配置里的 root: /'
elif [ "${NGX_RC:-1}" = 0 ]; then
  # 配置读到了，只是里面没写 root（比如全是 proxy_pass 反代）—— 这不算失败
  no "nginx 配置读到了，但里面没有 root/alias 指向静态目录"
else
  no "读不到 nginx 配置（试过：${NGINX_BIN:-没找到 nginx 二进制}）"
  # 把真正的原因打出来 —— 闷着只能靠猜，猜了两轮了
  [ -n "${NGX_ERR:-}" ] && echo "$NGX_ERR" | sed 's/^/      nginx 说: /'
  # 它到底是不是真在提供网页服务？listen 80/443 的是谁
  WHO=$( (ss -lptn 2>/dev/null || netstat -lptn 2>/dev/null) | awk '$4 ~ /:(80|443)$/ {print $NF}' | sort -u | head -3)
  [ -n "${WHO:-}" ] && echo "      占着 80/443 的是: $WHO"
fi

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
  # sw.js 必须和 index.html 同级（放子目录 scope 会受限，push 事件根本不触发）
  if [ -n "$NEWSW" ]; then
    d=$(dirname "$f")
    [ -f "$d/sw.js" ] && cp "$d/sw.js" "$d/sw.js.bak-$(date +%s)" 2>/dev/null
    cp "$NEWSW" "$d/sw.js" && ok "已写入 $d/sw.js（$(wc -c < "$d/sw.js") 字节）"
  fi
done
rm -f "$NEW" "$NEWSW"
"${NGINX_BIN:-nginx}" -s reload 2>/dev/null && ok "nginx 已 reload" || true

say "5/5 从外网再验一次"
sleep 2
AFTER=$(curl -fsS -m 25 -H 'Cache-Control: no-cache' "$SITE" 2>/dev/null | wc -c)
AFTER_SW=$(curl -fsS -m 25 -H 'Cache-Control: no-cache' "$SITE_SW" 2>/dev/null | wc -c || echo 0)
if [ -n "$NEWSW" ]; then
  [ "$AFTER_SW" = "$SWSIZE" ] && ok "sw.js 也是新版（$AFTER_SW 字节）" \
    || no "sw.js 外网还是 $AFTER_SW 字节（新版 $SWSIZE）"
fi
if [ "$AFTER" = "$NEWSIZE" ]; then
  ok "外网拿到的就是新版（$AFTER 字节）"
  cat <<'EOF'

  手机上把页面彻底关掉再重开（下拉刷新有时候不换缓存）。
  新版一眼能认出来：标题栏右边多了个 🧰，最后一栏从「日志」变成「标签」。

EOF
else
  no "外网还是 $AFTER 字节（新版是 $NEWSIZE）—— 可能有 CDN 或反代在缓存，把这段发回来"
fi
