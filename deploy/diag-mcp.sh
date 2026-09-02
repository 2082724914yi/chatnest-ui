#!/usr/bin/env bash
# 测 MCP 是不是启动慢的元凶：同一句话，带 MCP 跑一次、禁用 MCP 跑一次，比首字耗时。
#   curl -fsSL .../deploy/diag-mcp.sh | sudo bash
set -uo pipefail
CLI=${CLI:-/usr/bin/claude}
MODEL=${MODEL:-claude-sonnet-5}
export HOME=/root TERM=dumb

echo
echo "=== 1. /root/.claude.json 里配了哪些 MCP ==="
python3 - <<'PY' 2>/dev/null || echo "  （解析失败，可能不是标准 JSON）"
import json
try: d=json.load(open('/root/.claude.json'))
except Exception as e: print('  读取失败:',e); raise SystemExit
def walk(o,p=''):
    if isinstance(o,dict):
        if 'mcpServers' in o and isinstance(o['mcpServers'],dict):
            for k,v in o['mcpServers'].items():
                kind=v.get('type') or ('command' if 'command' in v else '?')
                tgt=v.get('url') or v.get('command') or ''
                print(f"  在 {p or '顶层'}: {k}  [{kind}]  {str(tgt)[:60]}")
        for k,v in o.items(): walk(v, f"{p}.{k}" if p else k)
walk(d)
print("  projects 段里记录的项目数:", len(d.get('projects',{})))
for k in list(d.get('projects',{}))[:6]: print("    ·",k)
PY

echo
echo "=== 2. plugins 目录 ==="
du -sh /root/.claude/plugins 2>/dev/null | sed 's/^/  /'
ls /root/.claude/plugins 2>/dev/null | head -8 | sed 's/^/    · /'

run(){ # $1=标签 $2=额外参数 $3=工作目录
  local tag=$1 extra=$2 wd=$3 tmp t0 first last
  tmp=$(mktemp); echo "说一个字：好" > "$tmp"
  echo
  echo "=== $tag ==="
  echo "  工作目录: $wd"
  t0=$(date +%s.%N)
  ( cd "$wd" && timeout 120 "$CLI" -p --model "$MODEL" $extra --verbose --include-partial-messages --output-format stream-json < "$tmp" 2>/dev/null ) \
    | while IFS= read -r l; do printf '%s\t%s\n' "$(echo "$(date +%s.%N) - $t0" | bc)" "$l"; done > "$tmp.log"
  if [ ! -s "$tmp.log" ]; then echo "  没有输出"; rm -f "$tmp" "$tmp.log"; return; fi
  first=$(head -1 "$tmp.log" | cut -f1)
  last=$(tail -1 "$tmp.log" | cut -f1)
  local ftext
  ftext=$(grep -m1 'text_delta' "$tmp.log" | cut -f1)
  printf '  首行输出: %ss\n' "$(printf '%.1f' "$first")"
  [ -n "${ftext:-}" ] && printf '  首个文字: %ss   <<< 这个数字就是她要等多久\n' "$(printf '%.1f' "$ftext")"
  printf '  全部结束: %ss\n' "$(printf '%.1f' "$last")"
  rm -f "$tmp" "$tmp.log"
}

EMPTY=$(mktemp -d)
NOMCP=$(mktemp); echo '{"mcpServers":{}}' > "$NOMCP"

run "3. 现状（在 /root/chatnest-api，带全部 MCP）" "" "/root/chatnest-api"
run "4. 禁用 MCP（同目录）" "--mcp-config $NOMCP --strict-mcp-config" "/root/chatnest-api"
run "5. 禁用 MCP + 空工作目录" "--mcp-config $NOMCP --strict-mcp-config" "$EMPTY"

rm -f "$NOMCP"; rmdir "$EMPTY" 2>/dev/null
echo
echo "=== 完，把 3/4/5 三组的「首个文字」发回来 ==="
