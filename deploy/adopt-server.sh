#!/usr/bin/env bash
# 把服务器上真实的 server.js 收编进 cc- 仓库，让"仓库里的"和"跑着的"变成同一份。
#
# 为什么要做这个：今天的 cotState 事故，根源是我改补丁时拿仓库那份当基线，
# 而它和线上那份根本不是一个东西 —— 沙箱验证全是在验一个不存在的形状。
# 收编之后，补丁基线就是真的，同类事故不会再来。
#
#   curl -fsSL .../deploy/adopt-server.sh | sudo bash
#
# cc- 是私有仓库，需要 GitHub 凭据。没配过的话脚本会告诉你怎么配，不会瞎试。
set -uo pipefail

API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
WORK=${WORK:-/opt/chatnest-adopt}
REPO=https://github.com/2082724914yi/cc-.git

ok(){ printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){ printf '  \033[31m×\033[0m %s\n' "$*"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { no "要用 sudo 跑"; exit 1; }
[ -f "$SRV" ] || { no "找不到 $SRV"; exit 1; }
command -v git >/dev/null || { no "没装 git"; exit 1; }

say "1/4 检查 server.js"
node -c "$SRV" 2>/dev/null && ok "语法没问题（$(wc -c < "$SRV") 字节）" || { no "语法有错，先别收编"; exit 1; }
for k in '--include-partial-messages:流式' 'PROFILE_FILE:记忆落盘' 'rememberIntoProfile:双向同步' '_cotSafe:cotState热修'; do
  key=${k%%:*}; name=${k#*:}
  grep -q -- "$key" "$SRV" && ok "$name" || printf '  \033[33m!\033[0m %s（没有，收编的是没打这个补丁的版本）\n' "$name"
done

say "2/4 准备仓库"
if [ -d "$WORK/.git" ]; then
  git -C "$WORK" fetch -q origin 2>/dev/null && git -C "$WORK" reset -q --hard origin/main 2>/dev/null
  ok "已有本地仓库，已更新到最新"
else
  rm -rf "$WORK"
  if git clone -q --depth 5 "$REPO" "$WORK" 2>/dev/null; then
    ok "clone 成功"
  else
    no "clone 失败 —— cc- 是私有仓库，需要凭据"
    cat <<'EOF'

  在服务器上做一次就行（以后都不用再弄）：

    1) 去 GitHub 生成一个 token：
       https://github.com/settings/tokens/new
       勾选 repo 权限，有效期随便选，生成后复制那串 ghp_ 开头的字符

    2) 在服务器上执行：
       git config --global credential.helper store
       git clone https://github.com/2082724914yi/cc-.git /tmp/_probe
       （提示 Username 输 2082724914yi，Password 粘贴那串 token）

    3) 成功后删掉探针，重新跑本脚本：
       rm -rf /tmp/_probe

EOF
    exit 1
  fi
fi

say "3/4 对比差异"
TARGET="$WORK/chatnest-api/server.js"
mkdir -p "$(dirname "$TARGET")"
if [ -f "$TARGET" ] && cmp -s "$SRV" "$TARGET"; then
  ok "仓库里已经是这一份，无需收编"
  exit 0
fi
if [ -f "$TARGET" ]; then
  echo "  仓库版: $(wc -c < "$TARGET") 字节 / $(wc -l < "$TARGET") 行"
  echo "  线上版: $(wc -c < "$SRV") 字节 / $(wc -l < "$SRV") 行"
  echo "  差异行数: $(diff "$TARGET" "$SRV" 2>/dev/null | grep -c '^[<>]')"
else
  echo "  仓库里还没有这个文件"
fi
cp "$SRV" "$TARGET"

say "4/4 提交并推送"
cd "$WORK" || exit 1
git config user.email "deploy@chatnest.local"
git config user.name "chatnest-server"
git add chatnest-api/server.js
if git diff --cached --quiet; then
  ok "没有实际改动"
  exit 0
fi
git commit -q -m "chore: adopt the server.js actually running in production

Taken from $API_DIR on $(hostname). The repo copy had drifted from the
running file, which is how a patch came to reference a variable that only
existed in the repo version. Future patches are based on this."
if git push -q origin HEAD 2>/dev/null; then
  ok "已推送 —— 仓库和线上现在是同一份了"
else
  no "推送失败（凭据可能只有读权限）"
  echo "  已提交到本地：$WORK"
  echo "  可以手动推：cd $WORK && git push origin HEAD"
  exit 1
fi

cat <<EOF

$(printf '\033[1m收编完成。\033[0m')

  以后我改补丁，基线就是你服务器上真正跑的这一份，
  不会再出现"沙箱验过了但线上崩"这种事。

EOF
