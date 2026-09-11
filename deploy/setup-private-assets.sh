#!/usr/bin/env bash
# 让 VPS 能读私有仓库 cc-，然后把主题素材部署到线上。
#
#   第一步（生成钥匙）：  sudo bash setup-private-assets.sh
#   第二步（她去网页加钥匙，脚本会告诉她怎么加）
#   第三步（拉素材上线）：sudo bash setup-private-assets.sh --deploy
#
# 为什么要这一套：
#   「纸与蕾丝」的装饰件标着 PERSONAL USE ONLY，不能进公开的 chatnest-ui。
#   所以它们放在私有仓库 cc-/theme-assets/。VPS 上没有任何 GitHub 凭据，
#   拉不到 —— 这个脚本就是补上那把钥匙。
#
# 用 Deploy Key 不用 Personal Access Token：
#   Deploy Key 只对一个仓库有效、只读、随时能在网页上删掉。
#   PAT 是账号级的，一把钥匙开所有仓库的门，给服务器用太重了。
#
# ⚠ 配好之后有一条千万别做：不要顺手打开 install-autodeploy.sh 的 WITH_BACKEND。
#   以前后端自动部署是靠「VPS 拉不到 cc-」挡着的。钥匙配好之后那道天然屏障就没了。
#   deploy.sh 的后端段会拿 cc- 里的 chatnest-api/server.js 直接覆盖线上那份 ——
#   线上那份是 deploy/ 下二十多个补丁堆出来的，不是同一条线，一覆盖补丁全没。
#   它的健康检查也救不了：老版本照样能通过 /api/health，判成功、不回滚。
#   要开，得先把补丁体系并进仓库让两边一致。

set -uo pipefail

REPO_SSH="git@github.com-ccprivate:2082724914yi/cc-.git"
KEY=/root/.ssh/cc_deploy
CLONE=/opt/chatnest-private
WEBROOT=${WEBROOT:-/var/www/chatnest}
DEST="$WEBROOT/assets/theme"

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }

# ── 一、钥匙 ──────────────────────────────────────────
mkdir -p /root/.ssh && chmod 700 /root/.ssh
if [ -f "$KEY" ]; then
  ok "钥匙已经有了（$KEY），不重新生成"
else
  ssh-keygen -t ed25519 -f "$KEY" -N '' -C "chatnest-vps-readonly" >/dev/null
  chmod 600 "$KEY"
  ok "生成了一把新钥匙"
fi

# ssh config：给这个仓库单独起一个别名，不影响机器上别的 git 操作
if ! grep -q 'Host github.com-ccprivate' /root/.ssh/config 2>/dev/null; then
  cat >> /root/.ssh/config <<EOF

Host github.com-ccprivate
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
EOF
  chmod 600 /root/.ssh/config
  ok "ssh 配置写好了"
else
  ok "ssh 配置已经有了"
fi
ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null
sort -u /root/.ssh/known_hosts -o /root/.ssh/known_hosts

# ── 二、没带 --deploy 就停在这儿，把公钥打出来 ────────────
if [ "${1:-}" != "--deploy" ]; then
  say "下一步：把这把公钥加到 GitHub（只读）"
  cat <<EOF

  1. 复制下面这一整行（从 ssh-ed25519 开始，到最后）：

EOF
  printf '\033[36m'; cat "$KEY.pub"; printf '\033[0m'
  cat <<'EOF'

  2. 浏览器打开：
     https://github.com/2082724914yi/cc-/settings/keys

  3. 点 "Add deploy key"
       Title 随便写，比如   chatnest-vps
       Key   粘贴刚才复制的那一整行
       ⚠ "Allow write access" 不要勾 —— 只给读，不给写

  4. 加完回来跑第三步：

       sudo bash /tmp/setup-private-assets.sh --deploy

EOF
  exit 0
fi

# ── 三、验证 + 拉取 + 部署 ─────────────────────────────
say "1/3 试试能不能读到私有仓库"
if ! GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
     git ls-remote "$REPO_SSH" -h refs/heads/main >/dev/null 2>&1; then
  no "还读不到。八成是公钥还没加上去，或者加的时候少复制了一截。"
  echo "     公钥再打一遍："
  printf '\033[36m'; cat "$KEY.pub"; printf '\033[0m'
  echo "     加在这里：https://github.com/2082724914yi/cc-/settings/keys"
  exit 1
fi
ok "读得到"

say "2/3 拉素材"
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes"
if [ -d "$CLONE/.git" ]; then
  git -C "$CLONE" fetch -q origin main && git -C "$CLONE" reset -q --hard origin/main || { no "更新失败"; exit 1; }
  ok "更新到最新"
else
  rm -rf "$CLONE"
  git clone -q --depth 1 --filter=blob:none --sparse "$REPO_SSH" "$CLONE" || { no "clone 失败"; exit 1; }
  git -C "$CLONE" sparse-checkout set theme-assets   # 只要素材那个目录，不拉整个仓库
  ok "clone 好了（只取 theme-assets 一个目录）"
fi

N=$(find "$CLONE/theme-assets" -name '*.webp' 2>/dev/null | wc -l)
[ "$N" -gt 0 ] || { no "theme-assets 里一个 .webp 都没有？"; exit 1; }
ok "找到 $N 个素材"

say "3/3 部署到线上"
[ -d "$WEBROOT" ] || { no "找不到 $WEBROOT，前端不在这儿？用 WEBROOT=... 指一下"; exit 1; }
mkdir -p "$DEST"
cp -f "$CLONE"/theme-assets/*.webp "$DEST/"
chmod 644 "$DEST"/*.webp
# 跟前端静态目录的属主保持一致，nginx 才读得到
OWNER=$(stat -c '%U:%G' "$WEBROOT")
chown -R "$OWNER" "$DEST" 2>/dev/null || true
ok "$N 个文件已放到 $DEST"

echo
echo "  验一下（应该是 200）："
echo "    curl -s -o /dev/null -w '%{http_code}\\n' https://xiaoyixiaoyan.top/assets/theme/ribbon.webp"
echo
echo "  以后我往 cc-/theme-assets/ 加了新素材，你只要再跑一次："
echo "    sudo bash /tmp/setup-private-assets.sh --deploy"
echo
