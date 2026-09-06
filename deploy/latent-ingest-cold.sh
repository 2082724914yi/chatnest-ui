#!/usr/bin/env bash
# 把 cc- 冷仓的 151 个窗灌进 Latent 的语料目录。
#
# 先干跑看报告（不写任何东西）：
#   curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/claude/baby-activities-today-0k5ueq/deploy/latent-ingest-cold.sh | sudo bash
# 确认没问题再真灌：
#   curl -fsSL .../deploy/latent-ingest-cold.sh -o /tmp/ing.sh && sudo APPLY=1 bash /tmp/ing.sh
#
# 文件不用从外面传：/opt/chatnest-deploy/cc- 就是 cc- 私有仓库在这台机器上的
# clone（install-autodeploy.sh 建的，带凭证，每 2 分钟拉一次），冷仓 9.5 已经
# 接到 main 了，所以那 151 个 md 现在就在这台机器上。
#
# 日期靠文件名（window_NN_YYYY-MM-DD.md）—— 那是上游解析优先级里最高的一档。
# 唯一不规范的 window_cc_night_0829.md 会补成 window_151_2026-08-29.md：
# 它正文里有完整日期所以日期本来就对，改名是为了让它也有窗口号。
set -uo pipefail

APPLY=${APPLY:-0}
ENV_FILE=${ENV_FILE:-/root/chatnest-api/.env}
SRC=${LATENT_SRC:-/opt/chatnest-deploy/cc-/latent-out/memory/timeline}
LATENT_URL=${LATENT_URL:-http://127.0.0.1:8765}

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
skip(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
_mask(){ sed -E 's/(--?[Tt][Oo][Kk][Ee][Nn][= ])[^ ]+/\1****（打码）/g; s/([Ss][Ee][Cc][Rr][Ee][Tt][= ])[^ ]+/\1****（打码）/g'; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }
[ "$APPLY" = 1 ] && printf '\n\033[1m【真灌模式】会写盘、会重启服务\033[0m\n' \
                 || printf '\n\033[1m【干跑】只看会发生什么，一个字都不写\033[0m\n'

# ---- 目标从正在跑的进程里抠，不写死 ----
PID=""
command -v ss >/dev/null 2>&1 && PID=$(ss -lptnH 2>/dev/null | grep -E '[:.]8765[[:space:]]' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
CMD=""; [ -n "${PID:-}" ] && [ -d "/proc/$PID" ] && CMD=$(cat "/proc/$PID/cmdline" 2>/dev/null | tr '\0' ' ')
_arg(){ printf '%s' "$CMD" | grep -oE -- "--$1 [^ ]+" | head -1 | cut -d' ' -f2; }
CORPUS=$(_arg corpus);   [ -z "${CORPUS:-}" ] && CORPUS=${LATENT_CORPUS:-/root/chatnest-api/latent-corpus}
THREADS=$(_arg threads); [ -z "${THREADS:-}" ] && THREADS=${LATENT_THREADS:-/root/chatnest-api/latent-threads.jsonl}
TZ_ARG=$(_arg timezone);  [ -z "${TZ_ARG:-}" ] && TZ_ARG=Asia/Shanghai
SCRIPT=$(printf '%s' "$CMD" | grep -oE '/[^ ]+mcp_server\.py' | head -1)
[ -z "${SCRIPT:-}" ] && SCRIPT=${LATENT_SCRIPT:-/opt/latent/upstream/src/mcp_server.py}
DST="$CORPUS/timeline"

say "1/7 冷仓在不在这台机器上"
# 路径不猜死。install-autodeploy.sh 里写的是 /opt/chatnest-deploy/cc-，
# 但那台机器上不一定跑过它 —— 所以先按常见位置找，再全盘找一次真有窗口文件的目录。
_has_windows(){ [ -d "${1:-}" ] && [ "$(find "$1" -maxdepth 1 -name 'window_*.md' 2>/dev/null | wc -l)" -gt 0 ]; }
if ! _has_windows "$SRC"; then
  FOUND=""
  for c in /opt/chatnest-deploy/cc-/latent-out/memory/timeline \
           /root/cc-/latent-out/memory/timeline \
           /opt/cc-/latent-out/memory/timeline \
           /home/admin/cc-/latent-out/memory/timeline \
           /root/chatnest-api/latent-out/memory/timeline; do
    _has_windows "$c" && { FOUND="$c"; break; }
  done
  if [ -z "$FOUND" ]; then
    skip "常见位置都没有，全盘找一遍带 window_*.md 的目录…"
    FOUND=$(find /opt /root /home /srv /var /data -maxdepth 8 -type d -name timeline 2>/dev/null | while read -r d; do
      [ "$(find "$d" -maxdepth 1 -name 'window_*_2026-*.md' 2>/dev/null | wc -l)" -gt 50 ] && { echo "$d"; break; }
    done | head -1)
  fi
  [ -n "${FOUND:-}" ] && SRC="$FOUND"
fi
if ! _has_windows "$SRC"; then
  no "这台机器上找不到冷仓（那 151 个 window_*.md）"
  echo
  echo "      cc- 是私有仓库，raw 拉不到，所以只能用机器上已有的 clone。现状："
  if [ -d /opt/chatnest-deploy ]; then
    echo "      /opt/chatnest-deploy 里有：$(ls /opt/chatnest-deploy 2>/dev/null | tr '\n' ' ')"
  else
    echo "      /opt/chatnest-deploy 不存在 —— 自动部署没在这台机器上装过"
  fi
  # 也许 clone 在别处、只是还没 pull 到冷仓那个 commit
  CCGIT=$(find /opt /root /home -maxdepth 4 -type d -name '.git' 2>/dev/null | while read -r g; do
    # 带不带 .git 后缀都要认：仓库里 clone 用的是 cc-.git，手动 clone 的常常没后缀
    git -C "$(dirname "$g")" remote get-url origin 2>/dev/null | grep -qE '/cc-(\.git)?/?$' && { echo "$(dirname "$g")"; break; }
  done | head -1)
  if [ -n "${CCGIT:-}" ]; then
    echo "      找到 cc- 的 clone：$CCGIT"
    echo "      它的 HEAD：$(git -C "$CCGIT" log -1 --format='%h %ad %s' --date=short 2>/dev/null | cut -c1-60)"
    echo "      但里面没有 latent-out/memory/timeline —— 多半是这份 clone 还没拉到 9.5 那个 commit。"
    echo "      先跑：sudo git -C $CCGIT pull origin main   然后再跑这个脚本。"
  else
    echo "      也没找到 cc- 的任何 clone。两条路："
    echo "        a) 在服务器上 clone 一份（私有仓库要凭证）："
    echo "           sudo git config --global credential.helper store"
    echo "           sudo git clone https://github.com/2082724914yi/cc-.git /opt/chatnest-deploy/cc-"
    echo "        b) 已经有一份在别的地方：LATENT_SRC=/那个/路径/timeline sudo bash 这个脚本"
  fi
  exit 1
fi
N_SRC=$(find "$SRC" -maxdepth 1 -name '*.md' | wc -l)
ok "$SRC — $N_SRC 个 md，$(du -sh "$SRC" 2>/dev/null | cut -f1)"
GITDIR=$(cd "$SRC" && git rev-parse --show-toplevel 2>/dev/null)
[ -n "${GITDIR:-}" ] && skip "来自 $GITDIR，最新 commit：$(git -C "$GITDIR" log -1 --format='%h %ad %s' --date=short 2>/dev/null | cut -c1-70)"
[ "$N_SRC" -lt 100 ] && { no "只有 $N_SRC 个文件，不像是一百多个窗的冷仓 —— 先确认 clone 是不是最新的"; exit 1; }

# 工作区里检出的是什么，跟冷仓在哪个分支上，是两件事：
# 她那台机器上的 clone 停在 claude/new-session-7jjirq，冷仓却在 main。
# 所以不看工作区检出的是什么，直接从 origin/<冷仓分支> 把那个目录取到临时目录来用 ——
# **她的 clone 一个字都不动**（不 pull、不切分支、不碰本地改动）。
# 上一版那个「落后就自动 pull」是错的：会把一条跟冷仓无关的分支拉进她的部署目录。
COLD_BR=${COLD_BRANCH:-main}
TMPSRC=""
cleanup(){ [ -n "${TMPSRC:-}" ] && rm -rf "$TMPSRC"; rm -rf /tmp/_ing; }
trap cleanup EXIT
if [ -n "${GITDIR:-}" ]; then
  skip "origin：$(git -C "$GITDIR" remote get-url origin 2>/dev/null || echo '（没有 origin）')"
  skip "工作区当前在 $(git -C "$GITDIR" symbolic-ref --short HEAD 2>/dev/null || echo '游离 HEAD')，$N_SRC 个 md"
  if git -C "$GITDIR" fetch --quiet origin "$COLD_BR" 2>/dev/null; then
    TMPSRC=$(mktemp -d /tmp/coldsrc.XXXXXX)
    if git -C "$GITDIR" archive FETCH_HEAD -- latent-out/memory/timeline 2>/dev/null | tar -x -C "$TMPSRC" 2>/dev/null; then
      CAND="$TMPSRC/latent-out/memory/timeline"
      N_CAND=$(find "$CAND" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l)
      if [ "$N_CAND" -ge 100 ]; then
        ok "从 origin/$COLD_BR 取到 $N_CAND 个 md（$(git -C "$GITDIR" log -1 --format='%h %ad %s' --date=short FETCH_HEAD 2>/dev/null | cut -c1-60)）"
        [ "$N_CAND" -gt "$N_SRC" ] && no "工作区那份少 $((N_CAND-N_SRC)) 个 —— 这次用 origin/$COLD_BR 那份，工作区不动"
        SRC="$CAND"; N_SRC="$N_CAND"
      else
        skip "origin/$COLD_BR 上只取到 $N_CAND 个，不像冷仓 —— 还用工作区那份"
      fi
    else
      skip "从 origin/$COLD_BR 取不出 latent-out/memory/timeline —— 还用工作区那份"
    fi
  else
    skip "fetch 不到 origin/$COLD_BR（没凭证或没网），只能用工作区那份 —— 它可能少几天，灌之前自己确认一下"
  fi
fi

say "2/7 灌到哪"
[ -d "$CORPUS" ] || { no "语料目录 $CORPUS 不存在"; exit 1; }
ok "$CORPUS （timeline 层：$DST）"
N_DST=$(find "$DST" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l)
skip "现在里面有 $N_DST 个 md"

say "3/7 逐个文件核日期（用它自己的解析器，不是我猜的）"
# 直接 import 线上这份上游代码：判日期的规则以它为准
REPORT=$(python3 - "$SRC" "$SCRIPT" <<'PY' 2>&1
import sys, os, datetime, collections
src, script = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.dirname(script))
try:
    from memory_retrieval import parse_chunk_timestamp, parse_window_no, infer_date_order
except Exception as e:
    print("IMPORTFAIL", e); raise SystemExit(0)
files = sorted(f for f in os.listdir(src) if f.endswith(".md"))
texts = [open(os.path.join(src, f), encoding="utf-8", errors="replace").read() for f in files]
order = infer_date_order(texts)
cnt = collections.Counter(); worry = []
for f, t in zip(files, texts):
    head = "\n".join(t.split("\n")[:8])
    mt = os.path.getmtime(os.path.join(src, f))
    ts, s = parse_chunk_timestamp(f, head, datetime.datetime.fromtimestamp(mt).year, order)
    w = parse_window_no(f)
    cnt[s] += 1
    if s == "mtime" or w is None:
        d = datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d") if ts else "解析不出"
        worry.append("%s|%s|%s|%s" % (f, s, d, w))
print("SOURCES " + " ".join("%s=%d" % kv for kv in sorted(cnt.items())))
for w in worry: print("WORRY " + w)
PY
)
if printf '%s' "$REPORT" | grep -q '^IMPORTFAIL'; then
  no "导不进上游解析器：$(printf '%s' "$REPORT" | head -1)"
  skip "跳过这项核对（不影响拷贝，但日期成色就没提前验过）"
else
  ok "$(printf '%s' "$REPORT" | grep '^SOURCES' | sed 's/^SOURCES /日期来源：/')"
  W=$(printf '%s' "$REPORT" | grep -c '^WORRY' || true)
  if [ "${W:-0}" -gt 0 ]; then
    printf '%s\n' "$REPORT" | grep '^WORRY' | while IFS='|' read -r a s d w; do
      f=${a#WORRY }
      [ "$s" = mtime ] && no  "$f → 落 mtime 兜底，日期不可信（会冒充最新）" \
                       || skip "$f → 日期 $d（来源 $s，对的），但解析不出窗口号"
    done
  else
    ok "没有落 mtime 兜底的文件"
  fi
fi

say "4/7 这次会拷哪些"
NEW=0; SAME=0; REN=""
mkdir -p /tmp/_ing && : > /tmp/_ing/plan
for f in "$SRC"/*.md; do
  b=$(basename "$f")
  t="$b"
  # 唯一不规范的那个：正文里有日期所以日期本来就对，改名只是为了拿到窗口号
  if [ "$b" = "window_cc_night_0829.md" ]; then t="window_151_2026-08-29.md"; REN="$b → $t"; fi
  if [ -f "$DST/$t" ] && cmp -s "$f" "$DST/$t"; then SAME=$((SAME+1)); continue; fi
  NEW=$((NEW+1)); printf '%s\t%s\n' "$f" "$DST/$t" >> /tmp/_ing/plan
done
ok "要拷 $NEW 个，已经一样的跳过 $SAME 个"
[ -n "$REN" ] && skip "改名：$REN"
[ "$NEW" = 0 ] && { ok "一个都不用拷 —— 已经灌过了"; rm -rf /tmp/_ing; exit 0; }
head -3 /tmp/_ing/plan | while IFS=$'\t' read -r a b; do skip "例：$(basename "$a") → $b"; done

if [ "$APPLY" != 1 ]; then
  printf '\n\033[1m干跑到此为止，一个字都没写。\033[0m\n'
  echo "  真要灌就跑："
  echo "    curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/claude/baby-activities-today-0k5ueq/deploy/latent-ingest-cold.sh -o /tmp/ing.sh && sudo APPLY=1 bash /tmp/ing.sh"
  rm -rf /tmp/_ing; exit 0
fi

say "5/7 备份 + 拷贝"
BAK=/root/latent-corpus-backup-$(date +%Y%m%d-%H%M%S).tar.gz
tar czf "$BAK" -C "$(dirname "$CORPUS")" "$(basename "$CORPUS")" 2>/dev/null && ok "旧语料备份到 $BAK（$(du -h "$BAK" | cut -f1)）" || no "备份失败，仍继续"
mkdir -p "$DST"
C=0
while IFS=$'\t' read -r a b; do cp -p "$a" "$b" && C=$((C+1)); done < /tmp/_ing/plan
ok "拷了 $C 个，现在 timeline 层共 $(find "$DST" -maxdepth 1 -name '*.md' | wc -l) 个 md"
rm -rf /tmp/_ing

say "6/7 重启服务"
UNIT=$(systemctl list-units --all --no-legend --plain 2>/dev/null | grep -i latent | awk '{print $1}' | head -1)
if [ -n "${UNIT:-}" ]; then
  systemctl restart "$UNIT" && ok "$UNIT 已重启" || no "重启失败"
  sleep 4
  systemctl is-active --quiet "$UNIT" && ok "还活着" || { no "起不来了！日志："; journalctl -u "$UNIT" -n 15 --no-pager | _mask | sed 's/^/      /'; }
else
  no "找不到 systemd unit，得手动重启它"
fi

say "7/7 验一遍"
if [ -f "$SCRIPT" ]; then
  timeout 180 python3 "$SCRIPT" --doctor --corpus "$CORPUS" --threads "$THREADS" --timezone "$TZ_ARG" 2>&1 | tail -20 | _mask | sed 's/^/      /'
fi
TOKEN=$(grep -E '^LATENT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')
for q in 晚霞 芒果三明治; do
  # 连不上跟没命中是两回事 —— 上一版把「服务没应答」也报成「命中了」，那是假阳性
  R=$(curl -fsS -m 40 "$LATENT_URL/" -H 'Content-Type: application/json' \
      ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"latent_search\",\"arguments\":{\"query\":\"$q\"}}}" 2>/dev/null)
  if [ -z "${R:-}" ]; then
    no "搜「$q」：服务没应答（刚重启可能还没起来，过几秒再手动试一次）"
    continue
  fi
  OUT=$(printf '%s' "$R" | python3 -c '
import sys,json
try: j=json.load(sys.stdin)
except Exception: print("BAD"); raise SystemExit
if j.get("error"): print("ERR "+str(j["error"])[:120]); raise SystemExit
t="".join(b.get("text","") for b in ((j.get("result") or {}).get("content") or []))
t=" ".join(t.split())
print(("MISS " if "没有可靠命中" in t else "HIT ")+t[:200])
' 2>/dev/null)
  case "${OUT:-BAD}" in
    HIT*)  ok "搜「$q」命中了："; echo "      ${OUT#HIT }";;
    MISS*) no "搜「$q」仍然没命中 —— 把这段发回来";;
    ERR*)  no "搜「$q」报错：${OUT#ERR }";;
    *)     no "搜「$q」返回看不懂：$(printf '%s' "$R" | head -c 150 | _mask)";;
  esac
done

printf '\n\033[1m灌完了。\033[0m\n'
echo "  现在是词面检索（没开 --embed）。想让它按意思找而不是按字找，"
echo "  下一步是开 embedding —— local 档用 fastembed 在本机算，不花钱；"
echo "  cloud 档会把语料发去服务商。那件事单独做，先别顺手开。"
echo "  出问题要回退：tar xzf $BAK -C $(dirname "$CORPUS") 然后重启服务。"
echo
