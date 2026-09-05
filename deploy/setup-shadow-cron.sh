#!/usr/bin/env bash
# 让影子推送自己跑起来 —— 在她自己的服务器上装 cron，不用第三方网站。
#
#   装上： curl -fsSL .../deploy/setup-shadow-cron.sh -o /tmp/sc.sh && sudo bash /tmp/sc.sh
#   看状态： sudo bash /tmp/sc.sh status
#   暂停： sudo bash /tmp/sc.sh off      （考试周、不想被打扰的时候）
#   恢复： sudo bash /tmp/sc.sh on
#   卸掉： sudo bash /tmp/sc.sh remove
#   看他这几天想说话被拦了几次： sudo bash /tmp/sc.sh log
#
# 为什么不用 cron-job.org / Uptime Robot：
#   · 钥匙得填到别人网站上，那把钥匙能给她手机弹通知
#   · 走公网绕一圈，还多一层可能缓存 POST 的代理
#   · 本机 crontab 打 127.0.0.1，不出网，钥匙也不出服务器
# 教程里用外部 cron 是因为作者部署在 Render（不访问就休眠），VPS 用不着。

set -uo pipefail
API_DIR=${API_DIR:-/root/chatnest-api}
PORT=${PORT:-3000}
TICK="$API_DIR/shadow-tick.sh"
LOG=${LOG:-/var/log/shadow-push.log}
MARK="# chatnest-shadow-push"

ok(){   printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){   printf '  \033[31m×\033[0m %s\n' "$*"; }
info(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){  printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }
ACTION=${1:-install}

cur_cron(){ crontab -l 2>/dev/null || true; }
# 写 crontab 一律走这个：先把新内容整个算出来，再一次性写进去。
# 千万别写成 `crontab -l | sed ... | crontab -` —— 那是一条管道，读和写同时启动，
# 写那端一开就把文件截断了，读那端可能读到空的，结果是把整个 crontab 清空。
# （测出来的：off 之后 crontab 空了，on 就说"还没装"。她机器上要是还有别的定时
#   任务，这一下全没。）
put_cron(){ printf '%s\n' "$1" | crontab -; }
has_cron(){ cur_cron | grep -qF -- "$MARK"; }
is_on(){ cur_cron | grep -F -- "$MARK" | grep -qv '^#'; }

case "$ACTION" in
  status)
    say "影子推送 cron"
    if ! has_cron; then no "还没装"; exit 0; fi
    is_on && ok "装着，而且开着" || info "装着，但暂停了（sudo bash $0 on 恢复）"
    cur_cron | grep -F -- "$MARK" | sed 's/^/      /'
    echo
    if [ -f "$LOG" ]; then
      info "最近 5 次："
      tail -5 "$LOG" | sed 's/^/      /'
    else
      info "还没有日志（装上之后每 10 分钟记一行）"
    fi
    exit 0 ;;
  log)
    [ -f "$LOG" ] || { no "还没有日志"; exit 0; }
    say "他最近想说话的时候（以及那些「不是现在」）"
    tail -40 "$LOG" | sed 's/^/  /'
    echo
    # grep -c 没匹配时会输出 0 并且返回非零；再 || echo 0 就成了两行 "0"。
    # 这个坑之前在救援脚本里踩过一次，这次又写出来了 —— 用 || true。
    info "说出口的：$(grep -c '· 说了' "$LOG" 2>/dev/null || true) 次"
    info "忍住的：  $(grep -c '· 没说' "$LOG" 2>/dev/null || true) 次"
    exit 0 ;;
  off)
    has_cron || { no "还没装"; exit 1; }
    put_cron "$(cur_cron | sed "\|$MARK|s|^|#|")"
    ok "暂停了。他不会主动找你了，等你说 on。"
    exit 0 ;;
  on)
    has_cron || { no "还没装"; exit 1; }
    put_cron "$(cur_cron | sed "\|$MARK|s|^#*||")"
    ok "恢复了。"
    exit 0 ;;
  remove)
    put_cron "$(cur_cron | grep -vF -- "$MARK" || true)"
    rm -f "$TICK"
    ok "卸干净了（日志留着：$LOG）"
    exit 0 ;;
  install) ;;
  *) no "不认识的动作：$ACTION（install / status / log / on / off / remove）"; exit 1 ;;
esac

say "1/4 检查"
[ -f "$API_DIR/server.js" ] || { no "找不到 $API_DIR/server.js"; exit 1; }
grep -qF 'SHADOW_PUSH_VERSION' "$API_DIR/server.js" || {
  no "后端还没打影子推送的补丁，先跑 apply-all.sh"; exit 1; }
