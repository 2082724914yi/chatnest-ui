#!/usr/bin/env bash
# 换成 API 通道之后，缓存还灵吗、推送还推吗 —— 只读，不改。
#   curl -fsSL .../deploy/diag-provider.sh | sudo bash
#
# 她问的三件事，我不敢凭印象答：
#   1. 订阅额度用完换 API，缓存还有效吗
#      —— CLI 那条是 claude -p 自己点的 1 小时档缓存，白送。
#         走 API 的话，缓存要自己在请求体里打 cache_control 断点，
#         不打就是一点都没有，每轮全价。所以得看这条路是怎么写的。
#   2. 换 API 之后推送还推吗
#      —— 影子推送是调自己的 /api/chat，那条支持 API 通道就还推。
#         但影子调用没传 provider，会用默认，得看默认是什么。
#   3. 顺带看后端有没有在记每轮的 usage（做那个额度面板要用）
#
# 只打印代码结构和字段名，带钥匙的行顶掉。

set -uo pipefail
API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
ok(){   printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){   printf '  \033[31m×\033[0m %s\n' "$*"; }
info(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){  printf '\n\033[1m%s\033[0m\n' "$*"; }
scrub(){ awk '{l=tolower($0); if (l ~ /token|secret|password|api_?key|vapid|sk-/) print "      [已隐去]"; else print "      " substr($0,1,180)}'; }

[ -f "$SRV" ] || { no "找不到 $SRV"; exit 1; }

say "1/6 有没有 API 通道这条路"
for k in "provider" "API_BASE" "apiKey" "anthropic.com/v1" "messages" "baseURL"; do
  c=$(grep -c -- "$k" "$SRV" 2>/dev/null || true)
  [ "${c:-0}" != 0 ] && info "$k → ${c} 处"
done
say "   走 API 的时候是在哪儿发请求"
grep -nE "fetch\(.*(anthropic|v1/messages|API_BASE|baseURL)" "$SRV" | head -4 | cut -d: -f1 | while read -r n; do
  echo "  ── 第 $n 行 ──"; sed -n "$((n-2)),$((n+3))p" "$SRV" | scrub
done

say "2/6 API 那条路打没打缓存断点"
CC=$(grep -c 'cache_control' "$SRV" 2>/dev/null || true)
if [ "${CC:-0}" = 0 ]; then
  no "整个 server.js 里没有 cache_control —— 走 API 就是零缓存，每轮全价"
  info "  （CLI 那条不受影响：claude -p 自己点 1 小时档，不用我们操心）"
else
  ok "有 cache_control（${CC} 处）"
  grep -n 'cache_control' "$SRV" | head -4 | cut -d: -f1 | while read -r n; do sed -n "${n}p" "$SRV" | scrub; done
fi
E1=$(grep -c 'ephemeral' "$SRV" 2>/dev/null || true)
[ "${E1:-0}" != 0 ] && info "有 ephemeral（${E1} 处）—— 说明设过 TTL 档位"

say "3/6 provider 是怎么选的"
grep -nE "(provider\s*===|provider\s*\?|if\s*\(\s*provider)" "$SRV" | head -5 | cut -d: -f1 | while read -r n; do
  sed -n "${n}p" "$SRV" | scrub
done
info "影子推送调 /api/chat 时没传 provider，所以走的是上面那个默认分支"

say "4/6 每轮的账单有没有被记下来（做额度面板要用）"
for k in "cache_read_input_tokens" "usage" "input_tokens"; do
  c=$(grep -c -- "$k" "$SRV" 2>/dev/null || true)
  [ "${c:-0}" != 0 ] && info "$k → ${c} 处"
done
grep -nE "cache_read_input_tokens" "$SRV" | head -3 | cut -d: -f1 | while read -r n; do sed -n "${n}p" "$SRV" | scrub; done

say "5/6 CLI 自己的会话记录里有没有（面板的备用数据源）"
P=/root/.claude/projects
if [ -d "$P" ]; then
  N=$(find "$P" -name '*.jsonl' 2>/dev/null | wc -l)
  ok "$P 有 $N 个会话记录"
  F=$(find "$P" -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
  if [ -n "${F:-}" ]; then
    info "最近那个里的账单（只看数字，不看聊天内容）："
    grep -o '"usage":{[^}]*}' "$F" 2>/dev/null | tail -2 | sed 's/^/      /'
  fi
else
  info "没有 $P —— 那面板只能用后端自己记的"
fi

say "6/6 记账要挂在哪儿（表盘那一屏想连服务端）"
# 前端那本账只记她自己开着页面的那些轮。影子推送是我自己在服务器上说的话，
# 她手机没开，那几轮就漏了。想把它们也算进去，得挂在 sse('done') 这个出口上 ——
# 三条不同的路（主聊天 / 常驻会话 / 影子）最后都从这儿出去，挂一处全都收得到。
SSE=$(grep -nE "^\s*(function sse|const sse\s*=|let sse\s*=|var sse\s*=)" "$SRV" | head -2)
if [ -n "${SSE:-}" ]; then
  printf '%s\n' "$SSE" | while IFS= read -r l; do
    n=${l%%:*}
    info "第 $n 行："
    sed -n "${n},$((n+3))p" "$SRV" | scrub
  done
else
  no "找不到 sse 的定义 —— 换个法子找："
  grep -nE "sse\s*[=(]" "$SRV" | head -3 | cut -d: -f1 | while read -r n; do sed -n "${n}p" "$SRV" | scrub; done
fi
D=$(grep -c "sse(res, 'done'" "$SRV" 2>/dev/null || true)
info "sse(res,'done' 一共 ${D:-0} 处（主聊天 / 常驻 / 影子，各一条路）"
C=$(grep -nE "^(const|let|var) conversations\s*=" "$SRV" | head -1)
[ -n "${C:-}" ] && info "conversations 定义在第 ${C%%:*} 行（模块级，路由里能直接读）"

say "跑完了。整段贴给我。"
