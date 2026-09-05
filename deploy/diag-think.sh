#!/usr/bin/env bash
# 把 THINK_PROMPT 原样打出来 —— 只读，不改。
#   curl -fsSL .../deploy/diag-think.sh | sudo bash
#
# 她说 think process 写得不对：现在出来的是「她说对呀，确认了那条…」「让我自然地
# 跟她聊这些内容」—— 那是任务复述加自我指导，不是内心活动。没有人心里会这么想。
#
# 要改就得先看现在写的什么。整个替换有风险：万一原文里有 <think> 标签的格式约定、
# 或者跟别的补丁配合的约定，一刀切掉就坏了。所以先原样看一遍。
#
# 提示词里不该有钥匙，但还是逐行过一道：带 token/secret/password/key 的行顶掉。

set -uo pipefail
API_DIR=${API_DIR:-/root/chatnest-api}
SRV="$API_DIR/server.js"
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
info(){ printf '  \033[90m·\033[0m %s\n' "$*"; }

[ -f "$SRV" ] || { echo "找不到 $SRV"; exit 1; }

# 从某一行开始，扫到那个字符串字面量结束为止（模板字符串会跨很多行）
dump_const(){ # dump_const 变量名
  local name="$1"
  local start
  start=$(grep -nE "(const|let|var)[[:space:]]+${name}[[:space:]]*=" "$SRV" | head -1 | cut -d: -f1)
  if [ -z "${start:-}" ]; then info "找不到 $name"; return; fi
  say "$name（第 $start 行起）"
  node - "$SRV" "$start" <<'NODEEOF'
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const lines = src.split('\n');
const start = parseInt(process.argv[3], 10) - 1;
// 找到 = 之后第一个引号，扫到配对的那个
let i = src.split('\n').slice(0, start).join('\n').length + (start ? 1 : 0);
const from = src.indexOf('=', i) + 1;
let j = from;
while (j < src.length && /\s/.test(src[j])) j++;
const q = src[j];
let end = src.length;
if (q === '`' || q === "'" || q === '"') {
  for (let k = j + 1; k < src.length; k++) {
    if (src[k] === '\\') { k++; continue; }
    if (src[k] === q) { end = k + 1; break; }
  }
} else { end = src.indexOf('\n', j); }
const body = src.slice(j, end);
const shown = body.split('\n');
console.log('  ── 共 ' + shown.length + ' 行，' + body.length + ' 字符 ──');
shown.forEach((l, n) => {
  const low = l.toLowerCase();
  if (/token|secret|password|api_?key|vapid/.test(low)) console.log('    [已隐去]');
  else console.log('    ' + l.slice(0, 200));
});
NODEEOF
}

dump_const THINK_PROMPT

say "它被拼进哪几处"
grep -n 'THINK_PROMPT' "$SRV" | grep -v '(const|let|var)' | head -6 | while IFS=: read -r n _; do
  printf '    %s: %s\n' "$n" "$(sed -n "${n}p" "$SRV" | sed 's/[[:space:]]\+/ /g' | cut -c1-170)"
done

say "跟思考有关的其它设定"
for v in MAX_THINKING_TOKENS THINK_TAG thinkState; do
  c=$(grep -c -- "$v" "$SRV" 2>/dev/null || true)
  [ "${c:-0}" != 0 ] && info "$v → ${c} 处"
done

say "跑完了。整段贴给我 —— 这是提示词，没有钥匙也没有聊天内容。"
