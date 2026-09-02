#!/usr/bin/env bash
# 查两件事：① CLI 把思考内容写哪去了 ② 启动为什么要 16 秒
#   curl -fsSL .../deploy/diag-home.sh | sudo bash
set -uo pipefail
CH=${CH:-/root/.claude}

echo
echo "=== 1. ~/.claude 结构与体积 ==="
[ -d "$CH" ] || { echo "  $CH 不存在"; exit 1; }
du -sh "$CH" 2>/dev/null | sed 's/^/  总体积  /'
for d in projects history todos shell-snapshots statsig plugins; do
  [ -e "$CH/$d" ] && printf '  %-18s %s\n' "$d" "$(du -sh "$CH/$d" 2>/dev/null | cut -f1)"
done
echo "  jsonl 文件数: $(find "$CH" -name '*.jsonl' 2>/dev/null | wc -l)"
echo "  文件总数:     $(find "$CH" -type f 2>/dev/null | wc -l)"

echo
echo "=== 2. MCP 配置（启动慢的头号嫌疑）==="
for f in "$CH/settings.json" "$CH/settings.local.json" /root/.claude.json; do
  [ -f "$f" ] || continue
  echo "  --- $f（$(wc -c < "$f") 字节）---"
  if grep -q mcpServers "$f" 2>/dev/null; then
    echo "    配了 MCP，服务器名："
    grep -o '"[a-zA-Z0-9_-]*"[[:space:]]*:[[:space:]]*{[[:space:]]*"\(command\|url\|type\)"' "$f" 2>/dev/null | cut -d'"' -f2 | sed 's/^/      · /' | head -10
  else
    echo "    没有 mcpServers"
  fi
  grep -o '"\(hooks\|env\|permissions\)"' "$f" 2>/dev/null | sort -u | sed 's/^/    含字段 /'
done

echo
echo "=== 3. 最近写入的 transcript ==="
LATEST=$(find "$CH" -name '*.jsonl' -newermt '-2 hours' 2>/dev/null | head -20 | xargs -r ls -t 2>/dev/null | head -1)
if [ -z "${LATEST:-}" ]; then
  echo "  近 2 小时没有新的 jsonl —— -p 模式可能根本不写 transcript"
  LATEST=$(find "$CH" -name '*.jsonl' 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)
  [ -n "${LATEST:-}" ] && echo "  最近的一个是: $LATEST（$(date -r "$LATEST" '+%m-%d %H:%M')）"
fi
if [ -n "${LATEST:-}" ]; then
  echo "  文件: $LATEST"
  echo "  行数: $(wc -l < "$LATEST")   大小: $(du -h "$LATEST" | cut -f1)"
  echo "  含 thinking 的行数: $(grep -c '"thinking"' "$LATEST" 2>/dev/null || echo 0)"
  echo "  顶层 type 分布:"
  grep -o '"type":"[a-z_]*"' "$LATEST" 2>/dev/null | sort | uniq -c | sort -rn | head -8 | sed 's/^/    /'
  echo "  ↓ 最后一条带 thinking 的记录，截前 400 字："
  grep '"thinking"' "$LATEST" 2>/dev/null | tail -1 | head -c 400 | sed 's/^/    /'
  echo
fi

echo
echo "=== 4. 启动耗时分解 ==="
export HOME=/root TERM=dumb
echo "  只跑 --version（纯启动开销）:"
S=$(date +%s%N); /usr/bin/claude --version >/dev/null 2>&1; E=$(date +%s%N)
echo "    $(( (E-S)/1000000 )) ms"
echo "  在空目录跑 --version（排除扫描当前目录的影响）:"
T=$(mktemp -d); S=$(date +%s%N); (cd "$T" && /usr/bin/claude --version >/dev/null 2>&1); E=$(date +%s%N)
echo "    $(( (E-S)/1000000 )) ms"; rmdir "$T" 2>/dev/null

echo
echo "=== 完，把以上全部发回 ==="
