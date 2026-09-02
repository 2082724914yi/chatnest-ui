#!/usr/bin/env bash
# 只读：把后端最近的报错捞出来，顺便列出可回滚的备份。什么都不改。
#   curl -fsSL .../deploy/show-log.sh | sudo bash
set -uo pipefail
API_DIR=${API_DIR:-/root/chatnest-api}
PORT=${PORT:-3000}

echo
echo "=== 1. 后端日志在哪 ==="
LOGS=""
for f in /var/log/chatnest-api.log /var/log/chatnest.log "$API_DIR/api.log" "$API_DIR/nohup.out" /root/nohup.out; do
  [ -f "$f" ] && { echo "  找到: $f ($(du -h "$f" | cut -f1), 改于 $(date -r "$f" '+%m-%d %H:%M'))"; LOGS="$LOGS $f"; }
done
# pm2 / systemd 的日志
if command -v pm2 >/dev/null 2>&1 && pm2 pid chatnest >/dev/null 2>&1; then
  echo "  （pm2 在管，日志：pm2 logs chatnest --lines 50）"
fi
if systemctl list-unit-files 2>/dev/null | grep -q '^chatnest.service'; then
  echo "  （systemd 在管，日志：journalctl -u chatnest -n 50）"
fi
[ -z "$LOGS" ] && echo "  没找到常见位置的日志文件"

echo
echo "=== 2. 最近的报错（崩溃/异常）==="
FOUND=0
for f in $LOGS; do
  HIT=$(grep -nEi 'error|throw|exception|unhandled|ECONN|TypeError|ReferenceError|not a function|undefined' "$f" 2>/dev/null | grep -v '\[OB\] calling' | tail -12)
  if [ -n "$HIT" ]; then
    echo "  --- $f ---"
    echo "$HIT" | sed 's/^/    /' | cut -c1-200
    FOUND=1
  fi
done
if command -v journalctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^chatnest.service'; then
  J=$(journalctl -u chatnest -n 200 --no-pager 2>/dev/null | grep -Ei 'error|throw|exception|TypeError' | tail -10)
  [ -n "$J" ] && { echo "  --- journalctl ---"; echo "$J" | sed 's/^/    /' | cut -c1-200; FOUND=1; }
fi
[ "$FOUND" = 0 ] && echo "  没翻到明显报错"

echo
echo "=== 3. 日志最后 25 行（不管是不是报错）==="
NEWEST=$(ls -t $LOGS 2>/dev/null | head -1)
if [ -n "${NEWEST:-}" ]; then
  echo "  --- $NEWEST ---"
  tail -25 "$NEWEST" | cut -c1-180 | sed 's/^/    /'
else
  command -v journalctl >/dev/null 2>&1 && journalctl -u chatnest -n 25 --no-pager 2>/dev/null | cut -c1-180 | sed 's/^/    /'
fi

echo
echo "=== 4. 可回滚的备份（万一要退回去）==="
ls -t "$API_DIR"/server.js.bak* 2>/dev/null | head -6 | while read -r b; do
  printf '  %s  (%s)\n' "$(basename "$b")" "$(date -r "$b" '+%m-%d %H:%M')"
done
echo "  当前 server.js 改于 $(date -r "$API_DIR/server.js" '+%m-%d %H:%M')"

echo
echo "=== 完，把以上发回来 ==="
