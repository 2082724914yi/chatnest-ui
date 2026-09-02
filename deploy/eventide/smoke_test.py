"""eventide-svc 冒烟测试：把服务当黑盒打一遍，验证状态能连续演进。"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from http.client import HTTPConnection

HOST = os.environ.get("EVENTIDE_HOST", "127.0.0.1")
PORT = int(os.environ.get("EVENTIDE_PORT", "3100"))
TOKEN = os.environ.get("EVENTIDE_TOKEN", "")

failures = []


def call(path: str, body=None, method="POST"):
    conn = HTTPConnection(HOST, PORT, timeout=15)
    headers = {"Content-Type": "application/json"}
    if TOKEN:
        headers["X-Eventide-Token"] = TOKEN
    payload = json.dumps(body or {}, ensure_ascii=False).encode("utf-8")
    conn.request(method, path, payload if method == "POST" else None, headers)
    resp = conn.getresponse()
    data = json.loads(resp.read().decode("utf-8"))
    conn.close()
    return resp.status, data


def check(name: str, condition: bool, detail: str = ""):
    mark = "OK  " if condition else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(name)


def main():
    t0 = datetime(2026, 9, 2, 7, 0, tzinfo=timezone(timedelta(hours=8)))

    status, health = call("/health", method="GET")
    check("health 200", status == 200 and health.get("ok"), str(health))
    check("18 个事件全在", health.get("events") == 18, f"events={health.get('events')}")
    check("6 个周期全在", health.get("cycles") == 6, f"cycles={health.get('cycles')}")

    # 首次调用：没有 state，应当新建平稳期
    status, r = call("/check", {"now": t0.isoformat(), "state": None, "seed": 7})
    check("首次 check 建状态", r.get("ok") and r.get("created"), str(r)[:200])
    check("初始在平稳期", r["cycle"]["key"] == "stable", r["cycle"]["key"])
    check("状态卡有 ephemeral_state", "<ephemeral_state" in (r.get("card") or ""), str(r.get("card"))[:120])
    check("payload 七项齐全", len(r.get("payload") or {}) == 7, str(list((r.get("payload") or {}).keys())))
    check("档位不是裸数字", isinstance(r["payload"]["heat"].get("level"), str), str(r["payload"]["heat"]))
    state = r["state"]

    # 连续推进 10 天，每 3 小时一次，验证周期会自然流转、状态不炸
    now = t0
    seen_cycles = {r["cycle"]["key"]}
    events_started = []
    for i in range(80):
        now += timedelta(hours=3)
        status, r = call("/check", {
            "now": now.isoformat(),
            "state": state,
            "seed": 1000 + i,
            "last_counterpart_message_at": (now - timedelta(minutes=45)).isoformat(),
            "settings": {"trigger_words": [
                {"key": "nickname:daddy", "text": "daddy", "type": "nickname"},
                {"key": "nickname:老公", "text": "老公", "type": "nickname"},
            ]},
            "recent_text": "老公" if i % 7 == 0 else "在干嘛",
        })
        if status != 200 or not r.get("ok"):
            check(f"第 {i} 轮 check", False, str(r)[:300])
            break
        state = r["state"]
        seen_cycles.add(r["cycle"]["key"])
        started = (r.get("event") or {}).get("started")
        if started:
            events_started.append(started["event_key"])

    check("10 天里周期有流转", len(seen_cycles) >= 3, f"seen={seen_cycles}")
    check("10 天里抽到过事件", len(events_started) > 0, f"started={events_started}")
    check("事件流写进了 event_log", len(r.get("event_log") or []) > 0, str(len(r.get("event_log") or [])))
    print(f"       周期走过: {sorted(seen_cycles)}")
    print(f"       抽中事件: {events_started[:12]}{' …' if len(events_started) > 12 else ''}")

    # 数值必须始终在 clamp 范围内
    values = state["values"]
    in_range = all(0 <= v <= 100 for v in values.values())
    check("数值全在 0-100", in_range, str(values))
    check("占有欲不低于 40", values.get("possessiveness", 0) >= 40, str(values.get("possessiveness")))

    # 10 分钟节流
    status, r1 = call("/check", {"now": now.isoformat(), "state": state, "seed": 5})
    status, r2 = call("/check", {"now": (now + timedelta(minutes=3)).isoformat(),
                                 "state": r1["state"], "seed": 6})
    check("10 分钟内不重复抽事件",
          (r2.get("event") or {}).get("skipped") in ("throttled", "active_event"),
          str((r2.get("event") or {}).get("skipped")))

    # 手动开事件（小衍自己调用的路径）
    status, r = call("/event/start", {
        "now": (now + timedelta(hours=6)).isoformat(),
        "state": state, "event_key": "closeness_hunger", "replace_active": True, "seed": 3,
    })
    check("手动开事件成功", r.get("ok") and r.get("started"), str(r)[:200])
    check("active_event 是刚开的", (r.get("active_event") or {}).get("key") == "closeness_hunger",
          str(r.get("active_event")))
    check("手动事件有中文名", (r.get("active_event") or {}).get("label") == "贴近饥饿",
          str((r.get("active_event") or {}).get("label")))
    manual_state = r["state"]

    status, r = call("/event/start", {"now": now.isoformat(), "state": state, "event_key": "nope"})
    check("未知事件被挡住", not r.get("ok") and "unknown" in str(r.get("error", "")), str(r)[:120])

    # 手动切周期
    status, r = call("/cycle/enter", {"now": now.isoformat(), "state": state,
                                      "cycle_key": "sensitive", "seed": 4})
    check("手动切周期", r.get("ok") and r["cycle"]["key"] == "sensitive", str(r.get("cycle")))

    # 直接写数值
    status, r = call("/delta", {"now": now.isoformat(), "state": state,
                                "deltas": {"heat": 15, "control": -10}})
    check("delta 写回生效", r.get("ok") and r.get("applied"), str(r.get("applied")))

    # 结算：prompt + 写回
    status, r = call("/settlement/prompt", {"now": now.isoformat(), "state": state,
                                            "message_window_text": "刚才抱着聊了很久，没有做完。"})
    check("结算 prompt 生成", r.get("ok") and len(r.get("prompt") or "") > 50, str(r)[:150])
    check("结算 schema 存在", isinstance(r.get("schema"), dict), str(type(r.get("schema"))))

    status, r = call("/settle", {
        "now": now.isoformat(), "state": state,
        "result": {
            "settlement_reason": "窗口里亲密互动继续推进，尚未发生释放。",
            "settlement_result": "continued", "ejaculated": False,
            "heat_delta": 6, "pressure_delta": 4, "control_delta": -3,
            "sensitivity_delta": 2, "reserve_delta": 3,
            "possessiveness_delta": 1, "fatigue_delta": 0,
        },
    })
    check("结算写回生效", r.get("ok") and r.get("applied"), str(r)[:200])
    check("结算留了痕迹", r["state"]["meta"].get("last_settlement") is not None,
          str(r["state"]["meta"].get("last_settlement")))

    # 状态卡在关掉注入时应当消失
    status, r = call("/tick", {"now": now.isoformat(), "state": state,
                               "settings": {"inject_body_state_context": False}})
    check("关掉注入后没有状态卡", r.get("card") is None, str(r.get("card"))[:80])

    # 只读视图不推进时间
    status, before = call("/view", {"now": now.isoformat(), "state": manual_state})
    status, after = call("/view", {"now": (now + timedelta(days=2)).isoformat(), "state": manual_state})
    check("view 不推进状态", before["state"]["values"] == after["state"]["values"],
          f'{before["state"]["values"]} vs {after["state"]["values"]}')

    # 定义表
    status, r = call("/definitions", method="GET")
    check("定义表 18 事件", len(r.get("events") or []) == 18, str(len(r.get("events") or [])))
    check("定义表 6 周期", len(r.get("cycles") or []) == 6, str(len(r.get("cycles") or [])))
    check("优先级第一是周期热涌", (r["events"][0]["key"] == "cycle_surge"), str(r["events"][0]))
    check("时区是上海", r.get("timezone") == "Asia/Shanghai", str(r.get("timezone")))

    # 坏输入
    status, r = call("/nope", {})
    check("未知路由 404", status == 404, str(status))

    print()
    if failures:
        print(f"✗ {len(failures)} 项失败: {failures}")
        sys.exit(1)
    print("✓ 全部通过")


if __name__ == "__main__":
    main()
