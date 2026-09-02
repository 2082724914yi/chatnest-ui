"""Eventide 宿主层：默认事件触发调度器。

Eventide 内核只提供事件定义、状态推进和 start_event()；
"什么时候该抽哪个事件" 是宿主要自己实现的部分。
这个模块按 Eventide README《默认事件触发与联动》一节的口径实现：

  硬条件 -> 冷却 -> 窗口去重 -> 概率 -> 优先级 -> start_event

所有运行时历史（冷却、窗口 roll key、missed 快照、称呼刺激日志）
都写在 state.meta 里，随 BodyState 一起被宿主持久化。
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from zoneinfo import ZoneInfo

from eventide import (
    DEFAULT_CONFIG,
    BodyState,
    EngineSettings,
    apply_interaction_delta,
    find_trigger_matches,
    start_event,
)

# 本地时区。时间窗口（早晨/傍晚/深夜）按这个算，不按 UTC。
LOCAL_TZ = ZoneInfo("Asia/Shanghai")

# 强生理类事件：会明显推高热度/压抑/蓄积并压低控制力。
STRONG_EVENTS = frozenset({
    "morning_arousal",
    "night_heat",
    "cycle_surge",
    "control_slip",
    "demanding",
    "marking_impulse",
    "pheromone_disorder",
    "delayed_heat",
})

# 这些事件结束后不再派生后效，避免后效无限接龙。
NO_AFTEREFFECT_SOURCES = frozenset({
    "scent_aftereffect",
    "dream_afterglow",
    "voice_or_name_trigger",
    "delayed_heat",
    "low_fever_cling",
    "waiting_restless",
    "restraint_rebound",
    "strange_calm",
})

# 同时通过时只选一个主事件，顺位越小越优先。
EVENT_PRIORITY = {
    "cycle_surge": 1,
    "morning_arousal": 2,
    "night_heat": 3,
    "control_slip": 4,
    "demanding": 5,
    "marking_impulse": 6,
    "pheromone_disorder": 7,
    "holding_back": 8,
    "voice_or_name_trigger": 9,
    "nesting": 10,
    "delayed_heat": 11,
    "low_fever_cling": 12,
    "waiting_restless": 13,
    "restraint_rebound": 14,
    "closeness_hunger": 15,
    "dream_afterglow": 16,
    "scent_aftereffect": 17,
    "strange_calm": 18,
}

# 冷却小时数，按同类事件上一次 expires_at 计算（不是开始时间）。
EVENT_COOLDOWN_HOURS = {
    "morning_arousal": 20.0,
    "night_heat": 8.0,
    "cycle_surge": 12.0,
    "holding_back": 4.0,
    "demanding": 6.0,
    "marking_impulse": 8.0,
    "nesting": 12.0,
    "scent_aftereffect": 4.0,
    "voice_or_name_trigger": 2.0,
    "dream_afterglow": 0.0,  # 靠 rolled_dream_afterglow_keys 去重，同一梦卡只抽一次
    "control_slip": 4.0,
    "closeness_hunger": 6.0,
    "pheromone_disorder": 8.0,
    "delayed_heat": 6.0,
    "low_fever_cling": 4.0,
    "waiting_restless": 5.0,
    "restraint_rebound": 8.0,
    "strange_calm": 4.0,
}

# 事件开始后，下一次主动检查的分钟范围。
NEXT_WAKEUP_MINUTES = {
    "morning_arousal": (5, 15),
    "cycle_surge": (5, 15),
    "control_slip": (5, 15),
    "voice_or_name_trigger": (8, 15),
    "night_heat": (10, 20),
    "demanding": (10, 20),
    "marking_impulse": (10, 25),
    "dream_afterglow": (10, 25),
}
DEFAULT_WAKEUP_MINUTES = (15, 30)

# 两次事件检查之间的最小间隔，防止高频聊天连续触发。
EVENT_CHECK_THROTTLE_MINUTES = 10

# 概率上限，避免配置倍率把某个事件推到必中。
MAX_EVENT_PROBABILITY = 0.95

MAX_EVENT_LOG = 200
MAX_ROLLED_KEYS = 120


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------

def _parse_dt(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=LOCAL_TZ)
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=LOCAL_TZ)


def _hours_between(later: datetime, earlier: Optional[datetime]) -> Optional[float]:
    if earlier is None:
        return None
    return (later - earlier).total_seconds() / 3600.0


def _minutes_between(later: datetime, earlier: Optional[datetime]) -> Optional[float]:
    if earlier is None:
        return None
    return (later - earlier).total_seconds() / 60.0


def _meta_list(state: BodyState, key: str) -> List[str]:
    value = state.meta.get(key)
    return [str(item) for item in value] if isinstance(value, list) else []


def _meta_dict(state: BodyState, key: str) -> Dict[str, Any]:
    value = state.meta.get(key)
    return dict(value) if isinstance(value, dict) else {}


def _push_rolled(state: BodyState, meta_key: str, roll_key: str) -> None:
    keys = _meta_list(state, meta_key)
    if roll_key not in keys:
        keys.append(roll_key)
    state.meta[meta_key] = keys[-MAX_ROLLED_KEYS:]


# --------------------------------------------------------------------------
# 时间窗口
# --------------------------------------------------------------------------

def current_windows(now: datetime) -> Dict[str, str]:
    """返回当前命中的时间窗口 -> roll key。

    跨零点的窗口，自然日按窗口开始日算：
    9 月 3 日 01:00 属于 9 月 2 日的 evening / night。
    """
    local = now.astimezone(LOCAL_TZ)
    minutes = local.hour * 60 + local.minute
    today = local.date().isoformat()
    yesterday = (local.date() - timedelta(days=1)).isoformat()
    windows: Dict[str, str] = {}

    # morning 05:30-10:30
    if 5 * 60 + 30 <= minutes < 10 * 60 + 30:
        windows["morning"] = f"{today}:morning"

    # evening 18:00-02:00（跨零点）
    if minutes >= 18 * 60:
        windows["evening"] = f"{today}:evening"
    elif minutes < 2 * 60:
        windows["evening"] = f"{yesterday}:evening"

    # night 23:00-03:00（跨零点）
    if minutes >= 23 * 60:
        windows["night"] = f"{today}:night"
    elif minutes < 3 * 60:
        windows["night"] = f"{yesterday}:night"

    return windows


# --------------------------------------------------------------------------
# 冷却
# --------------------------------------------------------------------------

def _cooldown_ready(state: BodyState, event_key: str, now: datetime) -> bool:
    hours = EVENT_COOLDOWN_HOURS.get(event_key, 4.0)
    if hours <= 0:
        return True
    last_end = _parse_dt(_meta_dict(state, "event_cooldowns").get(event_key))
    if last_end is None:
        return True
    return (now - last_end).total_seconds() / 3600.0 >= hours


def _record_cooldown(state: BodyState, event_key: str, expires_at: Optional[datetime]) -> None:
    if expires_at is None:
        return
    cooldowns = _meta_dict(state, "event_cooldowns")
    cooldowns[event_key] = expires_at.isoformat()
    state.meta["event_cooldowns"] = cooldowns


# --------------------------------------------------------------------------
# 候选判定
# --------------------------------------------------------------------------

def _collect_candidates(
    state: BodyState,
    now: datetime,
    *,
    windows: Dict[str, str],
    silence_minutes: Optional[float],
    trigger_hits: List[Dict[str, Any]],
    dream: Optional[Dict[str, Any]],
) -> List[Tuple[str, float, str]]:
    """返回 [(event_key, probability, reason), ...]，只含硬条件通过的候选。"""
    v = state.values
    heat = v.get("heat", 0)
    pressure = v.get("pressure", 0)
    control = v.get("control", 0)
    sensitivity = v.get("sensitivity", 0)
    reserve = v.get("reserve", 0)
    possessiveness = v.get("possessiveness", 0)
    fatigue = v.get("fatigue", 0)
    cycle = state.cycle_key
    silence = silence_minutes if silence_minutes is not None else 0.0

    out: List[Tuple[str, float, str]] = []

    def add(key: str, prob: float, reason: str) -> None:
        out.append((key, prob, reason))

    # --- 固定时间窗口类 ---
    if "morning" in windows and (heat >= 45 or cycle != "stable"):
        prob = 0.75 if cycle in ("preheat", "sensitive") else 0.45
        add("morning_arousal", prob, "morning_window")

    if "night" in windows and silence >= 30 and (reserve >= 55 or heat >= 60):
        add("night_heat", 0.60 if cycle == "sensitive" else 0.30, "night_window")

    if "evening" in windows and (fatigue >= 35 or possessiveness >= 55):
        add("nesting", 0.30, "evening_window")

    if "night" in windows and possessiveness >= 60:
        add("marking_impulse", 0.40, "night_window")

    # --- 周期 / 数值类 ---
    if cycle == "sensitive" and (heat >= 75 or reserve >= 70):
        add("cycle_surge", 0.50, "sensitive_surge")

    if heat >= 70 and control >= 35:
        add("holding_back", 0.70, "high_heat_still_holding")

    if cycle == "sensitive" or (heat >= 65 and pressure >= 55):
        add("demanding", 0.35, "sensitive_or_high_pressure")

    if possessiveness >= 60 and (silence >= 60 or "night" in windows or cycle == "sensitive"):
        add("marking_impulse", 0.40, "possessive_high")

    if control <= 35 and (heat >= 70 or pressure >= 70):
        add("control_slip", 0.60, "control_low")

    if cycle in ("sensitive", "ebb", "recovery") and sensitivity >= 60 and fatigue <= 75:
        add("closeness_hunger", 0.35, "sensitivity_high")

    if cycle == "sensitive" and _values_moving_fast(state, now):
        add("pheromone_disorder", 0.30, "fast_value_shift")

    if 45 <= heat <= 69 and sensitivity >= 60 and silence < 30:
        add("low_fever_cling", 0.30, "steady_contact")

    if 60 <= silence <= 120 and (pressure >= 55 or possessiveness >= 60):
        add("waiting_restless", 0.30, "waiting")

    # --- 称呼 / 刺激类 ---
    if trigger_hits and not state.active_event_key:
        prob = 0.20
        kind = "text"
        for hit in trigger_hits:
            if hit.get("voice"):
                prob, kind = max(prob, 0.35), "voice"
            elif int(hit.get("count", 1)) > 1:
                prob, kind = max(prob, 0.30), "repeat"
        if cycle == "sensitive":
            prob += 0.10
        add("voice_or_name_trigger", prob, f"configured_trigger:{kind}")

    # --- 后效 / 历史类 ---
    out.extend(_aftereffect_candidates(state, now, reserve=reserve, heat=heat, pressure=pressure))

    dream_candidate = _dream_afterglow_candidate(state, now, dream)
    if dream_candidate:
        out.append(dream_candidate)

    return out


def _values_moving_fast(state: BodyState, now: datetime) -> bool:
    """信息素紊乱：短时间内热度快升或控制力快掉。

    依赖 value_trail —— 每次检查写一条 (时间, heat, control) 的痕迹。
    """
    trail = state.meta.get("value_trail")
    if not isinstance(trail, list) or not trail:
        return False
    heat = state.values.get("heat", 0)
    control = state.values.get("control", 0)
    for point in reversed(trail):
        if not isinstance(point, dict):
            continue
        at = _parse_dt(point.get("at"))
        if at is None:
            continue
        age_minutes = _minutes_between(now, at)
        if age_minutes is None or age_minutes > 90:
            break
        if heat - int(point.get("heat", heat)) >= 12:
            return True
        if int(point.get("control", control)) - control >= 12:
            return True
    return False


def _aftereffect_candidates(
    state: BodyState,
    now: datetime,
    *,
    reserve: int,
    heat: int,
    pressure: int,
) -> List[Tuple[str, float, str]]:
    out: List[Tuple[str, float, str]] = []
    rolled = set(_meta_list(state, "rolled_aftereffect_keys"))
    last_end = _parse_dt(state.meta.get("last_active_event_expires_at"))
    last_key = str(state.meta.get("last_active_event_key") or "")
    hours_since_end = _hours_between(now, last_end)
    date_key = now.astimezone(LOCAL_TZ).date().isoformat()

    # 气味残留：强事件结束 3 小时内，或当前处在退潮期
    derivable = last_key and last_key not in NO_AFTEREFFECT_SOURCES
    from_strong = derivable and hours_since_end is not None and hours_since_end <= 3
    if from_strong or state.cycle_key == "ebb":
        source = last_key if from_strong else f"ebb:{date_key}"
        roll_key = f"scent:{source}"
        if roll_key not in rolled:
            out.append(("scent_aftereffect", 0.60, f"aftereffect:{source}"))

    # 迟发热：上次有强候选没抽中，30-180 分钟后热度/压抑仍未退下
    missed_at = _parse_dt(state.meta.get("last_missed_event_check_at"))
    missed_minutes = _minutes_between(now, missed_at)
    if missed_minutes is not None and 30 <= missed_minutes <= 180:
        snapshot = _meta_dict(state, "last_missed_state_snapshot")
        candidates = _meta_list(state, "last_missed_event_candidates")
        had_strong = any(key in STRONG_EVENTS for key in candidates)
        not_faded = (
            heat >= int(snapshot.get("heat", heat)) - 5
            and pressure >= int(snapshot.get("pressure", pressure)) - 5
        )
        if had_strong and not_faded and (heat >= 55 or pressure >= 55):
            out.append(("delayed_heat", 0.35, "missed_strong_candidate"))

    # 克制反弹：蓄积 >= 70，上一个事件结束 8 小时以上，当天没抽过
    roll_key = f"no_event_gap:{date_key}"
    if reserve >= 70 and hours_since_end is not None and hours_since_end >= 8 and roll_key not in rolled:
        out.append(("restraint_rebound", 0.25, "long_gap_high_reserve"))

    return out


def _dream_afterglow_candidate(
    state: BodyState,
    now: datetime,
    dream: Optional[Dict[str, Any]],
) -> Optional[Tuple[str, float, str]]:
    """梦后余温：梦卡 0-8 小时内，tag 命中，同一梦卡只抽一次。"""
    if not isinstance(dream, dict):
        return None
    card_id = str(dream.get("card_id") or "")
    tags = {str(tag) for tag in (dream.get("after_effect_tags") or [])}
    if not card_id or not tags & {"aroused", "unfinished", "possessive", "tender"}:
        return None
    if card_id in set(_meta_list(state, "rolled_dream_afterglow_keys")):
        return None
    created_at = _parse_dt(dream.get("created_at")) or state.last_dream_card_created_at
    hours = _hours_between(now, created_at)
    if hours is None or hours < 0 or hours > 8:
        return None
    return ("dream_afterglow", 0.35 if hours <= 4 else 0.17, f"dream_card:{card_id}")


# --------------------------------------------------------------------------
# 称呼刺激写回
# --------------------------------------------------------------------------

def apply_trigger_stimulus(
    state: BodyState,
    hits: List[Dict[str, Any]],
    now: datetime,
    *,
    rng: random.Random,
    config=DEFAULT_CONFIG,
) -> Dict[str, int]:
    """当前已有事件时不换主事件，但把这次刺激写进数值。

    同一 trigger_key 10 分钟内只结算一次；10 分钟内最多结算 2 个不同触发词。
    """
    log = _meta_dict(state, "trigger_stimulus_log")
    settled_recently = sum(
        1
        for at in log.values()
        if (_minutes_between(now, _parse_dt(at)) or 999) <= 10
    )
    applied: Dict[str, int] = {}

    for hit in hits:
        if settled_recently >= 2:
            break
        key = str(hit.get("key") or "")
        if not key:
            continue
        age = _minutes_between(now, _parse_dt(log.get(key)))
        if age is not None and age <= 10:
            continue
        deltas = {
            "sensitivity": rng.randint(3, 8),
            "possessiveness": rng.randint(1, 3),
            "pressure": rng.randint(0, 4),
        }
        for field, delta in apply_interaction_delta(state, deltas, config=config).items():
            applied[field] = applied.get(field, 0) + delta
        log[key] = now.isoformat()
        settled_recently += 1

    state.meta["trigger_stimulus_log"] = {
        k: v for k, v in log.items() if (_minutes_between(now, _parse_dt(v)) or 999) <= 120
    }
    return applied


# --------------------------------------------------------------------------
# 主入口
# --------------------------------------------------------------------------

def check_events(
    state: BodyState,
    now: datetime,
    *,
    settings: EngineSettings,
    last_counterpart_message_at: Optional[datetime] = None,
    recent_text: Optional[str] = None,
    input_type: str = "text",
    transcript: Optional[str] = None,
    dream: Optional[Dict[str, Any]] = None,
    force: bool = False,
    rng: Optional[random.Random] = None,
    config=DEFAULT_CONFIG,
) -> Dict[str, Any]:
    """跑一次完整的事件检查。state 会被原地修改。

    返回 {started, reason, candidates, stimulus, skipped, next_wakeup_at}。
    """
    roller = rng or random
    result: Dict[str, Any] = {
        "started": None,
        "reason": None,
        "candidates": [],
        "stimulus": {},
        "skipped": None,
        "next_wakeup_at": None,
    }

    if not settings.body_cycle_enabled:
        result["skipped"] = "body_cycle_disabled"
        return result

    # 事件到期后，engine 会清空 active_event；这里把结束痕迹记进 meta 供后效判断
    _capture_finished_event(state, now)

    trigger_hits = _match_triggers(settings, recent_text, input_type, transcript)

    # 已有未过期事件：不抽新的，但称呼刺激照样写回数值
    if state.active_event_key and state.active_event_expires_at and now < state.active_event_expires_at:
        if trigger_hits:
            result["stimulus"] = apply_trigger_stimulus(state, trigger_hits, now, rng=roller, config=config)
        result["skipped"] = "active_event"
        return result

    # 10 分钟节流
    last_check = _parse_dt(state.meta.get("last_event_check_at"))
    since_check = _minutes_between(now, last_check)
    if not force and since_check is not None and since_check < EVENT_CHECK_THROTTLE_MINUTES:
        if trigger_hits:
            result["stimulus"] = apply_trigger_stimulus(state, trigger_hits, now, rng=roller, config=config)
        result["skipped"] = "throttled"
        return result

    state.meta["last_event_check_at"] = now.isoformat()
    _record_value_trail(state, now)

    windows = current_windows(now)
    silence_minutes = _minutes_between(now, last_counterpart_message_at)
    rolled_windows = set(_meta_list(state, "rolled_window_keys"))

    candidates = _collect_candidates(
        state,
        now,
        windows=windows,
        silence_minutes=silence_minutes,
        trigger_hits=trigger_hits,
        dream=dream,
    )

    # 去重：同一事件可能被多条口径命中，取概率最高的那条
    best: Dict[str, Tuple[float, str]] = {}
    for key, prob, reason in candidates:
        if key not in config.events:
            continue
        if not _cooldown_ready(state, key, now):
            continue
        window_key = _window_roll_key(key, windows)
        if window_key and window_key in rolled_windows:
            continue
        if key not in best or prob > best[key][0]:
            best[key] = (prob, reason)

    result["candidates"] = sorted(best.keys(), key=lambda k: EVENT_PRIORITY.get(k, 99))

    # 概率抽取
    passed: List[Tuple[str, str]] = []
    for key, (prob, reason) in best.items():
        effective = min(prob * float(settings.event_probability_multiplier), MAX_EVENT_PROBABILITY)
        if roller.random() < effective:
            passed.append((key, reason))

    # 反常平静：有强候选但一个都没通过
    had_strong_candidate = any(key in STRONG_EVENTS for key in best)
    if not passed and had_strong_candidate:
        v = state.values
        if (v.get("heat", 0) >= 65 or v.get("pressure", 0) >= 65) and _cooldown_ready(state, "strange_calm", now):
            if roller.random() < min(0.25 * float(settings.event_probability_multiplier), MAX_EVENT_PROBABILITY):
                passed.append(("strange_calm", "strong_candidate_missed"))

    if not passed:
        _record_missed(state, now, list(best.keys()), had_strong_candidate)
        return result

    # 优先级选一个主事件
    passed.sort(key=lambda item: EVENT_PRIORITY.get(item[0], 99))
    event_key, reason = passed[0]

    snapshot = {"cycle_key": state.cycle_key, "active_event_key": state.active_event_key, **dict(state.values)}
    if not start_event(state, event_key, now, config=config, rng=roller):
        result["skipped"] = "start_event_refused"
        return result

    _record_cooldown(state, event_key, state.active_event_expires_at)
    _mark_roll_keys(state, event_key, windows, best.get(event_key), dream)
    state.meta.pop("last_missed_event_check_at", None)
    state.meta.pop("last_missed_event_candidates", None)
    state.meta.pop("last_missed_state_snapshot", None)

    low, high = NEXT_WAKEUP_MINUTES.get(event_key, DEFAULT_WAKEUP_MINUTES)
    next_wakeup = now + timedelta(minutes=roller.randint(low, high))
    state.meta["next_body_wakeup_at"] = next_wakeup.isoformat()

    entry = {
        "event_key": event_key,
        "label": config.events[event_key].label,
        "started_at": now.isoformat(),
        "expires_at": state.active_event_expires_at.isoformat() if state.active_event_expires_at else None,
        "trigger_reason": reason,
        "cycle_key": state.cycle_key,
        "state_snapshot": snapshot,
    }
    _append_event_log(state, entry)

    if trigger_hits and event_key != "voice_or_name_trigger":
        result["stimulus"] = apply_trigger_stimulus(state, trigger_hits, now, rng=roller, config=config)

    result["started"] = entry
    result["reason"] = reason
    result["next_wakeup_at"] = next_wakeup.isoformat()
    return result


def _match_triggers(
    settings: EngineSettings,
    recent_text: Optional[str],
    input_type: str,
    transcript: Optional[str],
) -> List[Dict[str, Any]]:
    if not settings.trigger_words or not (recent_text or transcript):
        return []
    matches = find_trigger_matches(
        settings.trigger_words, recent_text, input_type=input_type, transcript=transcript
    )
    return [
        {"key": m.key, "text": m.text, "type": m.type, "count": m.count, "voice": m.voice}
        for m in matches
    ]


def _capture_finished_event(state: BodyState, now: datetime) -> None:
    """事件到期被 engine 清掉之前/之后，把结束痕迹留在 meta 里。"""
    if state.active_event_key and state.active_event_expires_at and now >= state.active_event_expires_at:
        state.meta["last_active_event_key"] = state.active_event_key
        state.meta["last_active_event_expires_at"] = state.active_event_expires_at.isoformat()
        _record_cooldown(state, state.active_event_key, state.active_event_expires_at)


def _record_value_trail(state: BodyState, now: datetime) -> None:
    trail = state.meta.get("value_trail")
    trail = list(trail) if isinstance(trail, list) else []
    trail.append({
        "at": now.isoformat(),
        "heat": state.values.get("heat", 0),
        "control": state.values.get("control", 0),
    })
    state.meta["value_trail"] = trail[-12:]


def _window_roll_key(event_key: str, windows: Dict[str, str]) -> Optional[str]:
    if event_key == "morning_arousal":
        return windows.get("morning")
    if event_key == "night_heat":
        return windows.get("night")
    if event_key == "nesting":
        return windows.get("evening")
    if event_key == "marking_impulse":
        return windows.get("night")
    return None


def _mark_roll_keys(
    state: BodyState,
    event_key: str,
    windows: Dict[str, str],
    best_entry: Optional[Tuple[float, str]],
    dream: Optional[Dict[str, Any]],
) -> None:
    window_key = _window_roll_key(event_key, windows)
    if window_key:
        _push_rolled(state, "rolled_window_keys", window_key)

    if event_key == "scent_aftereffect" and best_entry:
        source = best_entry[1].split(":", 1)[-1]
        _push_rolled(state, "rolled_aftereffect_keys", f"scent:{source}")

    if event_key == "restraint_rebound":
        date_key = state.meta.get("last_event_check_at", "")[:10]
        _push_rolled(state, "rolled_aftereffect_keys", f"no_event_gap:{date_key}")

    if event_key == "dream_afterglow" and isinstance(dream, dict):
        card_id = str(dream.get("card_id") or "")
        if card_id:
            _push_rolled(state, "rolled_dream_afterglow_keys", card_id)


def _record_missed(
    state: BodyState,
    now: datetime,
    candidates: List[str],
    had_strong: bool,
) -> None:
    if not candidates:
        return
    state.meta["last_missed_event_check_at"] = now.isoformat()
    state.meta["last_missed_event_candidates"] = candidates
    if had_strong:
        state.meta["last_missed_state_snapshot"] = {
            "heat": state.values.get("heat", 0),
            "pressure": state.values.get("pressure", 0),
        }


def _append_event_log(state: BodyState, entry: Dict[str, Any]) -> None:
    """用 event_key + started_at 去重，避免同一事件写两条。"""
    log = state.meta.get("event_log")
    log = list(log) if isinstance(log, list) else []
    dedupe = f"{entry['event_key']}@{entry['started_at']}"
    for existing in log:
        if isinstance(existing, dict) and f"{existing.get('event_key')}@{existing.get('started_at')}" == dedupe:
            return
    log.append(entry)
    state.meta["event_log"] = log[-MAX_EVENT_LOG:]
