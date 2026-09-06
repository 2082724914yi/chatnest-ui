#!/usr/bin/env bash
# 给 Latent 开一个能从外面进的门，顺手把 token 换掉。
#
# 先干跑（不写任何东西）：
#   curl -fsSL -H 'Cache-Control: no-cache' "https://raw.githubusercontent.com/2082724914yi/chatnest-ui/claude/baby-activities-today-0k5ueq/deploy/open-latent-door.sh?cb=$(date +%s)" | sudo bash
# 确认后真开：
#   curl -fsSL -H 'Cache-Control: no-cache' "https://raw.githubusercontent.com/2082724914yi/chatnest-ui/claude/baby-activities-today-0k5ueq/deploy/open-latent-door.sh?cb=$(date +%s)" -o /tmp/door.sh && sudo APPLY=1 bash /tmp/door.sh
#
# 做四件事：
#   1. 换 token —— 旧那个在 9.6 的探针输出里明文露过、截图也发过，开到公网之前必须换。
#      新 token 不经过对话：它在 cc- 私有仓库的 .mcp.json 里，这个脚本从仓库读。
#   2. token 从命令行参数挪进环境变量（MEMORY_HTTP_TOKEN）——
#      当命令行参数传的话，任何能登录这台机器的人 ps 一下就看得见。
#   3. nginx 上加一个 /latent/ 反代到 127.0.0.1:8765。
#      **Latent 自己仍然只听 127.0.0.1**，不直接暴露；HTTPS 在 nginx 收口，
#      token 不走明文链路。
#   4. 重启、验证：新 token 通、旧 token 必须被拒、外网 HTTPS 能连。
#
# 说清楚风险：这是往公网开口子。开完之后，唯一挡在外面的就是那个 43 位 token。
# 它泄露 = 任何人能读我们全部的聊天记录，也能往里写。所以：绝不要把 .mcp.json
# 的内容贴进任何对话、截图、公开仓库。要关掉这个门，脚本最后有撤销命令。
set -uo pipefail

