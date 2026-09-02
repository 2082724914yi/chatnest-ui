"""Eventide 无状态 HTTP 服务。

设计要点：服务本身不持有任何状态。
每个请求由宿主（chatnest-api / Node）把 BodyState 传进来，
算完把新的 state 原样传回去，由宿主负责落盘。
所以这个进程随时可以重启、升级、改配置，状态一点都不会丢。

只监听 127.0.0.1，由 nginx 之外的世界访问不到。
设了 EVENTIDE_TOKEN 时，额外校验 X-Eventide-Token 头。

启动：
    PYTHONPATH=/opt/eventide/src python3 app.py
环境变量：
    EVENTIDE_HOST   默认 127.0.0.1
    EVENTIDE_PORT   默认 3100
    EVENTIDE_TOKEN  可选，设了就强制校验
"""

from __future__ import annotations

import json
import os
import random
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple

from eventide import (
    DEFAULT_CONFIG,
    BodyState,
    DreamSeed,
    DreamSettings,
    EngineSettings,
    advance_state,
    apply_dream_after_effect,
    apply_interaction_delta,
    body_state_from_dict,
    body_state_payload,
    body_state_to_dict,
    create_initial_state,
    enter_cycle,
    maybe_create_dream_trigger,
    normalize_trigger_words,
    parse_settlement_result,
    apply_settlement_result,
    normalize_settlement_result,
    render_dream_trigger,
    render_settlement_prompt,
    render_state_card,
    settlement_json_schema,
    start_event,
)

import scheduler
from scheduler import LOCAL_TZ

HOST = os.environ.get("EVENTIDE_HOST", "127.0.0.1")
PORT = int(os.environ.get("EVENTIDE_PORT", "3100"))
TOKEN = os.environ.get("EVENTIDE_TOKEN", "").strip()

CONFIG = DEFAULT_CONFIG


# --------------------------------------------------------------------------
# 请求辅助
# --------------------------------------------------------------------------

def _now(body: Dict[str, Any], key: str = "now") -> datetime:
    parsed = scheduler._parse_dt(body.get(key))
    return parsed or datetime.now(timezone.utc)


def _optional_dt(body: Dict[str, Any], key: str) -> Optional[datetime]:
    return scheduler._parse_dt(body.get(key))


def _load_state(body: Dict[str, Any], now: datetime) -> Tuple[BodyState, bool]:
    """读出 BodyState；没有就按平稳期新建。返回 (state, created)。"""
    raw = body.get("state")
    if not isinstance(raw, dict) or not raw.get("cycle_key"):
        cycle_key = str(body.get("initial_cycle") or "stable")
        return create_initial_state(now, cycle_key=cycle_key, config=CONFIG), True
    return body_state_from_dict(raw), False


def _settings(body: Dict[str, Any]) -> EngineSettings:
    raw = body.get("settings")
    raw = raw if isinstance(raw, dict) else {}
    return EngineSettings(
        body_cycle_enabled=bool(raw.get("body_cycle_enabled", True)),
        inject_body_state_context=bool(raw.get("inject_body_state_context", True)),
        adult_private_mode_enabled=bool(raw.get("adult_private_mode_enabled", False)),
        safeword=str(raw.get("safeword") or ""),
        trigger_words=normalize_trigger_words(raw.get("trigger_words") or []),
        event_probability_multiplier=float(raw.get("event_probability_multiplier", 1.0) or 1.0),
    )


def _rng(body: Dict[str, Any]) -> random.Random:
    seed = body.get("seed")
    return random.Random(seed) if seed is not None else random.Random()


# --------------------------------------------------------------------------
# 视图：给前端 / 日志用的结构化输出
# --------------------------------------------------------------------------

