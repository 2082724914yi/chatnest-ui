#!/usr/bin/env bash
# 聊天里的图为什么会消失 —— 只看，不改任何东西。
#   curl -fsSL .../deploy/diag-images.sh | sudo bash
#
# 只打印结构（字段名、路径形状、文件在不在），不打印聊天正文，也不打印任何 token。

set -uo pipefail
API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
PORT=${PORT:-3000}

ok(){   printf '  \033[32m√\033[0m %s\n' "$*"; }
no(){   printf '  \033[31m×\033[0m %s\n' "$*"; }
info(){ printf '  \033[90m·\033[0m %s\n' "$*"; }
say(){  printf '\n\033[1m%s\033[0m\n' "$*"; }

[ -f "$SRV" ] || { no "找不到 $SRV"; exit 1; }

say "1/5 后端有没有把附件存进历史"
for pat in "attachments" "req.body.attachments" "describeAttachments"; do
  c=$(grep -c -- "$pat" "$SRV" 2>/dev/null || true)
  info "server.js 里出现 '$pat' ： ${c:-0} 次"
done
# 存历史那一下有没有带上 attachments
if grep -nE "role:\s*'user'|role:\s*\"user\"" "$SRV" | head -5 | grep -q .; then
  say "   存 user 消息的那几行（只显示字段，不显示内容）"
  grep -nE "role:\s*['\"]user['\"]" "$SRV" | head -5 | while IFS= read -r l; do
    n=${l%%:*}
    sed -n "${n}p" "$SRV" | sed 's/[[:space:]]\+/ /g' | cut -c1-200 | sed 's/^/      /'
    if sed -n "${n}p" "$SRV" | grep -q attachments; then
      ok "第 $n 行：存了 attachments"
    else
      no "第 $n 行：这一行没带 attachments —— 附件可能根本没进历史"
    fi
  done
fi

say "2/5 uploads 目录"
UP="$API_DIR/uploads"
if [ -d "$UP" ]; then
  n=$(find "$UP" -type f 2>/dev/null | wc -l)
  ok "有 uploads 目录，里面 $n 个文件"
  info "最近 3 个（只看文件名和大小）："
  find "$UP" -type f -printf '%T@ %s %p\n' 2>/dev/null | sort -rn | head -3 |
    while read -r _ sz path; do info "   ${sz} 字节  ${path#$API_DIR/}"; done
else
  no "没有 uploads 目录 —— 图根本没存下来"
fi

say "3/5 会话文件里那条带图的消息长什么样"
# 找最近改动的会话 JSON，把带 attachments 的消息的「结构」打出来
CONV=$(find "$API_DIR" -maxdepth 3 -name '*.json' -newermt '-14 days' \
        -not -path '*/keepsake/*' -not -name 'auth-tokens.json' -not -name 'eventide-state.json' \
        -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -8 | cut -d' ' -f2-)
FOUND=0
for f in $CONV; do
  node -e '
    const fs=require("fs");
    let d; try{d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(e){process.exit(3)}
    const msgs=Array.isArray(d)?d:(d.messages||d.turns||[]);
    if(!Array.isArray(msgs)||!msgs.length)process.exit(3);
    const hit=msgs.filter(m=>m&&m.attachments&&m.attachments.length);
    if(!hit.length)process.exit(3);
    const m=hit[hit.length-1];
    const shape=(m.attachments||[]).map(a=>typeof a==="string"
      ? {存成:"裸字符串", 样子:String(a).slice(0,60)}
      : {存成:"对象", 有哪些字段:Object.keys(a), path:String(a.path||"").slice(0,60), is_image:a.is_image});
    console.log("      文件: "+process.argv[1].split("/").pop());
    console.log("      这条消息带了 "+m.attachments.length+" 个附件，存的形状：");
    console.log("      "+JSON.stringify(shape));
    process.exit(0);
  ' "$f" && { FOUND=1; ok "找到了带附件的历史消息（结构见上）"; break; }
done
[ "$FOUND" = 1 ] || no "最近的会话文件里，一条带 attachments 的消息都没有 —— 附件没被写进历史"

say "4/5 取图那条路由通不通"
FIRST=$(find "$UP" -type f -name '*.jpg' -o -type f -name '*.png' -o -type f -name '*.jpeg' 2>/dev/null | head -1)
if [ -n "${FIRST:-}" ]; then
  REL=${FIRST#$API_DIR/}
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "http://127.0.0.1:$PORT/api/$REL" || echo 000)
  info "GET /api/$REL  →  $code"
  case "$code" in
    200) ok "不带任何凭证就能取到图（说明这条路由在认证之前）";;
    401|403) info "需要凭证才能取 —— 前端是带着凭证 fetch 的，正常";;
    404) no "404：路由对不上，这就是图显示不出来的原因";;
    *)   no "拿到 $code，不对劲";;
  esac
else
  info "uploads 里没有图片文件，跳过"
fi

say "5/5 前端那份是不是最新的"
WEB=$(find / -name 'index.html' -path '*chatnest*' -o -path '/var/www/*' -name 'index.html' 2>/dev/null | head -3)
for w in $WEB; do
  if grep -q 'storedImageUrl' "$w" 2>/dev/null; then
    ok "${w}：有 storedImageUrl（修过的版本）"
  else
    no "${w}：没有 storedImageUrl —— 这份前端是旧的，重跑一遍 deploy-frontend.sh"
  fi
done

say "跑完了。把上面整段贴给我就行 —— 里面没有聊天内容，也没有 token。"
