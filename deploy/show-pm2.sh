#!/usr/bin/env bash
# 只读：pm2 才是真正在管进程的，日志也在它那儿。把真日志捞出来。
#   curl -fsSL .../deploy/show-pm2.sh | sudo bash
set -uo pipefail

echo
echo "=== 1. pm2 里有什么 ==="
if command -v pm2 >/dev/null 2>&1; then
  pm2 list 2>/dev/null | sed 's/^/  /'
  echo
  echo "  进程详情："
  pm2 jlist 2>/dev/null | python3 -c "
import sys,json
try: apps=json.load(sys.stdin)
except: print('    (jlist 解析失败)'); raise SystemExit
for a in apps:
    e=a.get('pm2_env',{})
    print(f\"    名字: {a.get('name')}   pid: {a.get('pid')}   状态: {e.get('status')}\")
    print(f\"      重启次数: {e.get('restart_time')}   异常重启: {e.get('unstable_restarts')}\")
    print(f\"      脚本: {e.get('pm_exec_path')}\")
    print(f\"      工作目录: {e.get('pm_cwd')}\")
    print(f\"      out日志: {e.get('pm_out_log_path')}\")
    print(f\"      err日志: {e.get('pm_err_log_path')}\")
    up=e.get('pm_uptime')
    if up:
        import datetime
        print(f\"      启动于: {datetime.datetime.fromtimestamp(up/1000).strftime('%m-%d %H:%M:%S')}\")
"
else
  echo "  没装 pm2"
fi

echo
echo "=== 2. pm2 错误日志（最后 40 行）==="
ERRLOG=$(pm2 jlist 2>/dev/null | python3 -c "
import sys,json
try:
    for a in json.load(sys.stdin):
        p=a.get('pm2_env',{}).get('pm_err_log_path')
        if p: print(p); break
except: pass
")
if [ -n "${ERRLOG:-}" ] && [ -f "$ERRLOG" ]; then
  echo "  --- $ERRLOG ($(du -h "$ERRLOG" | cut -f1), 改于 $(date -r "$ERRLOG" '+%m-%d %H:%M')) ---"
  tail -40 "$ERRLOG" | cut -c1-200 | sed 's/^/    /'
else
  echo "  找不到 err 日志，试试 ~/.pm2/logs/"
  ls -t /root/.pm2/logs/*error* 2>/dev/null | head -2 | while read -r f; do
    echo "  --- $f (改于 $(date -r "$f" '+%m-%d %H:%M')) ---"
    tail -30 "$f" | cut -c1-200 | sed 's/^/    /'
  done
fi

echo
echo "=== 3. pm2 输出日志里最近一次请求的收尾 ==="
OUTLOG=$(pm2 jlist 2>/dev/null | python3 -c "
import sys,json
try:
    for a in json.load(sys.stdin):
        p=a.get('pm2_env',{}).get('pm_out_log_path')
        if p: print(p); break
except: pass
")
[ -z "${OUTLOG:-}" ] && OUTLOG=$(ls -t /root/.pm2/logs/*out* 2>/dev/null | head -1)
if [ -n "${OUTLOG:-}" ] && [ -f "$OUTLOG" ]; then
  echo "  --- $OUTLOG (改于 $(date -r "$OUTLOG" '+%m-%d %H:%M')) ---"
  echo "  [最后 30 行]"
  tail -30 "$OUTLOG" | cut -c1-170 | sed 's/^/    /'
  echo
  echo "  [其中的 COT Guard 收尾行 —— 有这行说明 close handler 跑到了]"
  grep 'COT Guard' "$OUTLOG" 2>/dev/null | tail -5 | sed 's/^/    /'
else
  echo "  找不到 out 日志"
fi

echo
echo "=== 4. 端口 8800 是不是被占着 ==="
ss -lptn 'sport = :8800' 2>/dev/null | tail -2 | sed 's/^/  /'
lsof -iTCP:8800 -sTCP:LISTEN 2>/dev/null | tail -3 | sed 's/^/  /'
echo "  监听 8800 的进程数: $(ss -lptnH 'sport = :8800' 2>/dev/null | wc -l)"

echo
echo "=== 完，把以上发回来 ==="
