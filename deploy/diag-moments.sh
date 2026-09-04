#!/usr/bin/env bash
# 朋友圈接口不通 —— 一次把该看的都看了，只读不改。
#   curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/diag-moments.sh | sudo bash
set -uo pipefail

API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
PORT=${PORT:-3000}

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ -f "$SRV" ] || { no "找不到 $SRV"; exit 1; }

printf '\n\033[1m======== 最要紧的两行，先看这里 ========\033[0m\n'
for p in /api/health /api/moments; do
  BODY=$(mktemp)
  CODE=$(curl -s -o "$BODY" -w '%{http_code}' -m 8 "http://127.0.0.1:$PORT$p" 2>/dev/null)
  printf '  %-16s HTTP \033[1m%s\033[0m\n' "$p" "$CODE"
  if [ "$p" = /api/moments ]; then
    echo "     ── 返回内容前 300 字 ──"
    head -c 300 "$BODY" | sed 's/^/     /'
    echo
  fi
  rm -f "$BODY"
done

say "1 pm2 到底在跑哪个文件、稳不稳"
if command -v pm2 >/dev/null 2>&1; then
  pm2 jlist 2>/dev/null | python3 -c "
import sys,json,datetime
try: apps=json.load(sys.stdin)
except Exception: apps=[]
if not apps: print('  （pm2 里没有进程）')
for a in apps:
    e=a.get('pm2_env',{}) or {}
    up=e.get('pm_uptime')
    alive='?'
    if up:
        s=int((datetime.datetime.now().timestamp()*1000-up)/1000)
        alive=f'{s//60}分{s%60}秒' if s>=60 else f'{s}秒'
    print(f\"  名字     : {a.get('name')}\")
    print(f\"  跑的文件 : {e.get('pm_exec_path')}\")
    print(f\"  状态     : {e.get('status')}   重启过 {e.get('restart_time')} 次   已经活了 {alive}\")
" 2>/dev/null || echo "  （读不到 pm2 状态）"
else
  echo "  （没装 pm2）"
fi

say "2 代码里这几块各在第几行"
printf '  %-34s %s\n' "MOMENTS_FILE 定义"      "$(grep -n 'MOMENTS_FILE *=' "$SRV" | head -1 | cut -d: -f1)"
printf '  %-34s %s\n' "function loadMoments"   "$(grep -n 'function loadMoments' "$SRV" | head -1 | cut -d: -f1)"
printf '  %-34s %s\n' "app.get('/api/moments'" "$(grep -n "app.get('/api/moments'" "$SRV" | head -1 | cut -d: -f1)"
printf '  %-34s %s\n' "app.listen"             "$(grep -n 'app.listen' "$SRV" | head -1 | cut -d: -f1)"
printf '  %-34s %s\n' "文件总行数"              "$(wc -l < "$SRV")"

LN_R=$(grep -n "app.get('/api/moments'" "$SRV" | head -1 | cut -d: -f1)
LN_L=$(grep -n 'app.listen' "$SRV" | head -1 | cut -d: -f1)
if [ -n "${LN_R:-}" ] && [ -n "${LN_L:-}" ]; then
  [ "$LN_R" -lt "$LN_L" ] && ok "路由在 app.listen 之前（顺序对）" \
                          || no "路由跑到 app.listen 之后了 —— 那它永远不会被注册"
fi

say "3 loadMoments 是不是顶层函数"
# 顶层声明的行首没有缩进；缩进了就说明被塞进某个函数里了
LINE=$(grep -n 'function loadMoments' "$SRV" | head -1)
echo "  $LINE"
printf '%s' "$LINE" | grep -qE ':\s+function' && no "有缩进 —— 可能被塞进了别的函数体内" || ok "顶层声明"

say "4 那几个路由的原文"
grep -n "app\.\(get\|post\|delete\|use\)('/api/moment" "$SRV" | sed 's/^/  /'

say "5 日志里跟 moments 有关的报错（注意：pm2 给的是日志末尾，服务修好后不再写新日志，这里翻出来的很可能是崩溃那阵子的旧记录）"
LOG=$( (pm2 logs --lines 120 --nostream 2>/dev/null || tail -120 /var/log/chatnest-api.log 2>/dev/null) )
printf '%s' "$LOG" | grep -iE 'moments|ReferenceError|TypeError|Cannot read|is not defined|is not a function' \
  | tail -12 | sed 's/^/  /' || echo "  （没找到相关报错）"

say "6 数据文件"
for f in "$API_DIR/moments.json" "$API_DIR/moment-images"; do
  if [ -e "$f" ]; then ok "$f 存在（$(stat -c '%U:%G %a' "$f" 2>/dev/null)）"
  else no "$f 不存在"; fi
done

echo
echo "  把上面整段发回来就行。"
echo
