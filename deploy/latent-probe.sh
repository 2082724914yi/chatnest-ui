#!/usr/bin/env bash
# Latent 探针 —— 只看不动。
#   curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/claude/baby-activities-today-0k5ueq/deploy/latent-probe.sh | sudo bash
#
# 要回答的就六件事：8765 上跑的是谁、口令在不在、它认得哪些工具、
# 里面到底有没有东西、数据存在哪、从外面进不进得来。
# 一个字都不写、一个服务都不重启。口令不打印，只报有没有、多长。
set -uo pipefail

ENV_FILE=${ENV_FILE:-/root/chatnest-api/.env}
LATENT_URL=${LATENT_URL:-http://127.0.0.1:8765}

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
skip(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑（要读 .env 和 /proc）"; exit 1; }

# 口令可能作为命令行参数传给服务（--token xxx），那么进程命令行里就是明文。
# 凡是要印出来给人看的东西，一律先过这道打码 —— 9.6 就是漏在这儿。
_mask(){ sed -E 's/(--?[Tt][Oo][Kk][Ee][Nn][= ])[^ ]+/\1****（打码）/g; s/(--?[Aa][Pp][Ii][-_]?[Kk][Ee][Yy][= ])[^ ]+/\1****（打码）/g; s/([Ss][Ee][Cc][Rr][Ee][Tt][= ])[^ ]+/\1****（打码）/g; s/([Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd][= ])[^ ]+/\1****（打码）/g'; }

say "1/6 8765 上跑的是谁"
# ss / netstat 不一定装了。没有就别装作「没人听」—— 那是看不见，不是不存在
HAVE_NET=0
command -v ss >/dev/null 2>&1 && HAVE_NET=1
command -v netstat >/dev/null 2>&1 && HAVE_NET=1
LINE=""
[ "$HAVE_NET" = 1 ] && LINE=$( (ss -lptnH 2>/dev/null || netstat -lptn 2>/dev/null) | grep -E '[:.]8765[[:space:]]' | head -1)
# 不管看不看得见端口表，都直接敲一下门：活着才是活着
ALIVE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$LATENT_URL/" -X POST -H 'Content-Type: application/json' -d '{}' 2>/dev/null || echo 000)
if [ -z "${LINE:-}" ]; then
  if [ "$HAVE_NET" = 0 ]; then
    skip "这台机器没有 ss / netstat，看不到端口表"
  fi
  if [ "$ALIVE" = "000" ]; then
    no "敲 $LATENT_URL 没人应（HTTP $ALIVE）—— Latent 服务多半没在跑"
  else
    ok "敲 $LATENT_URL 有人应（HTTP $ALIVE）—— 服务活着"
  fi
  # 端口表看不见就靠进程名找。注意这个脚本自己命令行里也带 latent，
  # 不排掉的话会自己找到自己，然后把 bash 当成 Latent 服务报给她
  PID=""
  for p in $(pgrep -f 'latent' 2>/dev/null); do
    [ "$p" = "$$" ] && continue
    [ "$p" = "${PPID:-0}" ] && continue
    [ -d "/proc/$p" ] || continue
    # 用 cat 不用重定向：进程刚好在这一刻退出的话，重定向失败是 shell 自己报错，2>/dev/null 拦不住
    cl=$(cat "/proc/$p/cmdline" 2>/dev/null | tr '\0' ' ')
    case "$cl" in *probe*|*curl*|*pgrep*) continue;; esac
    PID=$p; break
  done
  [ -n "${PID:-}" ] && skip "按进程名找到 pid $PID" || skip "按进程名也没找到（可能它命令行里不带 latent 这个词）"
else
  echo "  $LINE"
  PID=$(printf '%s' "$LINE" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  [ -z "${PID:-}" ] && PID=$(printf '%s' "$LINE" | grep -oE '[0-9]+/' | head -1 | tr -d '/')
  # 只听 127.0.0.1 还是 0.0.0.0 —— 这就是「外面进不进得来」的第一层答案
  if printf '%s' "$LINE" | grep -qE '(0\.0\.0\.0|\*|\[::\]):8765'; then
    ok "监听在所有网卡上（外面理论上够得着，看防火墙）"
  else
    skip "只听 127.0.0.1 —— 外面直接连不上，这就是 CC 那边够不着的原因"
  fi
fi
[ -n "${PID:-}" ] && [ ! -d "/proc/$PID" ] && PID=""   # 刚才那个已经退了，别拿它当服务
if [ -n "${PID:-}" ]; then
  ok "pid $PID"
  echo "  程序: $(readlink -f /proc/$PID/exe 2>/dev/null || echo 未知)"
  echo "  目录: $(readlink -f /proc/$PID/cwd 2>/dev/null || echo 未知)"
  echo "  命令: $(cat "/proc/$PID/cmdline" 2>/dev/null | tr '\0' ' ' | cut -c1-300 | _mask)"
fi

say "2/6 口令在不在"
TOKEN=""
if [ -f "$ENV_FILE" ]; then
  TOKEN=$(grep -E '^LATENT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')
  if [ -n "$TOKEN" ]; then ok "LATENT_TOKEN 有，长度 ${#TOKEN}（不打印内容）"
  else no "$ENV_FILE 里没有 LATENT_TOKEN —— 后端连 Latent 时会直接跳过"; fi
else
  no "找不到 $ENV_FILE"
fi

_call(){ # $1=method $2=params-json
  curl -fsS -m 25 "$LATENT_URL/" \
    -H 'Content-Type: application/json' \
    ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" 2>&1
}

say "3/6 它认得哪些工具"
TOOLS=$(_call "tools/list" "{}")
# 上一版这儿会在解析不出来的时候静默吞掉，然后还嘴硬说「工具清单如上」。
# 现在：解析出几个就报几个，一个都解析不出来就把它到底回了什么摆出来。
LISTED=0
if command -v python3 >/dev/null 2>&1; then
  OUT=$(printf '%s' "$TOOLS" | python3 -c '
import sys,json
try: j=json.load(sys.stdin)
except Exception: raise SystemExit(1)
ts=((j.get("result") or {}).get("tools")) or j.get("tools") or []
if not isinstance(ts,list) or not ts: raise SystemExit(1)
for t in ts:
    if not isinstance(t,dict): continue
    d=" ".join((t.get("description") or "").split())[:70]
    print("  · %s%s"%(t.get("name","?")," — "+d if d else ""))
' 2>/dev/null) && [ -n "$OUT" ] && { printf '%s\n' "$OUT"; LISTED=$(printf '%s\n' "$OUT" | wc -l); }
fi
if [ "$LISTED" = 0 ]; then
  OUT=$(printf '%s' "$TOOLS" | grep -oE '"name": *"[^"]+"' | sed 's/"name": *"/  · /; s/"$//')
  [ -n "$OUT" ] && { printf '%s\n' "$OUT"; LISTED=$(printf '%s\n' "$OUT" | wc -l); }
fi
if [ "$LISTED" != 0 ]; then
  ok "一共 $LISTED 个工具"
else
  no "问不到工具清单。它回的是（前 400 字）："
  printf '%s' "$TOOLS" | head -c 400 | _mask | sed 's/^/      /'
  echo
fi

say "4/6 里面到底有没有东西"
# 返回里的中文是 \uXXXX 转义的，直接印出来是一串鬼画符 —— 有 python3 就解开
_text(){
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$1" | python3 -c '
import sys,json
try:
    j=json.load(sys.stdin)
except Exception:
    print(sys.stdin.read()[:220]); raise SystemExit
r=j.get("result") or {}
t="".join(b.get("text","") for b in (r.get("content") or []) if isinstance(b,dict))
print(" ".join((t or json.dumps(r,ensure_ascii=False)).split())[:220])
' 2>/dev/null
  else
    printf '%s' "$1" | tr -d '\n' | cut -c1-220
  fi
}
for q in 晚霞 小懿 换窗; do
  R=$(_call "tools/call" "{\"name\":\"latent_search\",\"arguments\":{\"query\":\"$q\"}}")
  N=$(printf '%s' "$R" | wc -c)
  if printf '%s' "$R" | grep -q '"error"'; then
    no "搜「$q」报错：$(printf '%s' "$R" | grep -oE '"message":"[^"]*"' | head -1)"
  elif [ "$N" -lt 120 ]; then
    skip "搜「$q」→ 基本空的（$N 字节）"
  else
    ok "搜「$q」→ 有内容（$N 字节），开头是："
    _text "$R" | sed 's/^/      /'
  fi
done

say "5/6 数据存在哪"
if [ -n "${PID:-}" ]; then
  # 它自己打开着的文件最诚实
  ls -l /proc/$PID/fd 2>/dev/null | grep -oE '/[^ ]+\.(db|sqlite3?|json|jsonl|index|faiss|npy)$' | sort -u | while read -r f; do
    [ -f "$f" ] && echo "  $(du -h "$f" 2>/dev/null | cut -f1)	$f"
  done
  CWD=$(readlink -f /proc/$PID/cwd 2>/dev/null)
  if [ -n "${CWD:-}" ] && [ -d "$CWD" ]; then
    echo "  工作目录 $CWD 下的数据："
    find "$CWD" -maxdepth 3 \( -name '*.db' -o -name '*.sqlite*' -o -name '*.jsonl' -o -name '*.faiss' -o -name '*.npy' \) \
      -size +1k 2>/dev/null | head -10 | while read -r f; do echo "    $(du -h "$f" | cut -f1)	$f"; done
  fi
else
  skip "没定位到它的进程号，没法从进程反查数据文件（服务活着也可能这样）"
fi

say "6/6 从外面进得来吗"
NGX=$(nginx -T 2>/dev/null | grep -n "8765" | head -5)
if [ -n "${NGX:-}" ]; then
  ok "nginx 里已经有指向 8765 的反代："
  printf '%s\n' "$NGX" | sed 's/^/      /'
else
  skip "nginx 里没有任何指向 8765 的反代 —— 也就是说现在没有对外的门"
fi
# 不要 -f：404 也是答案，-f 会让 curl 报错然后被 || 再补一个 000，拼成「404000」
PUB=$(curl -s -m 10 -o /dev/null -w '%{http_code}' https://api.xiaoyixiaoyan.top/latent/ 2>/dev/null)
[ -z "${PUB:-}" ] && PUB=000
echo "  试了一下 https://api.xiaoyixiaoyan.top/latent/ → HTTP $PUB"

printf '\n\033[1m看完了，什么都没动。把这段发给我。\033[0m\n'
echo "  我要的就是：3 的工具清单、4 有没有内容、5 数据多大、6 有没有门。"
echo
