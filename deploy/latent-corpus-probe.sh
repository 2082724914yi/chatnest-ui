#!/usr/bin/env bash
# Latent corpus 探针 —— 还是只看不动。
#   curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/claude/baby-activities-today-0k5ueq/deploy/latent-corpus-probe.sh | sudo bash
#
# 上一个探针回答了「它是什么」，这个回答「东西放哪、什么格式、怎么加进去」：
# 服务是被谁拉起来的、mcp_server.py 认得哪些参数、corpus 目录长什么样、
# threads.jsonl 一行是什么、索引存在哪、上游是哪个仓库。
# 一个字都不写、一个服务都不重启。凡是印出来的都过打码。
set -uo pipefail

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
skip(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
_mask(){ sed -E 's/(--?[Tt][Oo][Kk][Ee][Nn][= ])[^ ]+/\1****（打码）/g; s/(--?[Aa][Pp][Ii][-_]?[Kk][Ee][Yy][= ])[^ ]+/\1****（打码）/g; s/([Ss][Ee][Cc][Rr][Ee][Tt][= ])[^ ]+/\1****（打码）/g; s/([Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd][= ])[^ ]+/\1****（打码）/g'; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }

# 路径不写死，从正在跑的那个进程的命令行里抠 —— 它说的才算数
PID=""
if command -v ss >/dev/null 2>&1; then
  PID=$(ss -lptnH 2>/dev/null | grep -E '[:.]8765[[:space:]]' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
fi
CMD=""
[ -n "${PID:-}" ] && [ -d "/proc/$PID" ] && CMD=$(cat "/proc/$PID/cmdline" 2>/dev/null | tr '\0' ' ')
_arg(){ printf '%s' "$CMD" | grep -oE -- "--$1 [^ ]+" | head -1 | cut -d' ' -f2; }
SCRIPT=$(printf '%s' "$CMD" | grep -oE '/[^ ]+mcp_server\.py' | head -1)
CORPUS=$(_arg corpus);  [ -z "${CORPUS:-}" ] && CORPUS=${LATENT_CORPUS:-/root/chatnest-api/latent-corpus}
THREADS=$(_arg threads); [ -z "${THREADS:-}" ] && THREADS=${LATENT_THREADS:-/root/chatnest-api/latent-threads.jsonl}
[ -z "${SCRIPT:-}" ] && SCRIPT=${LATENT_SCRIPT:-/opt/latent/upstream/src/mcp_server.py}
echo "  corpus : $CORPUS"
echo "  threads: $THREADS"
echo "  程序   : $SCRIPT"

say "1/6 它是被谁拉起来的"
UNIT=$(systemctl list-units --all --no-legend --plain 2>/dev/null | grep -i latent | awk '{print $1}' | head -1)
[ -z "${UNIT:-}" ] && UNIT=$(ls /etc/systemd/system/*latent* 2>/dev/null | head -1 | xargs -r basename)
if [ -n "${UNIT:-}" ]; then
  ok "systemd: $UNIT"
  systemctl status "$UNIT" --no-pager -n 0 2>/dev/null | head -4 | _mask | sed 's/^/      /'
  UF=$(systemctl show -p FragmentPath --value "$UNIT" 2>/dev/null)
  [ -n "${UF:-}" ] && [ -f "$UF" ] && { echo "      unit 文件 $UF ："; grep -E '^(ExecStart|Environment|EnvironmentFile|WorkingDirectory|User)' "$UF" | _mask | sed 's/^/        /'; }
elif command -v pm2 >/dev/null 2>&1 && pm2 list 2>/dev/null | grep -qi latent; then
  ok "pm2 在管它"; pm2 list 2>/dev/null | grep -i latent | _mask | sed 's/^/      /'
else
  skip "systemd / pm2 里都没有它 —— 可能是 nohup 裸跑的（那重启机器就没了，得记一笔）"
  [ -n "${PID:-}" ] && echo "      父进程: $(ps -o comm= -p "$(awk '/^PPid:/{print $2}' /proc/$PID/status 2>/dev/null)" 2>/dev/null || echo 未知)"
fi

say "2/6 mcp_server.py 认得哪些参数"
# --help 只打印帮助就退出，不会起服务。重点看：能不能从文件/环境变量读口令，有没有重建索引的命令
if [ -f "$SCRIPT" ]; then
  H=$(timeout 30 python3 "$SCRIPT" --help 2>&1 | head -60)
  if [ -n "$H" ]; then printf '%s\n' "$H" | _mask | sed 's/^/      /'; ok "帮助如上"
  else no "--help 没吐东西"; fi
  # 这三个词决定换口令怎么换、数据怎么灌
  for k in token-file TOKEN env reindex ingest rebuild watch; do
    printf '%s' "$H" | grep -qi -- "$k" && ok "帮助里提到「$k」"
  done
else
  no "找不到 $SCRIPT"
fi

say "3/6 corpus 目录长什么样"
if [ -d "$CORPUS" ]; then
  N=$(find "$CORPUS" -type f 2>/dev/null | wc -l)
  ok "$CORPUS 共 $N 个文件，$(du -sh "$CORPUS" 2>/dev/null | cut -f1)"
  echo "      按后缀："
  find "$CORPUS" -type f 2>/dev/null | sed -E 's#.*/##; s#^[^.]*$#(无后缀)#; s#.*\.#.#' | sort | uniq -c | sort -rn | head -8 | sed 's/^/        /'
  echo "      最近改动的 5 个："
  find "$CORPUS" -type f -printf '%TY-%Tm-%Td %10s %p\n' 2>/dev/null | sort -r | head -5 | sed 's/^/        /'
  # 挑最大的那个看 —— 挑到一个两行的空壳等于白看
  F=$(find "$CORPUS" -type f -printf '%s %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
  if [ -n "${F:-}" ]; then
    echo "      随便挑一个看格式（$F 前 15 行）："
    head -15 "$F" 2>/dev/null | _mask | cut -c1-120 | sed 's/^/        /'
  fi
else
  no "$CORPUS 不存在（那它的语料是从哪来的？）"
fi

say "4/6 threads.jsonl"
if [ -f "$THREADS" ]; then
  ok "$(wc -l < "$THREADS") 行，$(du -h "$THREADS" 2>/dev/null | cut -f1)"
  # 只打印字段名和长度，不把正文倒出来
  head -1 "$THREADS" | python3 -c '
import sys,json
try:
    d=json.loads(sys.stdin.read() or "{}")
except Exception as e:
    print("      第一行不是 JSON:",e); raise SystemExit
if isinstance(d,dict):
    print("      第一行的字段：")
    for k,v in d.items():
        s=str(v); print("        %-16s %s（%d 字）"%(k, s[:40].replace("\n"," "), len(s)))
' 2>/dev/null || skip "第一行解析不了"
else
  skip "$THREADS 不存在"
fi

say "5/6 索引存在哪"
# 这条很关键：如果磁盘上根本没有索引文件，说明索引是起服务时现算的，
# 那 150 窗就只要「放文件 + 重启」，不用先开对外的门
IDX=$(for d in "$CORPUS" "$(dirname "$THREADS")" "$(dirname "$SCRIPT")" /opt/latent; do
  [ -d "$d" ] || continue
  find "$d" -maxdepth 3 \( -name '*.faiss' -o -name '*.npy' -o -name '*.index' -o -name '*.db' -o -name '*.sqlite*' -o -name '*.pkl' \) -size +1k 2>/dev/null
done | sort -u | head -8)
if [ -n "${IDX:-}" ]; then
  printf '%s\n' "$IDX" | while read -r f; do echo "      $(du -h "$f" 2>/dev/null | cut -f1)	$f"; done
  ok "有落盘的索引（加了语料多半要重建一次）"
else
  skip "磁盘上没有索引文件 —— 索引可能是起服务时现算的（那灌数据就只要放文件 + 重启）"
fi
[ -n "${PID:-}" ] && [ -d "/proc/$PID" ] && {
  echo "      它自己打开着的文件："
  ls -l /proc/$PID/fd 2>/dev/null | grep -oE '/[^ ]+$' | grep -vE '^/(dev|proc|sys)' | sort -u | head -8 | sed 's/^/        /'
}

say "6/6 上游是哪个仓库"
for d in /opt/latent /opt/latent/upstream; do
  [ -d "$d/.git" ] || continue
  ok "$d → $(git -C "$d" remote get-url origin 2>/dev/null || echo '（没有 origin）')"
  echo "      当前 $(git -C "$d" log -1 --format='%h %ad %s' --date=short 2>/dev/null | cut -c1-90)"
done
R=$(ls /opt/latent/upstream/README* /opt/latent/README* 2>/dev/null | head -1)
[ -n "${R:-}" ] && { echo "      README 开头："; head -5 "$R" | cut -c1-100 | sed 's/^/        /'; }

printf '\n\033[1m看完了，还是什么都没动。把这段发给我。\033[0m\n'
echo "  我要的是：2 的参数表（决定口令怎么换、索引怎么重建）、"
echo "  3 的 corpus 格式（决定 150 窗怎么灌）、6 的上游仓库（我去读它源码）。"
echo
