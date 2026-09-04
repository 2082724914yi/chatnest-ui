#!/usr/bin/env bash
# 从前端部署备份里，找回「常驻会话·持续进程模式」那个开关。
#   curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/recover-resident.sh | sudo bash
#
# 背景：这个开关只存在于线上那份 index.html，从没提交进仓库，
# 而 deploy-frontend.sh 是整份覆盖 —— 于是被冲掉了。
# 幸好它覆盖前会备份成 index.html.bak-<时间戳>，这里从备份里把它抠出来。
# 只读，不改任何东西。
set -uo pipefail

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

OUT=/tmp/resident-found.txt
: > "$OUT"

say "1 找前端备份"
BAKS=$(find ${SEARCH_ROOT:-/var/www /srv /usr/share/nginx /opt /home /root} -maxdepth 6 \
        \( -name 'index.html.bak*' -o -name 'index.html.*.bak' \) 2>/dev/null | head -60)
if [ -z "${BAKS:-}" ]; then
  no "没找到任何 index.html 备份"
  echo "     试试这个（可能在别处）： find / -name 'index.html.bak*' 2>/dev/null | head"
  exit 1
fi
echo "$BAKS" | while read -r f; do printf '  %s  (%s 字节, %s)\n' "$f" "$(wc -c <"$f")" "$(date -r "$f" '+%m-%d %H:%M' 2>/dev/null)"; done

say "2 哪一份里有这个开关"
HIT=""
for f in $BAKS; do
  if grep -qE '持续进程|常驻会话' "$f" 2>/dev/null; then
    ok "找到：$f"
    HIT="$f"; break
  fi
done
if [ -z "$HIT" ]; then
  no "备份里都没有「持续进程 / 常驻会话」字样"
  echo "     换个词再找一遍："
  for f in $BAKS; do
    M=$(grep -oE '[^<>"]{0,12}(常驻|进程模式|增量缓存)[^<>"]{0,12}' "$f" 2>/dev/null | head -3)
    [ -n "$M" ] && { echo "     $f:"; printf '%s\n' "$M" | sed 's/^/       /'; }
  done
  exit 1
fi

say "3 把相关代码抠出来"
{
  echo "=== 来源备份: $HIT ==="
  echo
  echo "--- 界面上那一行（含 id / data 属性）---"
  grep -oE '<[^<>]{0,400}(持续进程|常驻会话)[^<>]{0,400}>' "$HIT" | head -5
  grep -oE '.{0,300}(持续进程|常驻会话).{0,300}' "$HIT" | head -5
  echo
  echo "--- 用到的设置项 key ---"
  grep -oE "_settingsVal\('[A-Za-z_]{3,40}'[^)]{0,30}\)" "$HIT" \
    | sort -u | grep -iE 'resident|persist|process|session|cache|keep' | head -20
  echo
  echo "--- 发请求时带的字段 ---"
  grep -oE '[A-Za-z_]{3,30}\s*:\s*_settingsVal\([^)]{0,60}\)' "$HIT" \
    | grep -iE 'resident|persist|process|cache|keep' | sort -u | head -20
} | tee "$OUT"

say "4 跟现在线上那份比一比，看还少了什么别的"
LIVE=""
for r in $(nginx -T 2>/dev/null | awk '$1=="root"{gsub(/;/,"",$2);print $2}' | sort -u); do
  [ -f "$r/index.html" ] && LIVE="$r/index.html" && break
done
if [ -n "$LIVE" ]; then
  echo "  线上：$LIVE ($(wc -c <"$LIVE") 字节)"
  echo "  备份：$HIT ($(wc -c <"$HIT") 字节)"
  echo "  ── 备份里有、线上没有的界面文字（最多 25 条）──"
  comm -23 \
    <(grep -oE '>[^<>]{2,30}<' "$HIT"  | tr -d '><' | grep -E '[一-龥]' | sort -u) \
    <(grep -oE '>[^<>]{2,30}<' "$LIVE" | tr -d '><' | grep -E '[一-龥]' | sort -u) \
    | head -25 | sed 's/^/    /'
else
  no "找不到线上那份，跳过比对"
fi

echo
echo "  完整结果也存在 $OUT"
echo "  把上面第 3、4 节发回来就行。"
echo
