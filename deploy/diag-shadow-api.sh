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

say "1/5 .env 里配的是什么"
URL=$(grep -m1 '^SHADOW_PROVIDER_URL='   "$ENVF" 2>/dev/null | cut -d= -f2-)
KEY=$(grep -m1 '^SHADOW_PROVIDER_KEY='   "$ENVF" 2>/dev/null | cut -d= -f2-)
MODEL=$(grep -m1 '^SHADOW_PROVIDER_MODEL=' "$ENVF" 2>/dev/null | cut -d= -f2-)
[ -n "${URL:-}" ]   && ok "地址 $URL"                     || { no "没有 SHADOW_PROVIDER_URL"; exit 1; }
[ -n "${KEY:-}" ]   && ok "key 有，${#KEY} 个字符"        || { no "没有 SHADOW_PROVIDER_KEY"; exit 1; }
[ -n "${MODEL:-}" ] && ok "模型 $MODEL"                   || info "模型没填（用那家的默认）"
case "$KEY" in
  *' '*) no "key 里有空格 —— 多半是粘贴的时候带进来的，重跑 set-shadow-provider.sh" ;;
esac
case "$URL" in
  *' '*)  no "地址里有空格" ;;
  http*)  ;;
  *)      no "地址不是 http 开头" ;;
esac

say "2/5 那家中转站自己通不通（绕开我们的后端，直接打）"
try_ep(){ # try_ep <完整端点>
  local ep="$1"
  local body code
  body=$(curl -sS -m 30 -o /tmp/.jsx.$$ -w '%{http_code}' -X POST "$ep" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $KEY" \
    -d "{\"model\":\"${MODEL:-claude-sonnet-4-6}\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"说一个字：好\"}]}" 2>&1) || body=000
  code="$body"
  echo "  ── $ep  →  HTTP $code"
  head -c 400 /tmp/.jsx.$$ 2>/dev/null | scrub | sed 's/^/      /'
  echo
  rm -f /tmp/.jsx.$$
  [ "$code" = 200 ] && return 0 || return 1
}
BASE=${URL%/}
GOOD=""
if try_ep "$BASE/chat/completions"; then GOOD="$BASE/chat/completions"; fi
if [ -z "$GOOD" ] && [ "${BASE%/v1}" = "$BASE" ]; then
  # 她填的可能少了 /v1
  try_ep "$BASE/v1/chat/completions" && GOOD="$BASE/v1/chat/completions"
fi
if [ -z "$GOOD" ]; then
  try_ep "$BASE" && GOOD="$BASE"
fi
if [ -n "$GOOD" ]; then
  ok "这家通的，能出话的端点是：$GOOD"
  info "如果它跟 .env 里那条对不上，就是形状填错了（下一段看后端怎么拼）"
else
  no "这家怎么打都不出话 —— 上面几个 HTTP 码和返回体就是原因"
  info "401/403 = key 不对；404 = 地址形状不对；400 = 多半是模型名它不认"
  info "模型名要用那家自己的写法，不一定跟官方一样，去它后台的模型列表里抄"
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
