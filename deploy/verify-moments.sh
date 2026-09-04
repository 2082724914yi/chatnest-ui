#!/usr/bin/env bash
# 朋友圈接口返回 401 —— 确认这是「没带登录凭证」的正常拦截，还是真的坏了。
#   curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/verify-moments.sh | sudo bash
#
# 注意：本脚本不会把 token 打印出来，只报状态码。
set -uo pipefail

API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
TOKENS="$API_DIR/auth-tokens.json"
PORT=${PORT:-3000}

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ -f "$SRV" ] || { no "找不到 $SRV"; exit 1; }

say "1 拦住它的是哪段代码"
HIT=$(grep -n "unauthorized" "$SRV" | head -3)
if [ -n "${HIT:-}" ]; then
  printf '%s\n' "$HIT" | sed 's/^/  /'
  LN=$(printf '%s' "$HIT" | head -1 | cut -d: -f1)
  echo "  ── 上下 12 行 ──"
  sed -n "$((LN>12?LN-12:1)),$((LN+6))p" "$SRV" | sed 's/^/    /'
else
  no "server.js 里没有 unauthorized 字样，那 401 可能来自 nginx 或别的前置"
fi

say "2 它是 app.use 全局中间件吗，注册在第几行"
grep -n "^app.use(" "$SRV" | tail -8 | sed 's/^/  /'
LN_M=$(grep -n "app.get('/api/moments'" "$SRV" | head -1 | cut -d: -f1)
echo "  朋友圈路由在: ${LN_M:-?}"

say "3 带上真正的登录凭证再试一次"
TOK=""
if [ -f "$TOKENS" ]; then
  # 只取值，不回显；文件结构未知，兼容数组/对象/裸串
  TOK=$(python3 - "$TOKENS" <<'PY' 2>/dev/null
import json,sys
def walk(x):
    if isinstance(x,str): return [x]
    if isinstance(x,list):
        out=[]
        for i in x: out+=walk(i)
        return out
    if isinstance(x,dict):
        out=[]
        for k,v in x.items():
            if k in ('token','value','key','access_token'): out+=walk(v)
            else: out+=walk(v)
        return out
    return []
try:
    d=json.load(open(sys.argv[1]))
    c=[s for s in walk(d) if 8<=len(s)<=200]
    print(c[0] if c else '')
except Exception:
    print('')
PY
)
  [ -n "$TOK" ] && ok "从 auth-tokens.json 取到一个凭证（不显示内容）" || no "auth-tokens.json 里没找到可用凭证"
else
  no "$TOKENS 不存在"
fi

# 兜底：仓库里那版 /api/auth 发的是固定串
[ -z "$TOK" ] && TOK=chatnest-token && echo "  改用默认凭证试试"

for label in "不带凭证" "带凭证"; do
  : > /tmp/.vm   # curl 连不上时不会建文件，先占住免得 head 报错
  if [ "$label" = "不带凭证" ]; then
    CODE=$(curl -s -o /tmp/.vm -w '%{http_code}' -m 8 "http://127.0.0.1:$PORT/api/moments" 2>/dev/null)
  else
    CODE=$(curl -s -o /tmp/.vm -w '%{http_code}' -m 8 -H "Authorization: Bearer $TOK" "http://127.0.0.1:$PORT/api/moments" 2>/dev/null)
  fi
  printf '  %-10s HTTP \033[1m%s\033[0m   %s\n' "$label" "$CODE" "$(head -c 90 /tmp/.vm)"
done
rm -f /tmp/.vm

say "结论"
: > /tmp/.vm2
CODE_T=$(curl -s -o /tmp/.vm2 -w '%{http_code}' -m 8 -H "Authorization: Bearer $TOK" "http://127.0.0.1:$PORT/api/moments" 2>/dev/null)
if [ "$CODE_T" = 200 ]; then
  ok "带凭证就通 —— 说明后端是好的，401 只是 curl 没登录"
  echo "     手机上把页面彻底关掉再开，就能发朋友圈了。"
elif [ "$CODE_T" = 401 ]; then
  no "带凭证还是 401 —— 朋友圈路由被注册在认证中间件后面了，要挪位置"
  echo "     把第 1、2 节整个发回来。"
else
  no "带凭证返回 $CODE_T：$(head -c 120 /tmp/.vm2)"
  echo "     把第 1、2 节整个发回来。"
fi
rm -f /tmp/.vm2
echo
