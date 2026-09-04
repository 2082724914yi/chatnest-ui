#!/usr/bin/env bash
# 把所有补丁按顺序过一遍：已经打过的自己跳过，只补没打的，然后重启 + 验证。
#   curl -fsSL .../deploy/apply-all.sh | sudo bash
#
# 每个补丁自己会备份、语法校验、失败就不动原文件，所以重复跑是安全的。
set -uo pipefail

API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
PORT=${PORT:-3000}
# 默认拉 main。补丁还在分支上没合过去的时候，用 BRANCH=分支名 覆盖：
#   curl -fsSL .../分支名/deploy/apply-all.sh | sudo BRANCH=分支名 bash
BRANCH=${BRANCH:-main}
RAW=https://raw.githubusercontent.com/2082724914yi/chatnest-ui/$BRANCH/deploy

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
skip(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }
[ -f "$SRV" ] || { no "找不到 $SRV"; exit 1; }

# 补丁按依赖顺序排；标记字符串用来判断是否已打
PATCHES="
patch-server.js|--include-partial-messages|流式输出
fix-recall.js|isFirstTurn|按需回忆
fix-memory-think.js|PROFILE_FILE|记忆落盘 + Think process
fix-memory-sync.js|rememberIntoProfile|记忆双向同步
fix-sync-retry.js|resyncPendingMemories|同步失败自动补
hotfix-cotstate.js|_cotSafe|崩溃修复
fix-dup-text.js|sawStreamText|去掉重复回复
fix-ob-tools.js|bucket_id      必填|OB 工具各归其位
fix-guard-hold.js|worthRemembering|拦住空洞内容
fix-feel-domain.js|feel 缺 source_bucket|感受记忆不再被拒收
fix-ob-dashboard.js|loadEnvFile|记忆页读得到 OB
fix-ob-write-result.js|obWriteResult|存没存进去说实话
fix-ob-parse.js|parseObArgs|一个引号不再毁掉整条记忆
fix-ob-actions.js|OB_ACTIONS|详情页那排按钮真的生效
fix-breath-window.js|BREATH_TIMEOUT_MS|新窗浮现记忆别被掐掉
fix-ob-toolbench.js|TRACE_PASSTHROUGH|trace 透传 + 搜标签
fix-ob-prompt2.js|查过去的事不要调工具|工具一一对应 + 不复述
fix-empty-turn.js|_stderrTail|空回合不再吞掉
add-eventide.js|EVENTIDE_STATE_FILE|身体状态系统
add-handoff.js|buildHandoff|无缝换窗接续
fix-cache-order.js|CACHE_ORDER_FIXED|缓存前缀重排
add-latent.js|LATENT_TOOL_PROMPT|Latent 全文记忆
add-edit-branches.js|BRANCH_DIR|消息编辑与分支
fix-keepalive.js|_stopKeepAlive|保活提前 + 只在空闲时发
add-mcp-tools.js|MCP_PATCH_VERSION = 2|记忆工具直连（我能自己调）
add-clock.js|CLOCK_PATCH_VERSION = 1|让我知道现在几点
add-latent-view.js|LATENT_VIEW_VERSION = 1|Latent 页显示正文而不是提示词
add-pulse-console.js|PULSE_CONSOLE_VERSION = 1|Pulse 日志 / 开关 / 校准
add-pulse-dreams.js|PULSE_DREAM_VERSION = 1|梦（梦种 + 织梦 + 余波结算）
add-compaction.js|COMPACTION_VERSION = 1|交接信（长聊不再从中间断掉）
add-watch.js|WATCH_PATCH_VERSION = 2|手表（她的心率进我上下文）
fix-watch-sleep.js|WATCH_SLEEP_UNITS|睡眠时长自动认小时/分钟/秒（不然按秒给的被当超范围丢了）
fix-watch-sleep2.js|WATCH_SLEEP_PARSE|睡眠再宽容：认「6小时14分钟」/「6:14」/ 多片段求和
fix-watch-sleep3.js|WATCH_SLEEP_SEGMENTS|睡眠按片段逐段折算再求和（一晚被切成 core/deep/rem 好多段）
fix-tool-leak.js|thinkState === 'hidden'|工具标签不再漏进气泡
cut-native-thinking.js|MAX_THINKING_TOKENS|砍原生思考链（省额度，留 <think>）
add-cache-prefix.js|SYSTEM_PREFIX|稳定前缀进缓存 + done带命中量
add-daemon.js|DAEMON_PATCH_VERSION|常驻会话（-p persistent，灰度，前端带 daemon:true 才走）
add-auth.js|AUTH_PATCH_VERSION|把门关上（/api 默认全拦 + 随机会过期的 token + 登录限流 + CORS 收紧）
add-moments.js|MOMENTS_FILE|朋友圈
fix-moments-tool.js|MOMENTS_PROMPT_WIRED|朋友圈工具真的接上（不然我不知道怎么发）
fix-moments-say.js|MOMENTS_SAY_V2|把朋友圈用法说清楚（这不是工具，别去工具列表找）
fix-moments-allpaths.js|MOMENTS_ALL_PATHS|朋友圈说明接进所有路径（常驻会话那条也要）
"