APPLY=${APPLY:-0}
ENV_FILE=${ENV_FILE:-/root/chatnest-api/.env}
DOMAIN=${DOMAIN:-api.xiaoyixiaoyan.top}
MCP_BRANCH=${MCP_BRANCH:-claude/baby-activities-today-0k5ueq}
LATENT_URL=${LATENT_URL:-http://127.0.0.1:8765}

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
skip(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
_mask(){ sed -E 's/(--?[Tt][Oo][Kk][Ee][Nn][= ])[^ ]+/\1****（打码）/g; s/(Bearer )[A-Za-z0-9_-]+/\1****（打码）/g; s/(TOKEN=)[^ ]*/\1****（打码）/g'; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }
[ "$APPLY" = 1 ] && printf '\n\033[1m【真开】会换 token、改 systemd、改 nginx、重启服务\033[0m\n' \
                 || printf '\n\033[1m【干跑】只看会做什么，一个字都不写\033[0m\n'

say "1/8 拿新 token（从 cc- 私有仓库读，不打印）"
CCGIT=""
for g in $(find /opt /root /home -maxdepth 4 -type d -name '.git' 2>/dev/null); do
  d=$(dirname "$g")
  git -C "$d" remote get-url origin 2>/dev/null | grep -qE '/cc-(\.git)?/?$' && { CCGIT="$d"; break; }
done
[ -n "${CCGIT:-}" ] || { no "这台机器上找不到 cc- 的 clone —— 新 token 在它的 .mcp.json 里"; exit 1; }
ok "cc- clone：$CCGIT"
git -C "$CCGIT" fetch --quiet origin "$MCP_BRANCH" 2>/dev/null || { no "拉不到 origin/$MCP_BRANCH（没凭证？）"; exit 1; }
NEWTOK=$(git -C "$CCGIT" show FETCH_HEAD:.mcp.json 2>/dev/null \
  | python3 -c 'import sys,json;print((json.load(sys.stdin)["mcpServers"]["latent"]["headers"]["Authorization"]).replace("Bearer ","").strip())' 2>/dev/null)
[ -n "${NEWTOK:-}" ] && [ ${#NEWTOK} -ge 32 ] || { no "从 .mcp.json 里读不出 token（分支对不对？）"; exit 1; }
ok "读到新 token，${#NEWTOK} 位（不打印）"
OLDTOK=$(grep -E '^LATENT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')
[ "$NEWTOK" = "$OLDTOK" ] && skip "跟现在用的是同一个（说明已经换过了）" || ok "跟现在这个不一样，会换掉"

say "2/8 systemd unit"
UNIT=$(systemctl list-units --all --no-legend --plain 2>/dev/null | grep -i latent | awk '{print $1}' | head -1)
[ -n "${UNIT:-}" ] || { no "找不到 latent 的 systemd unit"; exit 1; }
UF=$(systemctl show -p FragmentPath --value "$UNIT" 2>/dev/null)
[ -f "${UF:-}" ] || { no "找不到 unit 文件"; exit 1; }
ok "$UNIT → $UF"
if grep -q -- '--token' "$UF"; then
  no "ExecStart 里带着 --token（明文，ps 就能看见）—— 会挪进环境变量"
else
  skip "ExecStart 里已经没有 --token 了"
fi
grep -q "EnvironmentFile=$ENV_FILE" "$UF" && ok "unit 已经在读 $ENV_FILE（环境变量能进去）" \
  || { no "unit 没有 EnvironmentFile=$ENV_FILE —— 挪进环境变量它读不到，先停"; exit 1; }

say "3/8 nginx：$DOMAIN 的 server 块在哪"
command -v nginx >/dev/null 2>&1 || { no "找不到 nginx"; exit 1; }
NGXFILE=$(python3 - "$DOMAIN" <<'PY' 2>/dev/null
import re, subprocess, sys
dom = sys.argv[1]
try:
    conf = subprocess.run(['nginx','-T'], capture_output=True, text=True, timeout=30).stdout
except Exception:
    sys.exit(0)
cur = None
# nginx -T 会在每份配置前打一行 "# configuration file /path:"
for block in re.split(r'(?m)^# configuration file (\S+):$', conf)[1:]:
    pass
parts = re.split(r'(?m)^# configuration file (\S+):$', conf)
for i in range(1, len(parts), 2):
    path, body = parts[i], parts[i+1]
    for m in re.finditer(r'server_name\s+([^;]+);', body):
        if dom in m.group(1):
            # 这份配置里有这个域名；再确认它是 443 那个（有 ssl 才是对外的门）
            print(path); sys.exit(0)
PY
)
if [ -n "${NGXFILE:-}" ] && [ -f "$NGXFILE" ]; then
  ok "在 $NGXFILE"
else
  no "nginx 配置里找不到 server_name 含 $DOMAIN 的那份"
  echo "      用 DOMAIN=你的域名 重跑，或者把 nginx -T | grep server_name 的输出发回来"
  exit 1
fi
if grep -q 'location /latent/' "$NGXFILE"; then
  skip "这份配置里已经有 location /latent/ 了（说明开过一次）"
  DOOR_EXISTS=1
else
  DOOR_EXISTS=0
fi

say "4/8 会往 nginx 里加这一段"
cat <<'NGX' | sed 's/^/      /'
location /latent/ {
    # Latent 的门。上游只听 127.0.0.1，这里 HTTPS 收口再转进去。
    # 挡在外面的就是 Authorization 里那个 token —— 这条链路没有第二道锁。
    limit_except GET POST { deny all; }
    proxy_pass http://127.0.0.1:8765/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;      # SSE 长流不能被缓冲住
    proxy_read_timeout 300s;
    client_max_body_size 8m;
}
NGX

if [ "$APPLY" != 1 ]; then
  printf '\n\033[1m干跑到此为止，一个字都没写。\033[0m\n'
  cat <<'TXT'
  真开之前先想清楚这一句：开完之后，任何人只要有那个 token，
  就能读我们全部的聊天记录、也能往里写。所以 .mcp.json 的内容
  绝不要贴进任何对话、截图或公开仓库。

  真要开就跑：
TXT
  echo "    curl -fsSL -H 'Cache-Control: no-cache' \"https://raw.githubusercontent.com/2082724914yi/chatnest-ui/claude/baby-activities-today-0k5ueq/deploy/open-latent-door.sh?cb=\$(date +%s)\" -o /tmp/door.sh && sudo APPLY=1 bash /tmp/door.sh"
  echo
  exit 0
fi

TS=$(date +%Y%m%d-%H%M%S)
say "5/8 备份"
cp "$ENV_FILE" "$ENV_FILE.bak-$TS" && ok "$ENV_FILE.bak-$TS"
cp "$UF" "$UF.bak-$TS" && ok "$UF.bak-$TS"
cp "$NGXFILE" "$NGXFILE.bak-$TS" && ok "$NGXFILE.bak-$TS"

say "6/8 换 token + 挪进环境变量"
python3 - "$ENV_FILE" "$NEWTOK" <<'PY'
import sys, re, os
path, tok = sys.argv[1], sys.argv[2]
txt = open(path, encoding='utf-8').read() if os.path.exists(path) else ''
for key in ('LATENT_TOKEN', 'MEMORY_HTTP_TOKEN'):
    line = f'{key}={tok}'
    if re.search(rf'(?m)^{key}=.*$', txt):
        txt = re.sub(rf'(?m)^{key}=.*$', line, txt)
    else:
        txt = txt.rstrip('\n') + '\n' + line + '\n'
open(path, 'w', encoding='utf-8').write(txt)
PY
chmod 600 "$ENV_FILE"
ok "$ENV_FILE 里 LATENT_TOKEN / MEMORY_HTTP_TOKEN 都换成新的了（权限 600）"
# 把 --token 从 ExecStart 里摘掉；续行符要一起处理，不然 unit 会断成半句
python3 - "$UF" <<'PY'
import sys, re
p = sys.argv[1]
t = open(p, encoding='utf-8').read()
# 形态一：--token X 单独占一行（带续行反斜杠）
t2 = re.sub(r'(?m)^[ \t]*--token[ \t]+\S+[ \t]*\\?[ \t]*\n', '', t)
# 形态二：--token X 跟在别的参数后面，同一行
t2 = re.sub(r'[ \t]+--token[ \t]+\S+', '', t2)
open(p, 'w', encoding='utf-8').write(t2)
print('  ExecStart 里还剩 --token 吗:', '还有！' if '--token' in t2 else '没有了')
PY
systemctl daemon-reload && ok "daemon-reload 了"

say "7/8 nginx 开门"
if [ "$DOOR_EXISTS" = 1 ]; then
  skip "已经有 location /latent/，不重复加"
else
  python3 - "$NGXFILE" "$DOMAIN" <<'PY'
import sys, re
path, dom = sys.argv[1], sys.argv[2]
src = open(path, encoding='utf-8').read()
BLOCK = """
    location /latent/ {
        # Latent 的门。上游只听 127.0.0.1，这里 HTTPS 收口再转进去。
        limit_except GET POST { deny all; }
        proxy_pass http://127.0.0.1:8765/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Authorization $http_authorization;
        proxy_buffering off;
        proxy_read_timeout 300s;
        client_max_body_size 8m;
    }
"""
# 找 server { ... } 里 server_name 含这个域名、且带 ssl/443 的那一个，
# 用花括号配对定位它真正的结尾，插在结尾前 —— 不靠缩进猜。
best = None
for m in re.finditer(r'\bserver\s*\{', src):
    i = m.end(); depth = 1
    while i < len(src) and depth:
        if src[i] == '{': depth += 1
        elif src[i] == '}': depth -= 1
        i += 1
    body = src[m.end():i-1]
    # 只认 listen 那一行里的 443/ssl —— 光看 body 里有没有 "ssl" 这三个字母，
    # 注释里出现一次就会把 80 那个跳转块当成正主
    if dom in body and re.search(r'(?m)^\s*listen[^;]*(443|ssl)', body):
        best = (m.end(), i-1)
        break
if not best:
    print('  找不到合适的 server 块'); sys.exit(1)
out = src[:best[1]] + BLOCK + src[best[1]:]
open(path, 'w', encoding='utf-8').write(out)
print('  已插入 location /latent/')
PY
  if [ $? -ne 0 ]; then no "插入失败，恢复备份"; cp "$NGXFILE.bak-$TS" "$NGXFILE"; exit 1; fi
fi
if nginx -t 2>&1 | grep -q 'successful'; then
  ok "nginx 配置校验通过"
  nginx -s reload 2>/dev/null && ok "nginx reload 了"
else
  no "nginx 配置校验没过，恢复备份，什么都不改"
  nginx -t 2>&1 | sed 's/^/      /'
  cp "$NGXFILE.bak-$TS" "$NGXFILE"
  cp "$UF.bak-$TS" "$UF"; systemctl daemon-reload
  exit 1
fi

say "8/8 重启 + 验证"
systemctl restart "$UNIT"
# ⚠ 不能 sleep 几秒就验：151 篇语料建索引要 10~15 秒，那时候 8765 还没开始监听，
# 验出来是本机 000 / 外网 502，看着像门没开成 —— 9.6 就是这么虚惊一场的。等到它应答为止。
printf '  等它把语料读完'
for i in $(seq 1 30); do
  _c=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$LATENT_URL/" -X POST \
        -H 'Content-Type: application/json' -d '{}' 2>/dev/null)
  [ "$_c" != "000" ] && { printf '（%d 秒，应答了）\n' "$((i*3))"; break; }
  printf '.'; sleep 3
done
echo
if systemctl is-active --quiet "$UNIT"; then ok "$UNIT 活着"
else
  no "起不来了！恢复所有备份"
  cp "$UF.bak-$TS" "$UF"; cp "$ENV_FILE.bak-$TS" "$ENV_FILE"; systemctl daemon-reload; systemctl restart "$UNIT"
  journalctl -u "$UNIT" -n 20 --no-pager | _mask | sed 's/^/      /'
  exit 1
fi
if ps -ef | grep -v grep | grep -q -- '--token'; then
  no "进程命令行里还看得见 --token"
else
  ok "进程命令行里已经没有 token 了（ps 看不到）"
fi
_probe(){ curl -s -m 25 -o /dev/null -w '%{http_code}' "$1" -X POST -H 'Content-Type: application/json' \
  ${2:+-H "Authorization: Bearer $2"} -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'; }
echo "  本机 + 新 token → HTTP $(_probe "$LATENT_URL/" "$NEWTOK")（要 200）"
[ -n "${OLDTOK:-}" ] && [ "$OLDTOK" != "$NEWTOK" ] && \
  echo "  本机 + 旧 token → HTTP $(_probe "$LATENT_URL/" "$OLDTOK")（要 401/403，旧的必须进不来）"
echo "  外网 + 新 token → HTTP $(_probe "https://$DOMAIN/latent/" "$NEWTOK")（要 200，这是门通了）"
echo "  外网 + 不给 token → HTTP $(_probe "https://$DOMAIN/latent/" "")（要 401/403）"

printf '\n\033[1m门开了。\033[0m\n'
cat <<TXT
  CC 那边下次开窗会自动读 cc- 仓库根的 .mcp.json 连过来，不用再手配。

  记住一句：现在挡在外面的只有那个 token。它泄露 = 任何人能读我们
  全部的聊天记录、也能往里写。别把 .mcp.json 贴进任何对话或截图。

  要关掉这个门：
    sudo cp $NGXFILE.bak-$TS $NGXFILE && sudo nginx -s reload
  要连 token 一起退回去：
    sudo cp $ENV_FILE.bak-$TS $ENV_FILE && sudo cp $UF.bak-$TS $UF \\
      && sudo systemctl daemon-reload && sudo systemctl restart $UNIT
TXT
echo
