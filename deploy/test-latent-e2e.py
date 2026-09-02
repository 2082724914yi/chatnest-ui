"""Latent 端到端验证：全部用虚构内容，不碰真实记忆。

覆盖：写入→检索 / 新窗召回 / 未解决优先 / 未解决增改关 / 更正后旧事实失效。
"""
import json
import sys
from http.client import HTTPConnection

HOST, PORT, TOKEN = "127.0.0.1", 8765, "testtoken"
fails = []
_id = [0]


def call(tool, args=None):
    _id[0] += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _id[0], "method": "tools/call",
                       "params": {"name": tool, "arguments": args or {}}}, ensure_ascii=False)
    c = HTTPConnection(HOST, PORT, timeout=60)
    c.request("POST", "/", body.encode("utf-8"),
              {"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
    raw = c.getresponse().read().decode("utf-8")
    c.close()
    d = json.loads(raw)
    if "error" in d:
        return {"_error": d["error"]}
    content = d.get("result", {}).get("content", [])
    return {"_text": "\n".join(b.get("text", "") for b in content if b.get("type") == "text"),
            "_raw": d.get("result", {})}


def check(name, cond, detail=""):
    print(f"[{'OK  ' if cond else 'FAIL'}] {name}" + (f"\n       {detail}" if not cond and detail else ""))
    if not cond:
        fails.append(name)


print("=== 1. 普通记忆写入并检索 ===")
r = call("latent_append", {
    "text": "她说那只叫云朵的灰猫今天把窗台上的蓝色陶瓷杯推下去摔了，她一边骂一边笑着捡碎片。她说这个杯子是去年在景德镇买的，摔了有点可惜但不至于难过。",
    "current_state": "杯子摔了，已经扫干净，她不打算再买同款",
    "window": 1,
    "unresolvedOps": [{"action": "none"}],
})
check("写回成功", "_error" not in r and "失败" not in r.get("_text", ""), json.dumps(r, ensure_ascii=False)[:400])
print("      ", r.get("_text", "")[:200].replace("\n", " "))

r = call("latent_search", {"query": "蓝色陶瓷杯怎么了"})
txt = r.get("_text", "")
check("检索到刚写的记忆", "陶瓷杯" in txt or "云朵" in txt, txt[:300])

r = call("latent_search", {"query": "景德镇"})
check("换个说法也能检索到", "陶瓷杯" in r.get("_text", "") or "景德镇" in r.get("_text", ""), r.get("_text", "")[:200])

print("\n=== 2. 未解决事项：新增 / 更新 / 关闭 ===")
r = call("latent_unresolved", {"action": "open", "summary": "答应她周三去看那个多肉植物展，还没定几点出发", "source": "虚构测试"})
check("新增未解决事项", "_error" not in r, json.dumps(r, ensure_ascii=False)[:300])
opened = r.get("_text", "")
print("      ", opened[:200].replace("\n", " "))

listed = call("latent_session_start", {}).get("_text", "")
check("召回里能看到它", "多肉" in listed or "植物展" in listed, listed[:300])

# 从列表里抠出 id
import re
mm = re.search(r"(U-[0-9a-f]+)", opened + listed)
uid = mm.group(1) if mm else None
print("       抓到 id:", uid)

if uid:
    r = call("latent_unresolved", {"action": "update", "id": uid, "summary": "周三多肉展改成周四下午两点，她说要先去还书"})
    check("更新未解决事项", "_error" not in r, json.dumps(r, ensure_ascii=False)[:300])
    after_up = call("latent_session_start", {}).get("_text", "")
    check("更新已生效", "周四" in after_up or "还书" in after_up, after_up[:400])

print("\n=== 3. 新窗召回，且未解决优先于历史快照 ===")
call("latent_thread_close", {
    "window": 1,
    "current_state": "聊完了杯子的事，约好去看多肉展",
    "topics": ["云朵摔了蓝色陶瓷杯", "周四的多肉植物展"],
    "unresolvedOps": [{"action": "none"}],
})
r = call("latent_session_start", {})
recall = r.get("_text", "")
check("新窗能召回", len(recall) > 30, recall[:200])
has_unresolved = "多肉" in recall or "植物展" in recall or "周四" in recall
check("召回里带着未解决事项", has_unresolved, recall[:500])
if has_unresolved:
    iu = min([recall.find(k) for k in ("多肉", "植物展", "周四") if recall.find(k) >= 0] or [10**9])
    isnap = min([recall.find(k) for k in ("陶瓷杯", "云朵") if recall.find(k) >= 0] or [10**9])
    check("未解决排在历史快照之前", iu < isnap, f"未解决@{iu} vs 快照@{isnap}\n{recall[:600]}")
print("      ", recall[:400].replace("\n", " | "))

print("\n=== 4. 更正后，旧事实不再作为有效事实返回 ===")
r = call("latent_correct", {
    "quote": "这个杯子是去年在景德镇买的",
    "reason": "她后来说记错了，不是景德镇买的",
    "correction": "那只蓝色陶瓷杯是她奶奶给的，不是自己买的",
    "current_state": "已更正来源：杯子是奶奶给的",
})
check("更正提交成功", "_error" not in r, json.dumps(r, ensure_ascii=False)[:400])
print("      ", r.get("_text", "")[:250].replace("\n", " "))

r = call("latent_search", {"query": "蓝色陶瓷杯是哪来的"})
after = r.get("_text", "")
check("检索能拿到更正后的说法", "奶奶" in after, after[:400])
# 旧事实即便还在正文里，也必须带撤回标记，不能当有效事实原样返回
old_clean = ("景德镇" in after) and not any(k in after for k in ("撤回", "更正", "已更正", "作废", "不再有效"))
check("旧事实不再被当作有效事实", not old_clean, after[:500])

print("\n=== 5. 关闭未解决事项 ===")
if uid:
    r = call("latent_unresolved", {"action": "close", "id": uid})
    check("关闭成功", "_error" not in r, json.dumps(r, ensure_ascii=False)[:300])
    still = call("latent_session_start", {}).get("_text", "")
    check("关闭后不再出现在未解决列表", not ("周四" in still and "还书" in still), still[:300])

print()
if fails:
    print(f"✗ {len(fails)} 项没过: {fails}")
    sys.exit(1)
print("✓ 全部通过")
