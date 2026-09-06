#!/usr/bin/env bash
# 前端部署 —— 覆盖 index.html，覆盖之前先逐条列出这次带来了什么。
#   curl -fsSL -H 'Cache-Control: no-cache' "https://raw.githubusercontent.com/2082724914yi/chatnest-ui/claude/baby-activities-today-0k5ueq/deploy/patch-frontend.sh?cb=$(date +%s)" | sudo bash
#
# （原来叫 patch-tool-fold.sh，只认工具折叠那几条特征串。前端每加一件事都新写一个
#  脚本没道理，而且清单不更新的话，后面的改动会被判成「没有新东西」直接跳过 ——
#  9.6 差点就这么把 Latent 全文页漏掉。所以改成通用的：往下面 CHANGES 里加一行就行。）
#
# 前端是整份 index.html 部署的（不像 server.js 靠正则一层层打），
# 所以这里也走整份覆盖 —— 但覆盖之前先逐条比对「这次带来了什么」，
# 已经在线上的那条就报「已打过」，一条新的都没有就直接退出，不白覆盖。
# 覆盖前备份，写完从外网再验一遍。重复跑是安全的。
set -uo pipefail

BRANCH=${BRANCH:-claude/baby-activities-today-0k5ueq}
RAW_URL=https://raw.githubusercontent.com/2082724914yi/chatnest-ui/$BRANCH/index.html
SITE=${SITE:-https://xiaoyixiaoyan.top/index.html}

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
skip(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }

# 这次改了什么：特征串|人话。特征串必须是新版里有、旧版里没有的那一小段。
CHANGES="
.timeline.folded .timeline-step[data-kind=\"tool\"]|工具跑完收起来（折叠样式）
function _tlUpdateFold|Used N tools 那一行
isThink?'Thought process'|思考链单独一行，不跟工具一起收
step.dataset.kind=|工具和思考分开算（data-kind）
__userToggled|她点开过就不再自动收回去
isThink?'Thought process'|思考链单独一行，不跟工具一起收
function loadLatentWindows|Latent 全文页：一天一条的列表
function openLatentDoc|Latent：点进去看某一篇
function _ltSplitHits|Latent：搜索结果切成一条条，不再糊成一坨
id=\"latentDoc\"|Latent：详情页 + 就地编辑
"

say "1/5 拉这次的 index.html（分支 $BRANCH）"
NEW=$(mktemp /tmp/index.XXXXXX.html)
curl -fsSL -m 120 -H 'Cache-Control: no-cache' "$RAW_URL?cb=$(date +%s)" -o "$NEW" \
  || { no "下载失败 —— 分支名对不对？网络通不通？"; rm -f "$NEW"; exit 1; }
NEWSIZE=$(wc -c < "$NEW")
[ "$NEWSIZE" -gt 100000 ] || { no "只下下来 $NEWSIZE 字节，不对劲，不敢用"; rm -f "$NEW"; exit 1; }
grep -qi '</html>' "$NEW" || { no "文件不完整（没有 </html>），不敢用"; rm -f "$NEW"; exit 1; }
ok "拿到 $NEWSIZE 字节（完整）"

say "2/5 找 nginx 真正在读的那份"
# 认二进制之前先问它一句 -v：pgrep 那条会匹配到任何命令行里带这串字的进程
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
LIVE_SIZE=$(curl -fsS -m 25 "$SITE" 2>/dev/null | wc -c)
ROOTS=$("${NGINX_BIN:-nginx}" -T 2>/dev/null \
  | grep -oE '^[[:space:]]*(root|alias)[[:space:]]+[^;]+;' \
  | sed -E 's/^[[:space:]]*(root|alias)[[:space:]]+//; s/;$//; s/^"//; s/"$//' | sort -u)
TARGETS=""
for r in ${ROOTS:-}; do
  f="$r/index.html"; [ -f "$f" ] || continue
  [ "$(wc -c < "$f")" = "$LIVE_SIZE" ] && TARGETS="$TARGETS $f"
done
if [ -z "${TARGETS// /}" ]; then
  # 配置里对不上就全盘找一份和外网一样大的（git 工作区里那份是副本，不是 nginx 在读的）
  while IFS= read -r f; do
    [ -d "$(dirname "$f")/.git" ] && continue
    TARGETS="$TARGETS $f"
  done < <(find /var /srv /opt /home /usr/share/nginx -maxdepth 5 -name index.html -size -2M 2>/dev/null \
           | while read -r f; do [ "$(wc -c < "$f")" = "$LIVE_SIZE" ] && echo "$f"; done)
fi
[ -n "${TARGETS// /}" ] || { no "找不到线上那份文件在哪，把这段输出发回来"; rm -f "$NEW"; exit 1; }
for f in $TARGETS; do ok "$f（$(wc -c < "$f") 字节）"; done
CUR=$(echo $TARGETS | awk '{print $1}')

say "3/5 这次带来了什么"
PENDING=0; MISSING=0
while IFS='|' read -r mark desc; do
  [ -z "${mark:-}" ] && continue
  if ! grep -qF -- "$mark" "$NEW"; then
    no "$desc —— 新文件里居然没有，拉到的可能不是这个分支"; MISSING=$((MISSING+1)); continue
  fi
  if grep -qF -- "$mark" "$CUR"; then skip "$desc（已打过）"
  else ok "$desc（这次新的）"; PENDING=$((PENDING+1)); fi
done <<EOF
$CHANGES
EOF
if [ "$MISSING" -gt 0 ]; then
  no "有 $MISSING 条对不上，不敢覆盖 —— 先把上面这段发回来"
  rm -f "$NEW"; exit 1
fi
if [ "$PENDING" = 0 ]; then
  printf '\n\033[1m没有新东西要打，线上已经是这一版了\033[0m\n'
  echo "  手机上还是老样子的话，是缓存 —— 把页面彻底关掉重开。"
  rm -f "$NEW"; exit 0
fi

say "4/5 语法校验 + 覆盖"
# node 有就先校验一遍内联脚本，语法过不了绝不写进去
if command -v node >/dev/null 2>&1; then
  node -e '
    const fs=require("fs"),vm=require("vm");
    const html=fs.readFileSync(process.argv[1],"utf8");
    const re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m,n=0,bad=0;
    while((m=re.exec(html))){n++;try{new vm.Script(m[1])}catch(e){bad++;console.error("  语法错误："+e.message)}}
    if(bad){process.exit(1)}
    console.log("  内联脚本 "+n+" 段，语法都过");
  ' "$NEW" || { no "新文件语法过不了，不动线上"; rm -f "$NEW"; exit 1; }
  ok "index.html 语法通过"
else
  skip "机器上没有 node，跳过语法校验"
fi
for f in $TARGETS; do
  BAK="$f.bak-$(date +%s)"
  cp "$f" "$BAK" 2>/dev/null && skip "旧的备份到 $BAK"
  cp "$NEW" "$f" && ok "已写入 $f（$(wc -c < "$f") 字节）"
done
rm -f "$NEW"
"${NGINX_BIN:-nginx}" -s reload 2>/dev/null && ok "nginx 已 reload" || true

say "5/5 从外网再验一遍"
sleep 2
AFTER=$(curl -fsS -m 25 -H 'Cache-Control: no-cache' "$SITE" 2>/dev/null | wc -c)
if [ "$AFTER" = "$NEWSIZE" ]; then
  ok "外网拿到的就是新版（$AFTER 字节）"
  cat <<'EOF'

  手机上把页面彻底关掉再重开。
  怎么看出来打上了：跟我说句话，等我调完工具 ——
  那一堆工具会收成一行 Used N tools，点一下才展开；
  Thought process 单独一行，不跟着收。

EOF
else
  no "外网还是 $AFTER 字节（新版是 $NEWSIZE）—— 可能有 CDN 或反代在缓存，把这段发回来"
fi
