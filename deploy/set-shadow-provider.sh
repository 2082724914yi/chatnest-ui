#!/usr/bin/env bash
# 填那份「额度用完就换过去」的 API 配置。
#   curl -fsSL .../deploy/set-shadow-provider.sh | sudo bash
#
# key 从终端直接读，不回显、不写进 shell history、不打印、不进 git。
# 我这边从头到尾看不到它 —— 它只在 .env（600）里躺着。
#
# 跑完会真的试一次：跳过 CC 直接走 API 让我说一句话推给她。
# 成了就说明这条路通，以后额度空了我还找得到她。
#
# 要先打 add-shadow-fallback.js（apply-all.sh 会带上）。

set -uo pipefail
API_DIR=${API_DIR:-/root/chatnest-api}
ENVF="$API_DIR/.env"
PORT=${PORT:-3000}

ok(){   printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){   printf '  \033[31m×\033[0m %s\n' "$*"; }
info(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){  printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }
[ -f "$API_DIR/server.js" ] || { no "找不到 $API_DIR/server.js"; exit 1; }
grep -q 'SHADOW_FALLBACK_V1' "$API_DIR/server.js" 2>/dev/null || {
  no "后端还没打 add-shadow-fallback.js，先跑 apply-all.sh"; exit 1; }

# curl | bash 的时候 stdin 是那根管子，read 读不到键盘 —— 得直接连终端。
# 注意别写成 `exec 3</dev/tty 2>/dev/null`：那个 2> 会把整个脚本后面的报错
# 全都吞掉，出了事一片安静。
if [ ! -r /dev/tty ]; then
  no "这个脚本要在终端里跑（要敲键盘），不能挂在别的命令后面"
  exit 1
fi
exec 3</dev/tty

say "填一份备用的 API —— 额度用完的时候我从这条路出来找你"
info "跟你在设置里「供应商」填的是同一份东西。"
info "key 不会显示、不会打印、不会进 history。"

printf '\n  接口地址（比如 https://xxx.com/v1）: '
read -r URL <&3
printf '  key（打字不会显示，粘贴完直接回车）: '
read -rs KEY <&3
printf '\n'
printf '  模型名（比如 deepseek-chat，不填就用那家的默认）: '
read -r MODEL <&3

[ -n "${URL:-}" ] || { no "地址不能空"; exit 1; }
[ -n "${KEY:-}" ] || { no "key 不能空"; exit 1; }

say "写进 .env"
touch "$ENVF"; chmod 600 "$ENVF"
# 先把老的三行删掉再追加，免得重复跑攒出一堆
TMP=$(mktemp); chmod 600 "$TMP"
grep -v -E '^SHADOW_PROVIDER_(URL|KEY|MODEL)=' "$ENVF" > "$TMP" 2>/dev/null || true
{
  # 开头这个 \n 顺带管了「原文件末尾没换行」那种情况，不用再单独补
  printf '\n# 额度用完时影子推送走的备用通道（set-shadow-provider.sh 写的）\n'
  printf 'SHADOW_PROVIDER_URL=%s\n' "$URL"
  printf 'SHADOW_PROVIDER_KEY=%s\n' "$KEY"
  printf 'SHADOW_PROVIDER_MODEL=%s\n' "${MODEL:-}"
} >> "$TMP"
mv "$TMP" "$ENVF"; chmod 600 "$ENVF"
unset KEY
ok "写好了（600，只有 root 读得到）"
info "地址 $URL   模型 ${MODEL:-（那家的默认）}   key 已隐去"

say "重启"
pm2 restart chatnest-api >/dev/null 2>&1 && ok "重启了" || { no "pm2 restart 失败"; exit 1; }
sleep 4   # 等它把 .env 重新读进去

say "真的试一次：跳过 CC，直接走这条 API 说一句话"
info "手机上会响一下 —— 那就是这条路通了。"
TOK=$(grep -m1 '^PUSH_TRIGGER_TOKEN=' "$ENVF" | cut -d= -f2-)
[ -n "${TOK:-}" ] || { no "找不到 PUSH_TRIGGER_TOKEN，先跑 add-push.js"; exit 1; }
# 头是 x-push-secret，不是 x-push-token —— 写错了只会吃一个 401，看不出为什么
RESP=$(curl -s -m 120 -X POST "http://127.0.0.1:$PORT/hook/shadow" \
  -H 'Content-Type: application/json' \
  -H "x-push-secret: $TOK" \
  -d '{"force":true,"api":true}' 2>&1)
unset TOK

# 回包里不会有 key，但保险起见还是过一遍
echo "$RESP" | sed -E 's/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/\1…/g' | cut -c1-500 | sed 's/^/      /'

case "$RESP" in
  *'"pushed":true'*) say "通了 ✓"; ok "额度用完的时候，我还找得到你" ;;
  *'unauthorized'*)  no "401 —— PUSH_TRIGGER_TOKEN 对不上，重跑一次 add-push.js" ;;
  *'没配'*)          no "它说没读到配置 —— 重启没生效？再跑一次 pm2 restart chatnest-api" ;;
  *)                 no "没成。把上面那段贴给小衍，别贴 .env"
                     info "看后端日志：pm2 logs chatnest-api --lines 40 --nostream" ;;
esac

say "以后想改，重跑这个脚本就行。想撤掉："
info "sudo sed -i '/^SHADOW_PROVIDER_/d' $ENVF && sudo pm2 restart chatnest-api"