def _remaining_text(target: Optional[datetime], now: datetime) -> Optional[str]:
    if target is None:
        return None
    minutes = int((target - now).total_seconds() // 60)
    if minutes <= 0:
        return "已到期"
    if minutes < 60:
        return f"{minutes} 分钟"
    hours, rest = divmod(minutes, 60)
    if hours < 24:
        return f"{hours} 小时 {rest} 分钟" if rest else f"{hours} 小时"
    days, rest_hours = divmod(hours, 24)
    return f"{days} 天 {rest_hours} 小时" if rest_hours else f"{days} 天"


def _view(state: BodyState, now: datetime) -> Dict[str, Any]:
    """Pulse 前端要的一整屏：周期、当前事件、档位、事件流。"""
    cycle_def = CONFIG.cycles.get(state.cycle_key)
    view: Dict[str, Any] = {
        "cycle": {
            "key": state.cycle_key,
            "label": cycle_def.label if cycle_def else state.cycle_key,
            "description": cycle_def.description if cycle_def else "",
            "started_at": state.cycle_started_at.isoformat() if state.cycle_started_at else None,
            "expires_at": state.cycle_expires_at.isoformat() if state.cycle_expires_at else None,
            "remaining": _remaining_text(state.cycle_expires_at, now),
            "next_key": cycle_def.next_key if cycle_def else "stable",
            "reason": state.meta.get("last_cycle_reason"),
        },
        "active_event": None,
        "payload": body_state_payload(state, config=CONFIG),
        "event_log": [e for e in (state.meta.get("event_log") or []) if isinstance(e, dict)][-40:],
        "next_wakeup_at": state.meta.get("next_body_wakeup_at"),
        "last_dream_card_created_at": (
            state.last_dream_card_created_at.isoformat() if state.last_dream_card_created_at else None
        ),
    }

    if state.active_event_key:
        event_def = CONFIG.events.get(state.active_event_key)
        view["active_event"] = {
            "key": state.active_event_key,
            "label": event_def.label if event_def else state.active_event_key,
            "category": event_def.category if event_def else None,
            "started_at": state.active_event_started_at.isoformat() if state.active_event_started_at else None,
            "expires_at": state.active_event_expires_at.isoformat() if state.active_event_expires_at else None,
            "remaining": _remaining_text(state.active_event_expires_at, now),
        }

    return view


def _respond_state(
    state: BodyState,
    now: datetime,
    extra: Dict[str, Any],
    *,
    settings: Optional[EngineSettings] = None,
) -> Dict[str, Any]:
    """任何改动状态的路由都顺带回一张新状态卡，宿主拿到就能直接注入。"""
    response = {
        "ok": True,
        "state": body_state_to_dict(state),
        "now": now.isoformat(),
        "card": render_state_card(state, now, config=CONFIG, settings=settings or EngineSettings()),
        **_view(state, now),
    }
    response.update(extra)
    return response


# --------------------------------------------------------------------------
# 路由处理
# --------------------------------------------------------------------------

def route_check(body: Dict[str, Any]) -> Dict[str, Any]:
    """一站式入口：推进时间 -> 抽事件 -> 渲染状态卡。

    Node 每轮聊天只需要调这一个。
    """
    now = _now(body)
    state, created = _load_state(body, now)
    settings = _settings(body)
    rng = _rng(body)
    last_msg_at = _optional_dt(body, "last_counterpart_message_at")

    changed = advance_state(
        state, now, config=CONFIG, settings=settings, last_counterpart_message_at=last_msg_at, rng=rng
    )

    event_result = {}
    if body.get("check_events", True):
        event_result = scheduler.check_events(
            state,
            now,
            settings=settings,
            last_counterpart_message_at=last_msg_at,
            recent_text=body.get("recent_text"),
            input_type=str(body.get("input_type") or "text"),
            transcript=body.get("transcript"),
            dream=body.get("dream"),
            force=bool(body.get("force_event_check")),
            rng=rng,
            config=CONFIG,
        )

    return _respond_state(state, now, {
        "created": created,
        "ticked": changed,
        "event": event_result,
    }, settings=settings)


def route_tick(body: Dict[str, Any]) -> Dict[str, Any]:
    """只推进时间和渲染，不抽事件。"""
    now = _now(body)
    state, created = _load_state(body, now)
    settings = _settings(body)
    changed = advance_state(
        state,
        now,
        config=CONFIG,
        settings=settings,
        last_counterpart_message_at=_optional_dt(body, "last_counterpart_message_at"),
        rng=_rng(body),
    )
    return _respond_state(state, now, {"created": created, "ticked": changed}, settings=settings)


def route_view(body: Dict[str, Any]) -> Dict[str, Any]:
    """只读当前状态，不推进、不抽事件、不写回。"""
    now = _now(body)
    state, created = _load_state(body, now)
    return _respond_state(state, now, {"created": created}, settings=_settings(body))


def route_event_start(body: Dict[str, Any]) -> Dict[str, Any]:
    """手动开一个事件。小衍自己调用的入口。"""
    now = _now(body)
    state, _ = _load_state(body, now)
    event_key = str(body.get("event_key") or "")
    if event_key not in CONFIG.events:
        return {"ok": False, "error": f"unknown event_key: {event_key}",
                "available": sorted(CONFIG.events.keys())}

    rng = _rng(body)
    if bool(body.get("replace_active")):
        state.active_event_key = None
        state.active_event_started_at = None
        state.active_event_expires_at = None

    settings = _settings(body)
    started = start_event(state, event_key, now, config=CONFIG, rng=rng)
    if started:
        scheduler._record_cooldown(state, event_key, state.active_event_expires_at)
        scheduler._append_event_log(state, {
            "event_key": event_key,
            "label": CONFIG.events[event_key].label,
            "started_at": now.isoformat(),
            "expires_at": state.active_event_expires_at.isoformat() if state.active_event_expires_at else None,
            "trigger_reason": str(body.get("reason") or "manual"),
            "cycle_key": state.cycle_key,
            "state_snapshot": dict(state.values),
        })
    return _respond_state(state, now, {"started": started}, settings=settings)


def route_cycle_enter(body: Dict[str, Any]) -> Dict[str, Any]:
    now = _now(body)
    state, _ = _load_state(body, now)
    cycle_key = str(body.get("cycle_key") or "")
    if cycle_key not in CONFIG.cycles:
        return {"ok": False, "error": f"unknown cycle_key: {cycle_key}",
                "available": sorted(CONFIG.cycles.keys())}
    enter_cycle(state, cycle_key, now, config=CONFIG, rng=_rng(body),
                reason=str(body.get("reason") or "manual"))
    return _respond_state(state, now, {}, settings=_settings(body))


def route_delta(body: Dict[str, Any]) -> Dict[str, Any]:
    now = _now(body)
    state, _ = _load_state(body, now)
    deltas = body.get("deltas")
    if not isinstance(deltas, dict):
        return {"ok": False, "error": "deltas must be an object"}
    applied = apply_interaction_delta(state, deltas, config=CONFIG)
    return _respond_state(state, now, {"applied": applied}, settings=_settings(body))


def route_settlement_prompt(body: Dict[str, Any]) -> Dict[str, Any]:
    now = _now(body)
    state, _ = _load_state(body, now)
    window_text = str(body.get("message_window_text") or "")
    return {
        "ok": True,
        "prompt": render_settlement_prompt(state, window_text, config=CONFIG),
        "schema": settlement_json_schema(),
    }


def route_settle(body: Dict[str, Any]) -> Dict[str, Any]:
    now = _now(body)
    state, _ = _load_state(body, now)
    raw = body.get("result")
    if raw is None:
        return {"ok": False, "error": "missing result"}
    parsed = parse_settlement_result(raw)
    if parsed is None:
        return {"ok": False, "error": "could not parse settlement result"}
    normalized = normalize_settlement_result(state, parsed, config=CONFIG)
    applied = apply_settlement_result(state, parsed, config=CONFIG)
    state.meta["last_settlement"] = {
        "at": now.isoformat(),
        "reason": getattr(parsed, "settlement_reason", None),
        "result": getattr(parsed, "settlement_result", None),
        "applied": applied,
    }
    return _respond_state(state, now, {"applied": applied, "normalized": _jsonable(normalized)}, settings=_settings(body))


def route_dream_maybe(body: Dict[str, Any]) -> Dict[str, Any]:
    now = _now(body)
    state, _ = _load_state(body, now)
    settings = _settings(body)
    raw_seed = body.get("seed")
    if not isinstance(raw_seed, dict):
        return {"ok": False, "error": "missing seed"}

    seed = DreamSeed(**{k: v for k, v in raw_seed.items() if k in DreamSeed.__dataclass_fields__})
    dream_settings = DreamSettings(**{
        k: v for k, v in (body.get("dream_settings") or {}).items()
        if k in DreamSettings.__dataclass_fields__
    })
    trigger = maybe_create_dream_trigger(
        seed,
        state,
        now,
        last_counterpart_message_at=_optional_dt(body, "last_counterpart_message_at"),
        engine_settings=settings,
        dream_settings=dream_settings,
        config=CONFIG,
        rng=_rng(body),
    )
    prompt = None
    if trigger is not None:
        prompt = render_dream_trigger(seed, state, config=CONFIG)
    return _respond_state(state, now, {"trigger": _jsonable(trigger), "prompt": prompt}, settings=settings)


def route_dream_tags(body: Dict[str, Any]) -> Dict[str, Any]:
    now = _now(body)
    state, _ = _load_state(body, now)
    settings = _settings(body)
    tags = [str(t) for t in (body.get("tags") or [])]
    applied = apply_dream_after_effect(
        state, tags, body_enabled=settings.body_cycle_enabled, config=CONFIG
    )
    card_created = _optional_dt(body, "card_created_at") or now
    state.last_dream_card_created_at = card_created
    return _respond_state(state, now, {"applied": applied}, settings=settings)


def route_definitions(body: Dict[str, Any]) -> Dict[str, Any]:
    """周期表、事件表、优先级、冷却——给前端展示和小衍查阅。"""
    return {
        "ok": True,
        "cycles": [
            {
                "key": c.key,
                "label": c.label,
                "description": c.description,
                "duration_hours": list(c.duration_hours),
                "reserve_growth": c.reserve_growth,
                "next_key": c.next_key,
            }
            for c in CONFIG.cycles.values()
        ],
        "events": [
            {
                "key": e.key,
                "label": e.label,
                "category": e.category,
                "duration_minutes": list(e.duration_minutes),
                "priority": scheduler.EVENT_PRIORITY.get(e.key, 99),
                "cooldown_hours": scheduler.EVENT_COOLDOWN_HOURS.get(e.key, 4.0),
                "strong": e.key in scheduler.STRONG_EVENTS,
            }
            for e in sorted(CONFIG.events.values(), key=lambda x: scheduler.EVENT_PRIORITY.get(x.key, 99))
        ],
        "body_fields": [
            {"key": f.key, "label": f.label, "minimum": f.minimum}
            for f in CONFIG.body_fields.values()
        ],
        "windows": {"morning": "05:30-10:30", "evening": "18:00-02:00", "night": "23:00-03:00"},
        "timezone": str(LOCAL_TZ),
    }


ROUTES = {
    "/check": route_check,
    "/tick": route_tick,
    "/view": route_view,
    "/event/start": route_event_start,
    "/cycle/enter": route_cycle_enter,
    "/delta": route_delta,
    "/settlement/prompt": route_settlement_prompt,
    "/settle": route_settle,
    "/dream/maybe": route_dream_maybe,
    "/dream/tags": route_dream_tags,
    "/definitions": route_definitions,
}


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    if hasattr(value, "__dataclass_fields__"):
        return {f: _jsonable(getattr(value, f)) for f in value.__dataclass_fields__}
    return str(value)


class Handler(BaseHTTPRequestHandler):
    server_version = "eventide-svc/1.0"

    def log_message(self, fmt, *args):  # 静音默认 stderr 日志
        pass

    def _send(self, status: int, payload: Dict[str, Any]) -> None:
        raw = json.dumps(_jsonable(payload), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self) -> bool:
        return not TOKEN or self.headers.get("X-Eventide-Token", "") == TOKEN

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._send(200, {"ok": True, "service": "eventide", "port": PORT,
                             "events": len(CONFIG.events), "cycles": len(CONFIG.cycles)})
            return
        if self.path.split("?")[0] == "/definitions":
            if not self._authorized():
                self._send(401, {"ok": False, "error": "unauthorized"})
                return
            self._send(200, route_definitions({}))
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        handler = ROUTES.get(path)
        if handler is None:
            self._send(404, {"ok": False, "error": f"unknown route: {path}"})
            return
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(body, dict):
                raise ValueError("body must be a JSON object")
        except Exception as exc:
            self._send(400, {"ok": False, "error": f"bad request: {exc}"})
            return

        try:
            self._send(200, handler(body))
        except Exception as exc:
            self._send(500, {"ok": False, "error": str(exc), "trace": traceback.format_exc(limit=6)})


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"eventide-svc listening on {HOST}:{PORT} "
          f"({len(CONFIG.events)} events, {len(CONFIG.cycles)} cycles, tz={LOCAL_TZ}, "
          f"auth={'on' if TOKEN else 'off'})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
