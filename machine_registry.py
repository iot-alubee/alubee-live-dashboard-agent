"""Machine master lookup for history filters (Unit I / Unit II JSON in data/)."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
_cache: dict[str, dict] = {}


def _load(unit_id: str) -> dict:
    if unit_id in _cache:
        return _cache[unit_id]
    path = DATA_DIR / f"machines_{unit_id}.json"
    if not path.is_file():
        _cache[unit_id] = {"swap_anchor_monday": "2026-07-27", "machines": []}
        return _cache[unit_id]
    _cache[unit_id] = json.loads(path.read_text(encoding="utf-8"))
    return _cache[unit_id]


def monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def is_supervisor_swapped(unit_id: str, on_date: date | None = None) -> bool:
    on_date = on_date or date.today()
    data = _load(unit_id)
    anchor = datetime.strptime(data.get("swap_anchor_monday", "2026-07-27"), "%Y-%m-%d").date()
    anchor = monday_of(anchor)
    weeks = (monday_of(on_date) - anchor).days // 7
    return weeks % 2 == 1


def supervisor_for_shift(meta: dict, shift_name: str, unit_id: str, on_date: date | None = None) -> str:
    s1 = meta.get("incharge_shift_i", "")
    s2 = meta.get("incharge_shift_ii", "")
    if is_supervisor_swapped(unit_id, on_date):
        s1, s2 = s2, s1
    if "II" in str(shift_name).upper():
        return s2
    return s1


def lookup(unit_id: str, machine_no: str) -> dict | None:
    for m in _load(unit_id).get("machines") or []:
        if str(m.get("machine_no")) == str(machine_no):
            return m
    return None


def enrich_machine(unit_id: str, machine_no: str, shift_name: str, on_date: date | None = None) -> dict:
    meta = lookup(unit_id, machine_no)
    if not meta:
        return {"machine_no": machine_no, "unit": "—", "department": "—", "supervisor": "—", "ip": "—"}
    return {
        "machine_no": machine_no,
        "unit": meta.get("unit", "—"),
        "department": meta.get("department", "—"),
        "supervisor": supervisor_for_shift(meta, shift_name, unit_id, on_date),
        "ip": meta.get("ip", "—"),
    }


def filter_options(unit_id: str, shift_name: str, on_date: date | None = None) -> dict:
    on_date = on_date or date.today()
    machines = _load(unit_id).get("machines") or []
    departments = sorted({m.get("department") for m in machines if m.get("department")})
    supervisors = sorted(
        {
            supervisor_for_shift(m, shift_name, unit_id, on_date)
            for m in machines
            if supervisor_for_shift(m, shift_name, unit_id, on_date)
        }
    )
    supervisors_by_department: dict[str, set[str]] = {}
    for m in machines:
        dept = m.get("department") or ""
        sup = supervisor_for_shift(m, shift_name, unit_id, on_date)
        if dept and sup:
            supervisors_by_department.setdefault(dept, set()).add(sup)
    machine_nos = sorted({str(m.get("machine_no")) for m in machines if m.get("machine_no")})
    machines_detail = []
    for m in machines:
        mn = str(m.get("machine_no") or "")
        if not mn:
            continue
        dept = m.get("department") or ""
        sup = supervisor_for_shift(m, shift_name, unit_id, on_date)
        machines_detail.append({"machine_no": mn, "department": dept, "supervisor": sup})
    return {
        "departments": departments,
        "supervisors": supervisors,
        "supervisors_by_department": {k: sorted(v) for k, v in supervisors_by_department.items()},
        "machines": machine_nos,
        "machines_detail": machines_detail,
        "idle_types": [
            "Break",
            "Setting",
            "Maintenance",
            "Mould",
            "No Load",
            "Man Power",
            "Powercut",
            "Without Notice",
            "IoT/Network",
        ],
    }


def live_filter_options(unit_id: str, shift_name: str, on_date: date | None = None) -> dict:
    """Filter metadata for the Live tab (matches plant dashboard behaviour)."""
    opts = filter_options(unit_id, shift_name, on_date)
    return {
        "departments": opts["departments"],
        "supervisors": opts["supervisors"],
        "supervisors_by_department": opts["supervisors_by_department"],
        "statuses": ["All", "Running", "Idle", "Disconnected", "Reset"],
        "supervisor_swapped": is_supervisor_swapped(unit_id, on_date),
    }