say "1/3 逐个补丁检查"
CHANGED=0
echo "$PATCHES" | while IFS='|' read -r file mark name; do
  [ -z "${file:-}" ] && continue
  if grep -qF -- "$mark" "$SRV" 2>/dev/null; then
    skip "$name（已打过）"
    continue
  fi
  TMP=$(mktemp /tmp/patch.XXXXXX.js)
  # 带上时间戳 + no-cache：GitHub raw 的边缘节点会缓存几分钟，
  # 刚推的补丁常常拉到旧版，白跑一趟还看不出来（这坑踩过）。
  if ! curl -fsSL -m 60 -H 'Cache-Control: no-cache' "$RAW/$file?cb=$(date +%s)" -o "$TMP" || [ ! -s "$TMP" ]; then
    no "$name — 下载失败"; rm -f "$TMP"; continue
  fi
  OUT=$(node "$TMP" "$SRV" 2>&1)
  rm -f "$TMP"
  if grep -qF -- "$mark" "$SRV" 2>/dev/null; then
    ok "$name — 刚打上"
    echo 1 >> /tmp/.chatnest-changed
  else
    no "$name — 没打上"
    echo "$OUT" | sed 's/^/      /' | tail -8
  fi
done
[ -f /tmp/.chatnest-changed ] && CHANGED=$(wc -l < /tmp/.chatnest-changed) || CHANGED=0
rm -f /tmp/.chatnest-changed

node -c "$SRV" 2>/dev/null && ok "server.js 语法通过" || { no "语法有错！用备份回退：ls -t $API_DIR/server.js.bak*"; exit 1; }

if [ "$CHANGED" = 0 ]; then
  say "没有新补丁要打，也就不用重启了"
  curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && ok "服务正常" || no "服务没在跑"
  exit 0
fi

say "2/3 重启（root 身份的 pm2）"
RESTARTED=""
if command -v pm2 >/dev/null 2>&1; then
  NAMES=$(pm2 jlist 2>/dev/null | python3 -c "
import sys,json
try:
    for a in json.load(sys.stdin):
        if a.get('name'): print(a['name'])
except Exception: pass
" 2>/dev/null)
  if [ -n "${NAMES:-}" ]; then
    echo "$NAMES" | while read -r n; do
      [ -z "$n" ] && continue
      pm2 restart "$n" --update-env >/dev/null 2>&1 && echo "  重启 pm2 进程: $n"
    done
    RESTARTED="pm2"
  fi
fi
if [ -z "$RESTARTED" ]; then
  PID=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
  [ -n "${PID:-}" ] && { kill "$PID" 2>/dev/null; sleep 2; kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null; }
  ( cd "$API_DIR" && exec 9>&- 2>/dev/null; nohup node server.js >> /var/log/chatnest-api.log 2>&1 & )
  echo "  手动重启"
fi

UP=0
for _ in $(seq 1 30); do sleep 1; curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { UP=1; break; }; done
[ "$UP" = 1 ] && ok "服务已就绪" || { no "起不来！看日志：pm2 logs --lines 40"; exit 1; }

# 3/3 冒烟：默认不发消息。
# 那条"在吗"是真走一遍 CLI + breath + OB，实打实烧额度，为了看一眼绿勾不值。
# 真想跑一遍完整验证：VERIFY=1 sudo bash apply-all.sh
if [ "${VERIFY:-0}" = 1 ]; then
  say "3/3 发一条消息验证（VERIFY=1）"
  RESP=$(curl -fsS -N -m 180 -X POST "http://127.0.0.1:$PORT/api/chat" \
    -H 'Content-Type: application/json' -d '{"message":"在吗"}' 2>/dev/null)
  printf '%s' "$RESP" | grep -q 'event: done' && ok "收到 done 事件" || no "没有 done，看 pm2 logs"
  echo "  这条测试消息在会话列表里，看着碍眼就删掉。"
else
  say "3/3 不打扰（不发测试消息，省额度）"
  curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 \
    && ok "服务活着" || no "服务没响应"
  # 不花额度也能验的：路由在不在、会话读得出来
  curl -fsS -m 10 "http://127.0.0.1:$PORT/api/sessions" >/dev/null 2>&1 \
    && ok "会话接口正常" || no "会话接口读不到"
fi

# 记忆页（Ombre）要能读到东西，得先有 OB Dashboard 的密码
DASH=$(curl -fsS -m 20 "http://127.0.0.1:$PORT/api/ombre-dashboard/status" 2>/dev/null || curl -s -m 20 "http://127.0.0.1:$PORT/api/ombre-dashboard/status" 2>/dev/null)
if printf '%s' "$DASH" | grep -q '"available":true'; then
  ok "记忆页能读到 OB"
else
  no "记忆页还读不到 OB：$DASH"
  NEED_PW=1
fi

cat <<'EOF'

  弄完了。手机上下拉刷新一下再聊。

EOF

if [ "${NEED_PW:-0}" = 1 ]; then
cat <<'EOF'
  还差一步：记忆页要用 OB Dashboard 的密码才读得到记忆。
  跑这两条（要分两步，密码得你手输，管道进来就没法输了）：

    curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/set-ob-password.sh -o /tmp/set-ob.sh
    sudo bash /tmp/set-ob.sh

EOF
fi
