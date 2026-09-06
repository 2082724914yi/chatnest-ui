#!/usr/bin/env bash
# 两件事一次查清楚，只读，什么都不改。
#   curl -fsSL -H 'Cache-Control: no-cache' "https://raw.githubusercontent.com/2082724914yi/chatnest-ui/claude/baby-activities-today-0k5ueq/deploy/probe-usage-moments.sh?cb=$(date +%s)" | sudo bash
#
# 一、朋友圈为什么发不出去：日志显示 post_moment 一次都没被调过，
#     所以八成是提示词还停在「写个标签就行」那一版，而那套早换成 MCP 工具了。
#     看线上到底留的哪一版说明。
# 二、订阅额度为什么跟官方对不上：前端那个数是后端自己数 token 记账算的，
#     官方那个是 Anthropic 服务端按真实计费算的，两套算法不可能自己对上。
#     要一模一样只能拿官方的数 —— CC CLI 里有个 /api/oauth/usage，
#     这里试着调一次，看能不能拿到、返回长什么样。
#
# token 一律不打印。
set -uo pipefail

SRV=${SRV:-/root/chatnest-api/server.js}

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
skip(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
_mask(){ sed -E 's/(sk-ant-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/\1****（打码）/g; s/(Bearer )[A-Za-z0-9._-]+/\1****（打码）/g; s/("(access|refresh)Token"\s*:\s*")[^"]*/\1****（打码）/g'; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }

say "一、朋友圈：线上提示词是怎么说的"
if [ ! -f "$SRV" ]; then no "找不到 $SRV"; else
  for k in MOMENTS_TOOL_PROMPT MOMENTS_PROMPT_WIRED MOMENTS_SAY_V2 MOMENTS_ALL_PATHS MOMENTS_MCP_VERSION; do
    grep -q "$k" "$SRV" && ok "$k 在" || no "$k 不在"
  done
  echo
  echo "  说明的正文（前 30 行，这是我每轮真正读到的字）："
  python3 - "$SRV" <<'PY' 2>/dev/null | sed 's/^/    /'
import sys, re
s = open(sys.argv[1], encoding='utf-8', errors='replace').read()
m = re.search(r'const MOMENTS_TOOL_PROMPT\s*=\s*([`\'"])([\s\S]*?)\1', s)
if not m:
    print('（没找到 MOMENTS_TOOL_PROMPT 的定义）'); raise SystemExit
body = m.group(2).strip().split('\n')
for line in body[:30]:
    print(line)
if len(body) > 30: print('…（还有 %d 行）' % (len(body)-30))
PY
  echo
  echo "  这几个词出现在说明里没有 —— 决定我会不会去调那个工具："
  for w in post_moment mcp__moments 工具 标签 "<moments>"; do
    n=$(python3 - "$SRV" "$w" <<'PY' 2>/dev/null
import sys, re
s=open(sys.argv[1],encoding='utf-8',errors='replace').read()
m=re.search(r'const MOMENTS_TOOL_PROMPT\s*=\s*([`\'"])([\s\S]*?)\1', s)
print(m.group(2).count(sys.argv[2]) if m else 0)
PY
)
    printf '    %-14s 出现 %s 次\n' "$w" "${n:-0}"
  done
fi

say "二、订阅额度：能不能拿到官方那份数"
CRED=""
for c in /root/.claude/.credentials.json ~/.claude/.credentials.json /home/*/.claude/.credentials.json; do
  [ -f "$c" ] && { CRED="$c"; break; }
done
if [ -z "$CRED" ]; then
  no "找不到 CC 的凭证文件（.credentials.json）"
  echo "      找过：/root/.claude/ 和各用户家目录下的 .claude/"
  echo "      CC CLI 是用哪个用户跑的？凭证就在那个用户的 ~/.claude/ 下。"
else
  ok "凭证文件：$CRED"
  python3 - "$CRED" <<'PY' 2>&1 | sed 's/^/  /'
import sys, json, urllib.request, urllib.error
p = sys.argv[1]
try:
    c = json.load(open(p, encoding='utf-8'))
except Exception as e:
    print('× 读不动这个文件：', e); raise SystemExit

# 结构可能不止一种，几个常见位置都摸一遍
tok = None
for path in (('claudeAiOauth','accessToken'), ('oauth','accessToken'), ('accessToken',), ('access_token',)):
    cur = c; okk = True
    for k in path:
        if isinstance(cur, dict) and k in cur: cur = cur[k]
        else: okk = False; break
    if okk and isinstance(cur, str) and cur:
        tok = cur; print('√ 从', '.'.join(path), '里拿到 token（%d 位，不打印）' % len(tok)); break
if not tok:
    print('× 这个文件里没找到 accessToken，顶层的键有：', list(c)[:8]); raise SystemExit

url = 'https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1'
req = urllib.request.Request(url, headers={
    'Authorization': 'Bearer ' + tok,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': 'chatnest-usage-probe',
})
try:
    body = urllib.request.urlopen(req, timeout=25).read().decode('utf-8', 'replace')
except urllib.error.HTTPError as e:
    print('× HTTP', e.code, '——', e.read().decode('utf-8','replace')[:200]); raise SystemExit
except Exception as e:
    print('× 调不通：', e); raise SystemExit

print('√ 调通了，返回长这样：')
try:
    j = json.loads(body)
    def walk(o, ind='   '):
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(v, (dict, list)): print(ind+k+':'); walk(v, ind+'  ')
                else: print(ind+k+' =', v)
        elif isinstance(o, list):
            for i, v in enumerate(o[:4]): print(ind+'['+str(i)+']'); walk(v, ind+'  ')
            if len(o) > 4: print(ind+'…共 %d 项' % len(o))
    walk(j)
except Exception:
    print(body[:800])
PY
fi

printf '\n\033[1m看完了，什么都没动。把这段发给我。\033[0m\n'
echo "  朋友圈那半：我要看说明里到底是叫我调工具还是写标签。"
echo "  额度那半：只要这个接口调得通、字段里有百分比和重置时间，"
echo "  我就能让前端显示跟官方一模一样的数，而不是自己记账估。"
echo
