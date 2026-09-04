#!/usr/bin/env bash
# 看清楚线上这份 server.js 到底怎么拼 CLI 的 prompt —— 只读，不改任何东西。
#   curl -fsSL -H 'Cache-Control: no-cache' \
#     "https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/diag-prompt.sh?cb=$(date +%s)" | sudo bash
set -uo pipefail

SRV=${SRV:-/root/chatnest-api/server.js}
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
[ -f "$SRV" ] || { echo "找不到 $SRV"; exit 1; }

say "1 这几个变量在哪儿定义"
grep -nE "^\s*(const|let|var)\s+(PERSONA|OB_TOOL_PROMPT|MOMENTS_TOOL_PROMPT|SYSTEM_PREFIX|MOMENTS_FILE)\s*=" "$SRV" \
  | cut -c1-120 | sed 's/^/  /'

say "2 谁在用它们（排除定义行）"
grep -nE "PERSONA|OB_TOOL_PROMPT|SYSTEM_PREFIX" "$SRV" \
  | grep -vE ":\s*(const|let|var)\s+(PERSONA|OB_TOOL_PROMPT|SYSTEM_PREFIX)\s*=" \
  | head -14 | cut -c1-150 | sed 's/^/  /'

say "3 prompt 是怎么攒出来的"
grep -nE "^\s*(let|const|var)\s+prompt\s*=|prompt\s*\+=|writeFileSync\(tmpFile" "$SRV" \
  | head -16 | cut -c1-150 | sed 's/^/  /'

say "4 CLI 那段的上下文（喂给 claude 之前）"
LN=$(grep -n "writeFileSync(tmpFile" "$SRV" | head -1 | cut -d: -f1)
if [ -n "${LN:-}" ]; then
  echo "  （writeFileSync 在第 $LN 行，往前 22 行）"
  sed -n "$((LN>22?LN-22:1)),${LN}p" "$SRV" | cut -c1-140 | sed 's/^/    /'
else
  echo "  找不到 writeFileSync(tmpFile"
fi

say "5 朋友圈那几样在不在"
for k in MOMENTS_FILE MOMENTS_TOOL_PROMPT runMomentsTool parseMomentsToolCalls; do
  printf '  %-24s %s\n' "$k" "$(grep -c "$k" "$SRV" 2>/dev/null || echo 0) 处"
done

echo
echo "  把第 2、3、4 节发回来就够了。"
echo