ok "后端有影子推送"
grep -qE '^PUSH_TRIGGER_TOKEN=' "$API_DIR/.env" 2>/dev/null || {
  no "$API_DIR/.env 里没有 PUSH_TRIGGER_TOKEN，先跑 apply-all.sh"; exit 1; }
ok "钥匙在 .env 里"
command -v crontab >/dev/null 2>&1 || { no "这台机器没有 crontab（apt install cron）"; exit 1; }

say "2/4 写那个每 10 分钟跑一次的小脚本"
# 钥匙只在这个脚本里读，不写进 crontab —— crontab -l 谁都看得见
cat > "$TICK" <<TICKEOF
#!/usr/bin/env bash
# 每 10 分钟去问一句「现在该说话吗」。大部分时候答案是「不是现在」。
# 这个文件是 700，钥匙从 .env 现读，不落在 crontab 里。
set -uo pipefail
API_DIR="$API_DIR"
PORT="$PORT"
LOG="$LOG"

KEY=\$(grep -oP '(?<=^PUSH_TRIGGER_TOKEN=).*' "\$API_DIR/.env" 2>/dev/null | head -1)
[ -n "\${KEY:-}" ] || exit 0

RESP=\$(curl -s -m 300 -X POST "http://127.0.0.1:\$PORT/hook/shadow" \\
  -H 'Content-Type: application/json' -H "x-push-secret: \$KEY" -d '{}' 2>/dev/null)

# 日志太大就砍掉前半截，别把磁盘吃了
if [ -f "\$LOG" ] && [ "\$(stat -c%s "\$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -2000 "\$LOG" > "\$LOG.tmp" && mv "\$LOG.tmp" "\$LOG"
fi

TS=\$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M')
printf '%s' "\$RESP" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let r={};try{r=JSON.parse(s)}catch(e){r={why:"没解析出来: "+s.slice(0,80)}}
    if(r.pushed)console.log("· 说了："+String(r.text||"").slice(0,60));
    else console.log("· 没说（"+(r.why||r.error||"不知道为什么")+"）");
  });
' 2>/dev/null | sed "s|^|\$TS |" >> "\$LOG"
TICKEOF
chmod 700 "$TICK"
touch "$LOG"; chmod 640 "$LOG"
ok "写好了 $TICK（700，钥匙不落在 crontab 里）"

say "3/4 装进 crontab"
if has_cron; then
  info "之前装过，先摘掉旧的"
  put_cron "$(cur_cron | grep -vF -- "$MARK" || true)"
fi
put_cron "$(printf '%s\n%s' "$(cur_cron)" "*/10 * * * * $TICK $MARK" | sed '/^$/d')"
has_cron && ok "装好了，每 10 分钟一次" || { no "装 crontab 失败"; exit 1; }

say "4/4 立刻试一次（这次跳过决策层，他会真的说一句话）"
KEY=$(grep -oP '(?<=^PUSH_TRIGGER_TOKEN=).*' "$API_DIR/.env" | head -1)
RESP=$(curl -s -m 300 -X POST "http://127.0.0.1:$PORT/hook/shadow" \
  -H 'Content-Type: application/json' -H "x-push-secret: $KEY" -d '{"force":true}' 2>/dev/null)
printf '%s' "$RESP" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let r={};try{r=JSON.parse(s)}catch(e){console.log("  × 没解析出来："+s.slice(0,120));process.exit(0)}
    if(r.pushed){console.log("  √ 他说了：「"+(r.text||"")+"」");console.log("  · 推到了 "+((r.push&&r.push.sent)||0)+" 台设备");}
    else console.log("  × 这次没说："+(r.why||r.error||"不知道为什么"));
  });' 2>/dev/null

# 把自己搬到一个不会被清掉的地方 —— /tmp 系统会定期清，
# 过几天她想 off 却发现脚本没了，会一脸问号。
HOME_COPY="$API_DIR/shadow-cron.sh"
SELF=$(readlink -f "$0" 2>/dev/null || echo "$0")
if [ "$SELF" != "$HOME_COPY" ] && [ -f "$SELF" ]; then
  cp "$SELF" "$HOME_COPY" 2>/dev/null && chmod 700 "$HOME_COPY" \
    && ok "脚本也放了一份到 $HOME_COPY（/tmp 会被系统清掉，那份不保险）"
fi
CMD="sudo bash ${HOME_COPY}"
[ -f "$HOME_COPY" ] || CMD="sudo bash $SELF"

cat <<EOF

  ── 装好了 ──

  以后每 10 分钟他会问自己一次「现在该说话吗」。
  大部分时候答案是不是现在 —— 那些你不会知道。

  想看他这几天的动静：  $CMD log
  想让他安静一阵：      $CMD off
  再让他回来：          $CMD on

EOF
