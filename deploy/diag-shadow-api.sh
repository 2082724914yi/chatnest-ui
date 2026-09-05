#!/usr/bin/env bash
# 影子推送走 API 那条路没出话 —— 查是哪一段断的。只读，不改任何东西。
#   curl -fsSL .../deploy/diag-shadow-api.sh | sudo bash
#
# 三种可能，这个脚本挨个排：
#   1. 那家中转站本身就没通（地址形状不对 / key 不对 / 模型名它不认）
#      —— 直接打它的接口，看返回什么。这一步能把「他们家的问题」跟「我们的问题」分开。
#   2. 通了，但后端拼 URL 的方式跟她填的形状对不上
#      （她填的是 .../v1，后端可能还要再接 /chat/completions，也可能不接）
#   3. 都对，是我们那条 provider 路自己挂了 —— 那就看日志
#
# key 全程不打印，只说「有，多少个字符」。响应体里带 sk- 的一律替换掉。

set -uo pipefail
API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
ENVF="$API_DIR/.env"
PORT=${PORT:-3000}

ok(){   printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){   printf '  \033[31m×\033[0m %s\n' "$*"; }
info(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){  printf '\n\033[1m%s\033[0m\n' "$*"; }
# 任何往外打的东西都过一遍：key 一律遮掉
scrub(){ sed -E 's/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/\1…（已隐去）/g; s/(Bearer +)[A-Za-z0-9._-]+/\1…（已隐去）/g'; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }
[ -f "$SRV" ] || { no "找不到 $SRV"; exit 1; }

say "1/5 .env 里配了几家"
# 第 1 家不带编号，第 2 家往后带 —— 挨个扫，一家一家查
pfx(){ [ "$1" = 1 ] && printf 'SHADOW_PROVIDER' || printf 'SHADOW_PROVIDER%s' "$1"; }
getv(){ grep -m1 "^$(pfx "$1")_$2=" "$ENVF" 2>/dev/null | cut -d= -f2-; }
SLOTS=""
for i in 1 2 3 4 5; do
  U=$(getv "$i" URL); K=$(getv "$i" KEY); M=$(getv "$i" MODEL)
  [ -n "${U:-}" ] && [ -n "${K:-}" ] || continue
  SLOTS="$SLOTS $i"
  ok "第 $i 家  $U   key ${#K} 个字符   模型：${M:-（那家的默认）}"
  case "$K" in *' '*) no "  第 $i 家的 key 里有空格 —— 粘贴时带进来的，重填" ;; esac
  case "$U" in
    *' '*) no "  第 $i 家的地址里有空格" ;;
    http*) ;;
    *)     no "  第 $i 家的地址不是 http 开头" ;;
  esac
done
[ -n "$SLOTS" ] || { no "一家都没配 —— 跑 set-shadow-provider.sh"; exit 1; }

say "2/5 那家中转站自己通不通（绕开我们的后端，直接打）"
try_ep(){ # try_ep <完整端点> <模型名>
  local ep="$1" mdl="${2:-}"
  local body code
  body=$(curl -sS -m 30 -o /tmp/.jsx.$$ -w '%{http_code}' -X POST "$ep" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $KEY" \
    -d "{\"model\":\"$mdl\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"说一个字：好\"}]}" 2>&1) || body=000
  code="$body"
  echo "  ── ${mdl:-（默认模型）}  →  HTTP $code"
  head -c 400 /tmp/.jsx.$$ 2>/dev/null | scrub | sed 's/^/      /'
  rm -f /tmp/.jsx.$$
  [ "$code" = 200 ] && return 0 || return 1
}
ANYGOOD=0
for i in $SLOTS; do
  URL=$(getv "$i" URL); KEY=$(getv "$i" KEY); MODELS=$(getv "$i" MODEL)
  BASE=${URL%/}
  echo
  info "===== 第 $i 家：$BASE ====="
  # 模型可能填了好几个，逗号分开，一个一个试 —— 一家里只要有一个能出话就够了
  OLDIFS=$IFS; IFS=','
  for MODEL in ${MODELS:-""}; do
    IFS=$OLDIFS
    MODEL=$(printf '%s' "$MODEL" | sed 's/^ *//; s/ *$//')
    if try_ep "$BASE/chat/completions" "$MODEL"; then
      ok "第 $i 家 · ${MODEL:-默认模型}  通"
      ANYGOOD=1
    else
      no "第 $i 家 · ${MODEL:-默认模型}  不通（原因看上面那段）"
    fi
    IFS=','
  done
  IFS=$OLDIFS
done
if [ "$ANYGOOD" = 1 ]; then
  ok "至少有一条通的 —— 那额度空了我还找得到她"
else
  no "一条都不通"
  info "401/403 = key 不对；404 = 地址形状不对；400/503 = 那个模型没货或者名字它不认"
  info "模型名要用那家自己的写法，去它后台的模型列表里抄"
fi

say "3/5 后端是怎么拼这个地址的"
info "这决定了 .env 里该填 .../v1 还是完整端点。"
grep -nE "provider\.url|providerUrl|chat/completions" "$SRV" | head -6 | cut -d: -f1 | while read -r n; do
  echo "  ── 第 $n 行 ──"
  sed -n "$((n-2)),$((n+2))p" "$SRV" | cut -c1-170 | scrub | sed 's/^/      /'
done

say "4/5 再触发一次，然后立刻看日志"
TOK=$(grep -m1 '^PUSH_TRIGGER_TOKEN=' "$ENVF" 2>/dev/null | cut -d= -f2-)
if [ -n "${TOK:-}" ]; then
  curl -s -m 120 -X POST "http://127.0.0.1:$PORT/hook/shadow" \
    -H 'Content-Type: application/json' -H "x-push-secret: $TOK" \
    -d '{"force":true,"api":true}' 2>&1 | scrub | cut -c1-300 | sed 's/^/      /'
  unset TOK
  echo
else
  no "找不到 PUSH_TRIGGER_TOKEN，跳过"
fi

say "5/5 后端日志里这几分钟的相关行"
pm2 logs chatnest-api --lines 120 --nostream 2>/dev/null \
  | grep -iE 'shadow|provider|fetch failed|ECONNREFUSED|ENOTFOUND|certificate|401|403|404|429|timeout|error' \
  | tail -25 | scrub | sed 's/^/      /'

say "跑完了。整段贴给我 —— key 全程没打印，返回体里的也遮掉了。"
