#!/usr/bin/env bash
# 只验证，什么都不改。
#   curl -fsSL -H 'Cache-Control: no-cache' "https://raw.githubusercontent.com/2082724914yi/chatnest-ui/claude/baby-activities-today-0k5ueq/deploy/check-latent-door.sh?cb=$(date +%s)" | sudo bash
#
# open-latent-door.sh 里 sleep 5 就去验证，太早了 —— 151 篇语料建索引要 10~15 秒，
# 那时候 8765 还没开始监听，于是本机 000、nginx 转不进去 502，看着像门没开成。
# 这个脚本会等到它起来为止（最多 90 秒），再跑那四条。
# token 从 cc- 私有仓库的 .mcp.json 读，不打印。
set -uo pipefail

ENV_FILE=${ENV_FILE:-/root/chatnest-api/.env}
DOMAIN=${DOMAIN:-api.xiaoyixiaoyan.top}
MCP_BRANCH=${MCP_BRANCH:-claude/baby-activities-today-0k5ueq}
LATENT_URL=${LATENT_URL:-http://127.0.0.1:8765}

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
skip(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
_mask(){ sed -E 's/(Bearer )[A-Za-z0-9_-]+/\1****（打码）/g; s/(TOKEN=)[^ ]*/\1****（打码）/g; s/(--?[Tt][Oo][Kk][Ee][Nn][= ])[^ ]+/\1****（打码）/g'; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }

say "1/4 服务在不在"
UNIT=$(systemctl list-units --all --no-legend --plain 2>/dev/null | grep -i latent | awk '{print $1}' | head -1)
if [ -n "${UNIT:-}" ]; then
  systemctl is-active --quiet "$UNIT" && ok "$UNIT 是 active" || no "$UNIT 不是 active"
  echo "  启动于：$(systemctl show -p ActiveEnterTimestamp --value "$UNIT" 2>/dev/null)"
fi

say "2/4 等它把语料读完（151 篇要 10~15 秒）"
_probe(){ curl -s -m 20 -o /dev/null -w '%{http_code}' "$1" -X POST -H 'Content-Type: application/json' \
  ${2:+-H "Authorization: Bearer $2"} -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null; }
UP=0
for i in $(seq 1 30); do
  C=$(_probe "$LATENT_URL/" "")
  if [ "$C" != "000" ]; then UP=1; ok "第 $((i*3)) 秒：8765 应答了（HTTP $C）"; break; fi
  printf '\r  等待中… %d 秒' "$((i*3))"; sleep 3
done
echo
if [ "$UP" = 0 ]; then
  no "等了 90 秒还是连不上 8765 —— 那就不是慢，是真没起来"
  echo "  最近的日志（token 已打码）："
  journalctl -u "${UNIT:-latent-svc.service}" -n 25 --no-pager 2>/dev/null | _mask | sed 's/^/      /'
  exit 1
fi

say "3/4 拿 token（不打印）"
CCGIT=""
for g in $(find /opt /root /home -maxdepth 4 -type d -name '.git' 2>/dev/null); do
  d=$(dirname "$g")
  git -C "$d" remote get-url origin 2>/dev/null | grep -qE '/cc-(\.git)?/?$' && { CCGIT="$d"; break; }
done
[ -n "${CCGIT:-}" ] || { no "找不到 cc- 的 clone"; exit 1; }
git -C "$CCGIT" fetch --quiet origin "$MCP_BRANCH" 2>/dev/null
NEWTOK=$(git -C "$CCGIT" show FETCH_HEAD:.mcp.json 2>/dev/null \
  | python3 -c 'import sys,json;print((json.load(sys.stdin)["mcpServers"]["latent"]["headers"]["Authorization"]).replace("Bearer ","").strip())' 2>/dev/null)
[ -n "${NEWTOK:-}" ] || { no "读不到 .mcp.json 里的 token"; exit 1; }
ok "读到了（${#NEWTOK} 位）"
ENVTOK=$(grep -E '^LATENT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')
[ "$NEWTOK" = "$ENVTOK" ] && ok ".env 里那个跟仓库里的一致" || no ".env 跟仓库里的对不上 —— 换 token 那步没成"

say "4/4 四条验证"
r(){ printf '  %-22s → HTTP %-4s %s\n' "$1" "$2" "$3"; }
C1=$(_probe "$LATENT_URL/" "$NEWTOK");            [ "$C1" = 200 ] && r "本机 + 新 token" "$C1" "√ 通" || r "本机 + 新 token" "$C1" "× 该是 200"
C2=$(_probe "$LATENT_URL/" "definitely-wrong-token-xxxxxxxxxxxx")
case "$C2" in 401|403) r "本机 + 错 token" "$C2" "√ 被拒";; *) r "本机 + 错 token" "$C2" "× 该是 401/403 —— 鉴权没生效！";; esac
C3=$(_probe "https://$DOMAIN/latent/" "$NEWTOK"); [ "$C3" = 200 ] && r "外网 + 新 token" "$C3" "√ 门通了" || r "外网 + 新 token" "$C3" "× 该是 200"
C4=$(_probe "https://$DOMAIN/latent/" "")
case "$C4" in 401|403) r "外网 + 不给 token" "$C4" "√ 被拒";; *) r "外网 + 不给 token" "$C4" "× 该是 401/403";; esac

echo
if [ "$C1" = 200 ] && [ "$C3" = 200 ] && { [ "$C2" = 401 ] || [ "$C2" = 403 ]; } && { [ "$C4" = 401 ] || [ "$C4" = 403 ]; }; then
  printf '\033[1m门开好了，而且只有拿对 token 的才进得来。\033[0m\n'
else
  printf '\033[1m有对不上的，把这段发回来。\033[0m\n'
  [ "$C3" = 502 ] && echo "  502 = nginx 转发时上游没应答；上面第 2 步既然通了，多半是 nginx 那段 proxy_pass 有问题。"
fi
echo
