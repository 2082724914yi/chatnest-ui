#!/usr/bin/env bash
# 删掉一家备用通道，剩下的往前挪，编号重新连上。
#   curl -fsSL .../deploy/rm-shadow-provider.sh | sudo bash
#
# 为什么不让她自己 sed：
#   · `^SHADOW_PROVIDER_` 不带下划线尾巴的话会把 SHADOW_PROVIDER2_ 一起删掉，
#     而且删完一声不吭 —— 等到需要那条路的时候才发现没了。
#   · 光删不挪的话会留一个空位，以后再加一家、回车填「下一个空位」，
#     新来的那家就插到最前面去了 —— 顺序是优先级，插错位置等于换了偏好。
#
# key 全程不打印。动手前先把 .env 整个备份一份（600）。

set -uo pipefail
API_DIR=${API_DIR:-/root/chatnest-api}
ENVF="$API_DIR/.env"
MAXSLOT=5

ok(){   printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){   printf '  \033[31m×\033[0m %s\n' "$*"; }
info(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){  printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }
[ -f "$ENVF" ] || { no "找不到 $ENVF"; exit 1; }
if [ ! -r /dev/tty ]; then
  no "这个脚本要在终端里跑（要敲键盘），不能挂在别的命令后面"
  exit 1
fi
exec 3</dev/tty

pfx(){ [ "$1" = 1 ] && printf 'SHADOW_PROVIDER' || printf 'SHADOW_PROVIDER%s' "$1"; }
getv(){ grep -m1 "^$(pfx "$1")_$2=" "$ENVF" 2>/dev/null | cut -d= -f2-; }

# 先读出来。有空洞也没关系 —— 读的时候就压紧了，写回去是连号的。
URLS=(); KEYS=(); MODELS=()
for i in $(seq 1 $MAXSLOT); do
  U=$(getv "$i" URL); K=$(getv "$i" KEY); M=$(getv "$i" MODEL)
  [ -n "${U:-}" ] && [ -n "${K:-}" ] || continue
  URLS+=("$U"); KEYS+=("$K"); MODELS+=("${M:-}")
done
N=${#URLS[@]}
[ "$N" -gt 0 ] || { no "一家都没配，没什么好删的"; exit 1; }

say "现在的备用通道"
i=1
while [ "$i" -le "$N" ]; do
  ok "第 $i 家  ${URLS[$((i-1))]}   模型：${MODELS[$((i-1))]:-（那家的默认）}"
  i=$((i+1))
done

say "删哪一家"
info "填上面列表里的序号。直接回车 = 什么都不动。"
printf '\n  序号: '
read -r SEL <&3
[ -n "${SEL:-}" ] || { info "没动。"; exit 0; }
case "$SEL" in *[!0-9]*) no "要填数字"; exit 1 ;; esac
[ "$SEL" -ge 1 ] && [ "$SEL" -le "$N" ] || { no "只能是 1 到 $N"; exit 1; }

GONE_URL=${URLS[$((SEL-1))]}
printf '\n  确定删掉「第 %s 家 %s」吗？打 y 回车: ' "$SEL" "$GONE_URL"
read -r YES <&3
case "${YES:-}" in y|Y|yes|YES) ;; *) info "没动。"; exit 0 ;; esac

say "先备份"
BK="$ENVF.bak.$(date +%Y%m%d%H%M%S)"
cp "$ENVF" "$BK"; chmod 600 "$BK"
ok "备份在 $BK（600）—— 出岔子就 cp 回来"

say "重写"
TMP=$(mktemp); chmod 600 "$TMP"
# 把所有槽的行和那几条注释一起清掉，等下按新顺序重写。
# 用 [0-9]* 覆盖所有编号，尾巴上的下划线不能少 —— 少了会误伤，那正是要躲的坑。
grep -vE '^(SHADOW_PROVIDER[0-9]*_(URL|KEY|MODEL)=|# 备用通道 第)' "$ENVF" > "$TMP" 2>/dev/null || true

j=0; i=1
while [ "$i" -le "$N" ]; do
  if [ "$i" != "$SEL" ]; then
    j=$((j+1)); P=$(pfx "$j")
    {
      printf '\n# 备用通道 第 %s 家\n' "$j"
      printf '%s_URL=%s\n'   "$P" "${URLS[$((i-1))]}"
      printf '%s_KEY=%s\n'   "$P" "${KEYS[$((i-1))]}"
      printf '%s_MODEL=%s\n' "$P" "${MODELS[$((i-1))]}"
    } >> "$TMP"
  fi
  i=$((i+1))
done
mv "$TMP" "$ENVF"; chmod 600 "$ENVF"

say "现在剩下"
if [ "$j" = 0 ]; then
  no "一家都不剩了 —— 额度空的时候我就找不到你了"
  info "想再配： curl -fsSL .../deploy/set-shadow-provider.sh | sudo bash"
else
  i=1
  while [ "$i" -le "$j" ]; do
    ok "第 $i 家  $(getv "$i" URL)   模型：$(getv "$i" MODEL)"
    i=$((i+1))
  done
fi
# 别人的配置有没有被误伤
for k in VAPID_PRIVATE_KEY PUSH_TRIGGER_TOKEN; do
  grep -q "^$k=" "$ENVF" && info "$k 还在" || no "$k 不见了！从 $BK 恢复：cp $BK $ENVF"
done

say "重启"
pm2 restart chatnest-api >/dev/null 2>&1 && ok "重启了" || no "pm2 restart 失败，手动跑一次"
info "验一下还通不通： curl -fsSL .../deploy/diag-shadow-api.sh | sudo bash"
