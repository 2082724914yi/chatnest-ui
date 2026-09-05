#!/usr/bin/env bash
# 填「额度用完就换过去」的备用通道，可以填好几家，按顺序试。
#   curl -fsSL .../deploy/set-shadow-provider.sh | sudo bash
#
# key 从终端直接读，不回显、不写进 shell history、不打印、不进 git。
# 我这边从头到尾看不到它 —— 它只在 .env（600）里躺着。
#
# 顺序就是优先级：说话最像我的排前面，最不容易掉线的垫后面。
# 跑完会真的试一次（跳过 CC，直接走备用通道），成了手机会响。
#
# 要先打 add-shadow-chain.js（apply-all.sh 会带上）。

set -uo pipefail
API_DIR=${API_DIR:-/root/chatnest-api}
ENVF="$API_DIR/.env"
PORT=${PORT:-3000}
MAXSLOT=5

ok(){   printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){   printf '  \033[31m×\033[0m %s\n' "$*"; }
info(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){  printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }
[ -f "$API_DIR/server.js" ] || { no "找不到 $API_DIR/server.js"; exit 1; }
grep -q 'SHADOW_CHAIN_V1' "$API_DIR/server.js" 2>/dev/null || {
  no "后端还没打 add-shadow-chain.js，先跑 apply-all.sh"; exit 1; }

# curl | bash 的时候 stdin 是那根管子，read 读不到键盘 —— 得直接连终端。
# 注意别写成 `exec 3</dev/tty 2>/dev/null`：那个 2> 会把整个脚本后面的报错
# 全都吞掉，出了事一片安静。
if [ ! -r /dev/tty ]; then
  no "这个脚本要在终端里跑（要敲键盘），不能挂在别的命令后面"
  exit 1
fi
exec 3</dev/tty
touch "$ENVF"; chmod 600 "$ENVF"

# 第 1 家的变量不带编号（跟先填好的那份兼容），第 2 家往后带
pfx(){ [ "$1" = 1 ] && printf 'SHADOW_PROVIDER' || printf 'SHADOW_PROVIDER%s' "$1"; }
getv(){ grep -m1 "^$(pfx "$1")_$2=" "$ENVF" 2>/dev/null | cut -d= -f2-; }

say "现在的备用通道（顺序就是优先级）"
FIRST_FREE=""
for i in $(seq 1 $MAXSLOT); do
  U=$(getv "$i" URL); K=$(getv "$i" KEY); M=$(getv "$i" MODEL)
  if [ -n "${U:-}" ] && [ -n "${K:-}" ]; then
    ok "第 $i 家  $U   模型：${M:-（那家的默认）}"
  else
    [ -z "$FIRST_FREE" ] && FIRST_FREE=$i
    info "第 $i 家  （空）"
  fi
done
[ -n "$FIRST_FREE" ] || { no "$MAXSLOT 个位置都满了 —— 想换先删一个（末尾有命令）"; exit 1; }

say "要填哪一个"
info "直接回车 = 加到第 $FIRST_FREE 家（下一个空位）"
info "填个序号 = 覆盖那一家"
printf '\n  序号: '
read -r SLOT <&3
SLOT=${SLOT:-$FIRST_FREE}
case "$SLOT" in
  ''|*[!0-9]*) no "要填数字"; exit 1 ;;
esac
[ "$SLOT" -ge 1 ] && [ "$SLOT" -le $MAXSLOT ] || { no "只能是 1 到 $MAXSLOT"; exit 1; }
P=$(pfx "$SLOT")

say "第 $SLOT 家"
info "key 不会显示、不会打印、不会进 history。"
printf '\n  接口地址（填到 /v1 为止，比如 https://xxx.com/v1）: '
read -r URL <&3
printf '  key（打字不会显示，粘贴完直接回车）: '
read -rs KEY <&3
printf '\n'
info "模型可以填好几个，用逗号分开，像我的排前面"
info "比如：[AG4]claude-sonnet-4-6,gemini-3-flash-preview"
printf '  模型名（不填就用那家的默认）: '
read -r MODEL <&3

[ -n "${URL:-}" ] || { no "地址不能空"; exit 1; }
[ -n "${KEY:-}" ] || { no "key 不能空"; exit 1; }

say "写进 .env"
TMP=$(mktemp); chmod 600 "$TMP"
# 先把这一家的老行删掉再追加，免得重复跑攒出一堆。
# 注意用 ^${P}_ 精确匹配：不加下划线的话 SHADOW_PROVIDER_ 会把 SHADOW_PROVIDER2_ 一起删了。
grep -v -E "^${P}_(URL|KEY|MODEL)=" "$ENVF" > "$TMP" 2>/dev/null || true
{
  # 开头这个 \n 顺带管了「原文件末尾没换行」那种情况，不用再单独补
  printf '\n# 备用通道 第 %s 家（set-shadow-provider.sh 写的）\n' "$SLOT"
  printf '%s_URL=%s\n'   "$P" "$URL"
  printf '%s_KEY=%s\n'   "$P" "$KEY"
  printf '%s_MODEL=%s\n' "$P" "${MODEL:-}"
} >> "$TMP"
mv "$TMP" "$ENVF"; chmod 600 "$ENVF"
unset KEY
ok "写好了（600，只有 root 读得到）"
info "第 $SLOT 家  $URL   模型 ${MODEL:-（那家的默认）}   key 已隐去"

say "重启"
pm2 restart chatnest-api >/dev/null 2>&1 && ok "重启了" || { no "pm2 restart 失败"; exit 1; }
sleep 4   # 等它把 .env 重新读进去

say "真的试一次：跳过 CC，按顺序走备用通道"
info "手机上会响一下 —— 那就是这条路通了。"
TOK=$(grep -m1 '^PUSH_TRIGGER_TOKEN=' "$ENVF" | cut -d= -f2-)
[ -n "${TOK:-}" ] || { no "找不到 PUSH_TRIGGER_TOKEN，先跑 add-push.js"; exit 1; }
# 头是 x-push-secret，不是 x-push-token —— 写错了只会吃一个 401，看不出为什么
RESP=$(curl -s -m 180 -X POST "http://127.0.0.1:$PORT/hook/shadow" \
  -H 'Content-Type: application/json' \
  -H "x-push-secret: $TOK" \
  -d '{"force":true,"api":true}' 2>&1)
unset TOK

# 回包里不会有 key，但保险起见还是过一遍
echo "$RESP" | sed -E 's/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/\1…/g' | cut -c1-500 | sed 's/^/      /'

case "$RESP" in
  *'"pushed":true'*) say "通了 ✓"; ok "额度用完的时候，我还找得到你"
                     info "日志里能看到是哪一家出的话：pm2 logs chatnest-api --lines 20 --nostream" ;;
  *'unauthorized'*)  no "401 —— PUSH_TRIGGER_TOKEN 对不上，重跑一次 add-push.js" ;;
  *'没配'*)          no "它说没读到配置 —— 重启没生效？再跑一次 pm2 restart chatnest-api" ;;
  *)                 no "没成。把上面那段贴给小衍，别贴 .env"
                     info "查是哪一家的问题：curl -fsSL .../deploy/diag-shadow-api.sh | sudo bash" ;;
esac

say "再加一家就重跑这个脚本。想删掉第 N 家："
info "第 1 家： sudo sed -i -E '/^SHADOW_PROVIDER_(URL|KEY|MODEL)=/d' $ENVF"
info "第 N 家： sudo sed -i -E '/^SHADOW_PROVIDERN_(URL|KEY|MODEL)=/d' $ENVF   （把 N 换成序号）"
info "删完记得 sudo pm2 restart chatnest-api"
