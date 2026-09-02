#!/usr/bin/env bash
# 诊断 Claude CLI 到底会不会流式输出。输出很短，手机上看得完。
#   curl -fsSL .../deploy/diag-cli.sh | sudo bash
set -uo pipefail

CLI=${CLI:-/usr/bin/claude}
MODEL=${MODEL:-claude-sonnet-5}
export HOME=${HOME_DIR:-/root}
export TERM=dumb

echo
echo "=== 1. CLI 版本 ==="
"$CLI" --version 2>&1 | head -2

echo
echo "=== 2. help 里有没有这几个参数 ==="
HELP=$("$CLI" --help 2>&1 || true)
for f in include-partial-messages output-format verbose effort; do
  printf '  %-26s ' "--$f"
  echo "$HELP" | grep -q -- "--$f" && echo "有" || echo "help 里没写"
done

run(){ # $1=标签  $2=额外参数
  local tag=$1 extra=$2 tmp out rc
  tmp=$(mktemp); out=$(mktemp)
  echo "数一下 1 到 5，只回数字" > "$tmp"
  echo
  echo "=== $tag ==="
  # 每行打上到达时刻，看清是边生成边吐还是最后一次性吐
  local t0; t0=$(date +%s.%N)
  timeout 90 "$CLI" -p --model "$MODEL" $extra --verbose --output-format stream-json < "$tmp" 2>"$out" \
    | while IFS= read -r l; do
        printf '%s\t%s\n' "$(echo "$(date +%s.%N) - $t0" | bc)" "$l"
      done > "$tmp.log"
  rc=$?
  if [ ! -s "$tmp.log" ]; then
    echo "  没有任何输出（exit=$rc）"
    echo "  stderr: $(head -c 300 "$out")"
    rm -f "$tmp" "$out" "$tmp.log"; return 1
  fi
  echo "  输出 $(wc -l < "$tmp.log") 行"
  echo "  事件类型:"
  cut -f2 "$tmp.log" | grep -o '"type":"[a-z_]*"' | sort | uniq -c | sed 's/^/    /'
  echo "  首行到达: $(head -1 "$tmp.log" | cut -f1 | cut -c1-5)s   末行到达: $(tail -1 "$tmp.log" | cut -f1 | cut -c1-5)s"
  local n
  n=$(cut -f2 "$tmp.log" | grep -c 'stream_event')
  echo "  stream_event 条数: $n"
  if [ "$n" -gt 0 ]; then
    echo "  ↳ 增量事件的到达时刻（前 8 条）:"
    grep 'stream_event' "$tmp.log" | head -8 | while IFS=$'\t' read -r t l; do
      printf '      +%ss  %s\n' "$(echo "$t" | cut -c1-5)" "$(echo "$l" | grep -o '"type":"[a-z_]*"' | tail -1)"
    done
    echo "  ↳ 有没有思考增量: $(grep -c 'thinking_delta' "$tmp.log") 条"
  fi
  [ -s "$out" ] && echo "  stderr: $(head -c 200 "$out")"
  rm -f "$tmp" "$out" "$tmp.log"
}

run "3. 带 --include-partial-messages" "--include-partial-messages"
run "4. 不带该参数（对照）" ""

echo
echo "=== 完 ==="
echo "把上面全部内容发回来。"
