"""
Mobile status monitor — machines + plant servers (online/offline only).

Derives state from unit snapshots already ingested by cloud_agent.
Logs offline/online transitions for the History screen.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

# Agent posts ~every 10s — treat server offline after this gap
SERVER_OFFLINE_SEC = 90
# Cap in-memory / recent event reads
MAX_EVENTS = 400
EVENTS_COLLECTION = "status_events"
PREV_COLLECTION = "status_prev"

_MEMORY_EVENTS: list[dict] = []
_MEMORY_PREV: dict[str, dict] = {}  # unit_id -> {machines: {id: online}, server_online: bool}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        text = str(s).strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _age_sec(iso: str | None, now: datetime | None = None) -> float | None:
    dt = _parse_iso(iso)
    if not dt:
        return None
    now = now or datetime.now(timezone.utc)
    return max(0.0, (now - dt).total_seconds())


def machine_is_online(status: str | None) -> bool:
    s = str(status or "").strip().lower()
    if not s or s in ("—", "-", "unknown"):
        return False
    return s != "disconnected"


def server_is_online(payload: dict | None, now: datetime | None = None) -> bool:
    if not payload:
        return False
    age = _age_sec(payload.get("cloud_received_at") or payload.get("updated_at"), now)
    if age is None:
        return False
    return age <= SERVER_OFFLINE_SEC


def _entity_key(unit_id: str, kind: str, name: str) -> str:
    return f"{unit_id}|{kind}|{name}"


def _append_event(db, event: dict) -> None:
    event = dict(event)
    event.setdefault("at", _now_iso())
    if db is not None:
        try:
            db.collection(EVENTS_COLLECTION).add(event)
        except Exception as e:
            print(f"status_events write failed: {e}")
            _MEMORY_EVENTS.append(event)
            if len(_MEMORY_EVENTS) > MAX_EVENTS:
                del _MEMORY_EVENTS[: len(_MEMORY_EVENTS) - MAX_EVENTS]
    else:
        _MEMORY_EVENTS.append(event)
        if len(_MEMORY_EVENTS) > MAX_EVENTS:
            del _MEMORY_EVENTS[: len(_MEMORY_EVENTS) - MAX_EVENTS]

    # System push for locked phones (FCM) — offline only, once per transition
    if str(event.get("event") or "") == "offline":
        try:
            from push_service import notify_offline

            notify_offline(event)
        except Exception as e:
            print(f"FCM notify_offline failed: {e}")


def _load_prev(db, unit_id: str) -> dict:
    if db is not None:
        try:
            snap = db.collection(PREV_COLLECTION).document(unit_id).get(timeout=8.0)
            if snap.exists:
                return snap.to_dict() or {}
        except Exception as e:
            print(f"status_prev read failed: {e}")
    return dict(_MEMORY_PREV.get(unit_id) or {})


def _save_prev(db, unit_id: str, prev: dict) -> None:
    _MEMORY_PREV[unit_id] = prev
    if db is not None:
        try:
            db.collection(PREV_COLLECTION).document(unit_id).set(prev, merge=False)
        except Exception as e:
            print(f"status_prev write failed: {e}")


def process_ingest(db, unit_id: str, payload: dict) -> None:
    """Compare to previous snapshot; log machine/server online↔offline transitions."""
    now = datetime.now(timezone.utc)
    prev = _load_prev(db, unit_id)
    prev_machines: dict = dict(prev.get("machines") or {})
    prev_server = prev.get("server_online")

    new_machines: dict[str, bool] = {}
    for m in payload.get("machines") or []:
        mid = str(m.get("Machine No") or m.get("machine_no") or "").strip()
        if not mid:
            continue
        online = machine_is_online(m.get("Status"))
        new_machines[mid] = online
        was = prev_machines.get(mid)
        if was is None:
            # First sighting — if already offline, log once
            if not online:
                _append_event(
                    db,
                    {
                        "unit_id": unit_id,
                        "kind": "machine",
                        "name": mid,
                        "event": "offline",
                        "status": m.get("Status") or "Disconnected",
                    },
                )
        elif bool(was) != online:
            _append_event(
                db,
                {
                    "unit_id": unit_id,
                    "kind": "machine",
                    "name": mid,
                    "event": "online" if online else "offline",
                    "status": m.get("Status") or ("Online" if online else "Disconnected"),
                },
            )

    server_online = True  # ingest proves this server/agent is alive
    if prev_server is False:
        _append_event(
            db,
            {
                "unit_id": unit_id,
                "kind": "server",
                "name": unit_id,
                "event": "online",
                "status": "Online",
            },
        )
    elif prev_server is None:
        pass

    _save_prev(
        db,
        unit_id,
        {
            "machines": new_machines,
            "server_online": server_online,
            "updated_at": _now_iso(),
        },
    )


def mark_server_offline_if_stale(db, unit_id: str, payload: dict | None) -> None:
    """When reading status, if server went stale, log offline once."""
    now = datetime.now(timezone.utc)
    online = server_is_online(payload, now)
    prev = _load_prev(db, unit_id)
    was = prev.get("server_online")
    if was is True and not online:
        _append_event(
            db,
            {
                "unit_id": unit_id,
                "kind": "server",
                "name": unit_id,
                "event": "offline",
                "status": "Offline",
            },
        )
        prev["server_online"] = False
        prev["updated_at"] = _now_iso()
        _save_prev(db, unit_id, prev)


def build_mobile_status(db, load_unit_fn) -> dict[str, Any]:
    """Full status for both units — machines + servers only."""
    now = datetime.now(timezone.utc)
    units_out = []
    alarms = []

    for unit_id, label in (("unit_i", "Unit I"), ("unit_ii", "Unit II")):
        payload = None
        try:
            payload = load_unit_fn(unit_id)
        except Exception as e:
            print(f"mobile status load {unit_id}: {e}")

        mark_server_offline_if_stale(db, unit_id, payload)

        srv_online = server_is_online(payload, now)
        age = _age_sec(
            (payload or {}).get("cloud_received_at") or (payload or {}).get("updated_at"),
            now,
        )
        server_row = {
            "key": _entity_key(unit_id, "server", unit_id),
            "kind": "server",
            "unit_id": unit_id,
            "unit_label": label,
            "name": label + " Server",
            "online": srv_online,
            "status": "Online" if srv_online else "Offline",
            "last_seen": (payload or {}).get("cloud_received_at")
            or (payload or {}).get("updated_at")
            or None,
            "age_sec": int(age) if age is not None else None,
            "pc_name": (payload or {}).get("pc_name") or "",
        }
        if not srv_online:
            alarms.append(
                {
                    "key": server_row["key"],
                    "kind": "server",
                    "unit_id": unit_id,
                    "unit_label": label,
                    "name": server_row["name"],
                    "status": "Offline",
                    "since": server_row["last_seen"],
                }
            )

        machines = []
        for m in (payload or {}).get("machines") or []:
            mid = str(m.get("Machine No") or m.get("machine_no") or "").strip()
            if not mid:
                continue
            online = machine_is_online(m.get("Status"))
            # If whole server is offline, still show last known machine status
            row = {
                "key": _entity_key(unit_id, "machine", mid),
                "kind": "machine",
                "unit_id": unit_id,
                "unit_label": label,
                "name": mid,
                "online": online and srv_online,
                "status": (
                    "Offline"
                    if not srv_online
                    else ("Online" if online else "Disconnected")
                ),
                "raw_status": m.get("Status") or "—",
                "last_seen": m.get("Latest Ping") or m.get("Last Updated") or None,
                "department": m.get("Department") or "",
            }
            machines.append(row)
            # If plant server is down, only alarm on the server — not every machine
            if srv_online and not online:
                alarms.append(
                    {
                        "key": row["key"],
                        "kind": "machine",
                        "unit_id": unit_id,
                        "unit_label": label,
                        "name": mid,
                        "status": row["status"],
                        "since": row["last_seen"],
                    }
                )

        machines.sort(key=lambda r: r["name"])
        units_out.append(
            {
                "unit_id": unit_id,
                "unit_label": label,
                "server": server_row,
                "machines": machines,
                "counts": {
                    "machines": len(machines),
                    "online": sum(1 for x in machines if x["online"]),
                    "offline": sum(1 for x in machines if not x["online"]),
                },
            }
        )

    # Dedupe alarms by key
    seen = set()
    uniq_alarms = []
    for a in alarms:
        if a["key"] in seen:
            continue
        seen.add(a["key"])
        uniq_alarms.append(a)

    return {
        "ok": True,
        "polled_at": _now_iso(),
        "server_offline_after_sec": SERVER_OFFLINE_SEC,
        "units": units_out,
        "alarms": uniq_alarms,
        "alarm_count": len(uniq_alarms),
    }


def list_status_history(db, *, unit_id: str | None = None, limit: int = 100) -> list[dict]:
    limit = max(1, min(int(limit or 100), 300))
    rows: list[dict] = []

    if db is not None:
        try:
            from google.cloud import firestore as fs

            q = (
                db.collection(EVENTS_COLLECTION)
                .order_by("at", direction=fs.Query.DESCENDING)
                .limit(limit * 2 if unit_id else limit)
            )
            for snap in q.stream():
                d = snap.to_dict() or {}
                d["id"] = snap.id
                if unit_id and d.get("unit_id") != unit_id:
                    continue
                rows.append(d)
                if len(rows) >= limit:
                    break
            return rows
        except Exception as e:
            print(f"status_events list failed: {e}")

    mem = list(reversed(_MEMORY_EVENTS))
    if unit_id:
        mem = [e for e in mem if e.get("unit_id") == unit_id]
    return mem[:limit]
