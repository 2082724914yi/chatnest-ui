#!/usr/bin/env bash
# ChatNest 自动部署安装器 —— 在 VPS 上跑一次即可。
#   bash install-autodeploy.sh
# 之后每 2 分钟自动检查 GitHub，有新提交就部署，不用再手动上服务器。
#
# 设计原则：宁可不部署，也不能把正在跑的服务搞挂。
#   · 后端更新前先 node -c 语法检查，不过就跳过
#   · 部署前备份，重启后做健康检查，起不来自动回滚
#   · 内容没变就不动，不做无谓重启
#   · 重复跑安装器是安全的
set -euo pipefail

DEPLOY_DIR=/opt/chatnest-deploy
WEB_ROOT=/var/www/chatnest
API_DIR=/root/chatnest-api
PORT=3000
UI_REPO=https://github.com/2082724914yi/chatnest-ui.git
API_REPO=https://github.com/2082724914yi/cc-.git

say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
die(){ printf '\n\033[31m×\033[0m %s\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "请用 root 跑：sudo bash $0"

say "1/5 检查依赖"
for c in git node curl; do
  command -v "$c" >/dev/null || die "缺少 $c，先装上再来"
  ok "$c $($c --version 2>&1 | head -1)"
done

say "2/5 准备 git 工作区（$DEPLOY_DIR）"
mkdir -p "$DEPLOY_DIR"
clone_or_update(){ # $1=url $2=目录名
  local url=$1 dir="$DEPLOY_DIR/$2"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" remote set-url origin "$url"
    ok "$2 已存在"
  else
    say "  正在 clone $2 ..."
    if ! git clone --depth 20 "$url" "$dir" 2>&1 | sed 's/^/    /'; then
      die "clone $2 失败。私有仓库需要凭据，在服务器上跑一次：
    git config --global credential.helper store
    git clone $url /tmp/_probe
  按提示输入 GitHub 用户名和 personal access token（不是登录密码），
  成功后删掉 /tmp/_probe 再重新跑本脚本。"
    fi
    ok "$2 clone 完成"
  fi
}
clone_or_update "$UI_REPO" chatnest-ui
clone_or_update "$API_REPO" cc-

say "3/5 对齐仓库与线上后端"
LIVE_SRV="$API_DIR/server.js"
REPO_SRV="$DEPLOY_DIR/cc-/chatnest-api/server.js"
if [ ! -f "$LIVE_SRV" ]; then
  warn "$LIVE_SRV 不存在，跳过后端对齐（本机可能只跑前端）"
elif cmp -s "$LIVE_SRV" "$REPO_SRV"; then
  ok "线上后端已与仓库一致"
elif ! grep -q -- '--include-partial-messages' "$LIVE_SRV"; then
  die "线上 server.js 还没打补丁。
  自动部署一旦启用，会用仓库版本覆盖线上版本；而线上这份和仓库不是同一条线，
  直接覆盖会丢东西。请先打补丁，再回来跑本脚本：

    node $DEPLOY_DIR/cc-/chatnest-api/patch-server.js $LIVE_SRV

  打完补丁重启后端确认能用，然后重新执行本安装器。"
else
  warn "线上 server.js 已打补丁但与仓库不同 —— 以线上为准，收编进仓库"
  cp "$LIVE_SRV" "$REPO_SRV"
  git -C "$DEPLOY_DIR/cc-" config user.email "deploy@chatnest.local"
  git -C "$DEPLOY_DIR/cc-" config user.name "chatnest-deploy"
  git -C "$DEPLOY_DIR/cc-" add chatnest-api/server.js
  if git -C "$DEPLOY_DIR/cc-" commit -q -m "chore: adopt live server.js as deploy baseline" 2>/dev/null; then
    if git -C "$DEPLOY_DIR/cc-" push -q origin HEAD 2>/dev/null; then
      ok "线上版本已提交并推回仓库，两边现在一致"
    else
      warn "提交成功但 push 失败（凭据没有写权限）；本地基线已对齐，不影响部署"
    fi
  fi
fi

say "4/5 写入部署脚本"
cat > "$DEPLOY_DIR/deploy.sh" <<'DEPLOY_EOF'
#!/usr/bin/env bash
# 每 2 分钟由 systemd timer 调用。只在有新提交时才动手。
set -uo pipefail

DEPLOY_DIR=${DEPLOY_DIR:-/opt/chatnest-deploy}
WEB_ROOT=${WEB_ROOT:-/var/www/chatnest}
API_DIR=${API_DIR:-/root/chatnest-api}
PORT=${PORT:-3000}
LOG=${LOG:-/var/log/chatnest-deploy.log}
API_LOG=${API_LOG:-/var/log/chatnest-api.log}
LOCKFILE=${LOCKFILE:-/var/lock/chatnest-deploy.lock}

log(){ printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

# 同一时间只允许一个部署在跑
exec 9>"$LOCKFILE"
flock -n 9 || exit 0

health(){ curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }

# 找出正在跑的后端 pid。ss 常因权限/格式拿不到，所以多重兜底；
# 最后一层按 cwd 匹配，避免误杀机器上别的 node 进程。
find_backend_pid(){
  local p cand
  p=$(ss -lptnH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  [ -n "${p:-}" ] && { echo "$p"; return 0; }
  p=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
  [ -n "${p:-}" ] && { echo "$p"; return 0; }
  for cand in $(pgrep -f 'node .*server\.js' 2>/dev/null); do
    if [ "$(readlink -f "/proc/$cand/cwd" 2>/dev/null)" = "$(readlink -f "$API_DIR")" ]; then
      echo "$cand"; return 0
    fi
  done
  return 1
}

OLD_PID=""
restart_backend(){
  OLD_PID=$(find_backend_pid || true)
  if command -v pm2 >/dev/null 2>&1 && pm2 pid chatnest >/dev/null 2>&1; then
    pm2 restart chatnest >/dev/null 2>&1 && { log "pm2 重启"; return 0; }
  fi
  for svc in chatnest chatnest-api; do
    if systemctl list-unit-files 2>/dev/null | grep -q "^$svc.service"; then
      systemctl restart "$svc" && { log "systemctl 重启 $svc"; return 0; }
    fi
  done
  # 兜底手动重启：先把旧进程确实杀掉，端口不放开新进程根本起不来
  local envfile; envfile=$(mktemp)
  if [ -n "$OLD_PID" ]; then
    # 继承旧进程的环境变量，否则 OMBRE_MCP_TOKEN 这类会丢
    [ -r "/proc/$OLD_PID/environ" ] && tr '\0' '\n' < "/proc/$OLD_PID/environ" > "$envfile" 2>/dev/null
    kill "$OLD_PID" 2>/dev/null
    local i
    for i in $(seq 1 10); do sleep 0.5; kill -0 "$OLD_PID" 2>/dev/null || break; done
    if kill -0 "$OLD_PID" 2>/dev/null; then kill -9 "$OLD_PID" 2>/dev/null; sleep 1; fi
  fi
  (
    cd "$API_DIR" || exit 1
    # 关键：不能让后端继承部署锁的文件描述符。继承了的话它会一直攥着锁，
    # 之后每一轮 flock 都拿不到，自动部署从此静默失效。
    exec 9>&-
    if [ -s "$envfile" ]; then
      while IFS= read -r l; do
        case "$l" in [A-Za-z_]*=*) export "$l" 2>/dev/null || true ;; esac
      done < "$envfile"
    fi
    nohup node server.js >> "$API_LOG" 2>&1 &
  )
  rm -f "$envfile"
  log "手动重启（旧 pid ${OLD_PID:-无}）"
}

deploy_repo(){ # $1=目录名
  local dir="$DEPLOY_DIR/$1"
  git -C "$dir" fetch -q origin 2>/dev/null || { log "$1 fetch 失败（网络？），跳过本轮"; return 1; }
  local local_sha remote_sha
  local_sha=$(git -C "$dir" rev-parse HEAD)
  remote_sha=$(git -C "$dir" rev-parse origin/HEAD 2>/dev/null || git -C "$dir" rev-parse origin/main)
  [ "$local_sha" = "$remote_sha" ] && return 1     # 没新提交
  git -C "$dir" reset -q --hard "$remote_sha" || { log "$1 reset 失败"; return 1; }
  log "$1 更新到 ${remote_sha:0:8}"
  return 0
}

changed=0

# ---- 前端 ----
if deploy_repo chatnest-ui; then
  NEW="$DEPLOY_DIR/chatnest-ui/index.html"
  CUR="$WEB_ROOT/index.html"
  if [ ! -s "$NEW" ]; then
    log "前端 index.html 为空，跳过"
  elif ! grep -qi '</html>' "$NEW"; then
    log "前端 index.html 不完整（没有闭合标签），跳过"
  elif cmp -s "$NEW" "$CUR" 2>/dev/null; then
    log "前端内容无变化"
  else
    mkdir -p "$WEB_ROOT"
    [ -f "$CUR" ] && cp "$CUR" "$CUR.bak"
    cp "$NEW" "$CUR"
    log "前端已部署 ($(wc -c < "$CUR") 字节)"
    changed=1
  fi
fi

# ---- 后端 ----
if deploy_repo cc-; then
  NEW="$DEPLOY_DIR/cc-/chatnest-api/server.js"
  CUR="$API_DIR/server.js"
  if [ ! -s "$NEW" ]; then
    log "后端 server.js 为空，跳过"
  elif ! node -c "$NEW" 2>/dev/null; then
    log "后端 server.js 语法检查不通过，拒绝部署"
  elif cmp -s "$NEW" "$CUR" 2>/dev/null; then
    log "后端内容无变化"
  else
    BAK="$CUR.bak-$(date +%s)"
    cp "$CUR" "$BAK"
    cp "$NEW" "$CUR"
    restart_backend
    # 光看健康检查会被"旧进程还活着"骗过去：端口没释放时新进程起不来，
    # 但请求照样有人应答，于是日志写成功、代码其实没生效。所以还要确认换了进程。
    okflag=0
    for _ in $(seq 1 15); do
      sleep 1
      health || continue
      NOW_PID=$(find_backend_pid || true)
      if [ -z "$OLD_PID" ] || [ -z "$NOW_PID" ] || [ "$NOW_PID" != "$OLD_PID" ]; then okflag=1; break; fi
    done
    if [ "$okflag" = 1 ]; then
      if [ -n "$OLD_PID" ] && [ -z "${NOW_PID:-}" ]; then
        log "后端已部署并通过健康检查（无法读取进程号，未能验证进程已更换）"
      else
        log "后端已部署并通过健康检查（进程 ${OLD_PID:-无} → ${NOW_PID:-?}）"
      fi
      changed=1
      ls -1t "$CUR".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
    else
      log "健康检查失败，回滚到 $BAK"
      cp "$BAK" "$CUR"
      restart_backend
      sleep 3
      health && log "回滚成功，服务已恢复" || log "回滚后仍不健康，需要人工介入"
    fi
  fi
fi

[ "$changed" = 1 ] && log "—— 本轮部署完成 ——"
exit 0
DEPLOY_EOF
chmod +x "$DEPLOY_DIR/deploy.sh"
touch /var/log/chatnest-deploy.log
ok "已写入 $DEPLOY_DIR/deploy.sh"

say "5/5 安装定时器（每 2 分钟）"
cat > /etc/systemd/system/chatnest-deploy.service <<EOF
[Unit]
Description=ChatNest 自动部署
After=network-online.target

[Service]
Type=oneshot
ExecStart=$DEPLOY_DIR/deploy.sh
EOF
cat > /etc/systemd/system/chatnest-deploy.timer <<EOF
[Unit]
Description=每 2 分钟检查一次 ChatNest 更新

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now chatnest-deploy.timer >/dev/null 2>&1
ok "定时器已启用"

say "立即跑一次"
"$DEPLOY_DIR/deploy.sh" || true
tail -n 20 /var/log/chatnest-deploy.log 2>/dev/null | sed 's/^/  /' || true

cat <<EOF

$(printf '\033[1m装好了。\033[0m')

  以后我推代码到 GitHub，最多 2 分钟自动上线，你什么都不用做。

  看日志：      tail -f /var/log/chatnest-deploy.log
  看定时器：    systemctl list-timers chatnest-deploy
  立刻部署一次：$DEPLOY_DIR/deploy.sh
  暂停自动部署：systemctl disable --now chatnest-deploy.timer

  出问题会自己回滚，回滚不了才会停在那儿等人 —— 日志里会写清楚是哪一步。

EOF
