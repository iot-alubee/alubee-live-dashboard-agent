"""Build history dashboard metrics from archived shift CSV."""

from __future__ import annotations

import io
from datetime import date, datetime, timedelta

import pandas as pd

from machine_registry import enrich_machine, filter_options

IDLE_STATES = {"break", "setting", "manpower", "noload", "powercut", "maintenance", "mould"}
SKIP_STATES = {"reconnection", "heartbeat", "shift_reset"}
IDLE_HISTORY_COLS = [
    ("Break", "break"),
    ("Setting", "setting"),
    ("Maintenance", "maintenance"),
    ("Mould", "mould"),
    ("No Load", "noload"),
    ("Man Power", "manpower"),
    ("Powercut", "powercut"),
    ("Without Notice", "without_notice"),
    ("IoT/Network", "disconnected"),
]
IDLE_CHART_COLORS = {
    "Break": "#22d3ee",
    "Setting": "#a78bfa",
    "Maintenance": "#f87171",
    "Mould": "#e879f9",
    "No Load": "#94a3b8",
    "Man Power": "#60a5fa",
    "Powercut": "#fde047",
    "Without Notice": "#fb923c",
    "IoT/Network": "#4ade80",
}
CYCLE_MIN_SEC = 3.0
CYCLE_MAX_SEC = 70.0
WITHOUT_NOTICE_GRACE_SEC = 5 * 60
EFF_HIGH = 80.0
EFF_MID = 50.0


def parse_shift_id(shift_id: str) -> tuple[str, datetime, datetime]:
    """Return shift label, start, end for archived shift id."""
    part, name = str(shift_id).rsplit("-", 1)
    day = datetime.strptime(part, "%Y-%m-%d")
    if name.upper() == "II":
        start = day.replace(hour=20, minute=0, second=0, microsecond=0)
        end = (day + timedelta(days=1)).replace(hour=8, minute=0, second=0, microsecond=0)
        label = "Shift II"
    else:
        start = day.replace(hour=8, minute=0, second=0, microsecond=0)
        end = day.replace(hour=20, minute=0, second=0, microsecond=0)
        label = "Shift I"
    return label, start, end


def _clock_in_shift(shift_start: datetime, shift_end: datetime, hhmm: str) -> datetime | None:
    if not hhmm:
        return None
    parts = str(hhmm).strip().split(":")
    if len(parts) < 2:
        return None
    h, m = int(parts[0]), int(parts[1])
    for base in (shift_start, shift_start + timedelta(days=1)):
        t = base.replace(hour=h, minute=m, second=0, microsecond=0)
        if shift_start <= t < shift_end:
            return t
    return None


def resolve_time_window(
    shift_start: datetime,
    shift_end: datetime,
    time_from: str = "",
    time_to: str = "",
) -> tuple[datetime, datetime]:
    window_start = shift_start
    window_end = shift_end
    if time_from:
        t = _clock_in_shift(shift_start, shift_end, time_from)
        if t is not None:
            window_start = t
    if time_to:
        t = _clock_in_shift(shift_start, shift_end, time_to)
        if t is not None and t > window_start:
            window_end = t
    return window_start, window_end


def parse_csv(csv_bytes: bytes) -> pd.DataFrame:
    if not csv_bytes:
        return pd.DataFrame(columns=["time", "machine_no", "state", "shot"])
    df = pd.read_csv(io.BytesIO(csv_bytes))
    for col in ["time", "machine_no", "state", "shot"]:
        if col not in df.columns:
            df[col] = None
    df = df[["time", "machine_no", "state", "shot"]].copy()
    df["time"] = pd.to_datetime(df["time"], errors="coerce")
    df["shot"] = pd.to_numeric(df["shot"], errors="coerce").fillna(0).astype(int)
    df["machine_no"] = df["machine_no"].astype(str)
    df["state"] = df["state"].astype(str).str.lower()
    return df.dropna(subset=["time"]).sort_values("time")


def format_idle_hm(seconds: float) -> str:
    if seconds <= 0:
        return "—"
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m = rem // 60
    if h and m:
        return f"{h}H {m}M"
    if h:
        return f"{h}H"
    if m:
        return f"{m}M"
    return "<1M"


def efficiency_band(eff: float | None) -> str:
    if eff is None:
        return "none"
    if eff >= EFF_HIGH:
        return "high"
    if eff >= EFF_MID:
        return "mid"
    return "low"


def _bank_without_notice(totals: dict, last_shot_time, end_t, wn_banked_until):
    if last_shot_time is None:
        return wn_banked_until
    candidate = pd.Timestamp(last_shot_time) + pd.Timedelta(seconds=WITHOUT_NOTICE_GRACE_SEC)
    start = wn_banked_until if wn_banked_until is not None else candidate
    start = max(start, candidate)
    if end_t > start:
        totals["without_notice"] += (pd.Timestamp(end_t) - start).total_seconds()
    return None


def build_idle_history(df_shift: pd.DataFrame, shift_end: datetime):
    if df_shift.empty:
        return [], {}

    useful = df_shift[
        df_shift["state"].isin(IDLE_STATES | {"production", "disconnected", "reconnection"})
    ].sort_values("time")
    shift_start = useful["time"].min() if not useful.empty else pd.Timestamp(shift_end) - pd.Timedelta(hours=12)
    shift_elapsed_sec = max((pd.Timestamp(shift_end) - pd.Timestamp(shift_start)).total_seconds(), 1.0)
    now = pd.Timestamp(shift_end)
    rows = []
    reason_keys = [c[1] for c in IDLE_HISTORY_COLS]

    for machine, g in useful.groupby("machine_no", sort=False):
        g = g.sort_values("time").reset_index(drop=True)
        totals = {k: 0.0 for k in reason_keys}
        idle_state = None
        idle_start = None
        disc_start = None
        in_production = False
        last_shot_time = None
        last_shot_val = None
        wn_banked_until = None
        resume_production_after_disc = False

        for _, ev in g.iterrows():
            state = str(ev["state"]).lower()
            t = pd.Timestamp(ev["time"])
            cur_shot = int(ev["shot"])

            if state in IDLE_STATES:
                if in_production:
                    wn_banked_until = _bank_without_notice(totals, last_shot_time, t, wn_banked_until)
                in_production = False
                last_shot_time = last_shot_val = wn_banked_until = None
                resume_production_after_disc = False
                if disc_start is not None:
                    totals["disconnected"] += max((t - disc_start).total_seconds(), 0)
                    disc_start = None
                if idle_state is None:
                    idle_state, idle_start = state, t
                elif state != idle_state:
                    if idle_start is not None:
                        totals[idle_state] += max((t - idle_start).total_seconds(), 0)
                    idle_state, idle_start = state, t
            elif state == "disconnected":
                if in_production:
                    wn_banked_until = _bank_without_notice(totals, last_shot_time, t, wn_banked_until)
                    resume_production_after_disc = last_shot_time is not None
                else:
                    resume_production_after_disc = False
                in_production = False
                if idle_state is not None and idle_start is not None:
                    totals[idle_state] += max((t - idle_start).total_seconds(), 0)
                idle_state = idle_start = None
                if disc_start is None:
                    disc_start = t
            elif state == "reconnection":
                if disc_start is not None:
                    totals["disconnected"] += max((t - disc_start).total_seconds(), 0)
                    disc_start = None
                if resume_production_after_disc and last_shot_time is not None:
                    in_production = True
                    resume_production_after_disc = False
            elif state == "production":
                if idle_state is not None and idle_start is not None:
                    totals[idle_state] += max((t - idle_start).total_seconds(), 0)
                idle_state = idle_start = None
                resume_production_after_disc = False
                if disc_start is not None:
                    totals["disconnected"] += max((t - disc_start).total_seconds(), 0)
                    disc_start = None
                if not in_production:
                    in_production = True
                    last_shot_time, last_shot_val = t, cur_shot
                    wn_banked_until = None
                elif last_shot_val is not None and cur_shot > last_shot_val:
                    wn_banked_until = _bank_without_notice(totals, last_shot_time, t, wn_banked_until)
                    last_shot_time, last_shot_val = t, cur_shot
                    wn_banked_until = None
                elif last_shot_val is not None and cur_shot < last_shot_val:
                    last_shot_time, last_shot_val = t, cur_shot
                    wn_banked_until = None

        if in_production and last_shot_time is not None:
            _bank_without_notice(totals, last_shot_time, now, wn_banked_until)
        if idle_state is not None and idle_start is not None:
            totals[idle_state] += max((now - idle_start).total_seconds(), 0)
        if disc_start is not None:
            totals["disconnected"] += max((now - disc_start).total_seconds(), 0)

        total_idle_sec = sum(float(totals.get(k, 0.0) or 0.0) for k in reason_keys)
        loss_pct = (total_idle_sec / shift_elapsed_sec) * 100.0
        display = {"Machine No": machine, "_total_idle_sec": total_idle_sec, "_efficiency_loss_pct": round(loss_pct, 1)}
        for label, key in IDLE_HISTORY_COLS:
            sec = totals[key]
            display[label] = format_idle_hm(sec) if sec > 0 else "-"
        display["Total Idle"] = format_idle_hm(total_idle_sec) if total_idle_sec > 0 else "-"
        display["Efficiency Loss"] = f"{loss_pct:.1f}%"
        rows.append(display)

    rows.sort(key=lambda r: str(r.get("Machine No", "")))
    return rows, shift_elapsed_sec


def compute_shot_deltas(df: pd.DataFrame) -> pd.DataFrame:
    work = df[df["state"] == "production"].copy()
    parts = []
    for _, g in work.groupby("machine_no", sort=False):
        g = g.sort_values("time").copy()
        g["prev_shot"] = g["shot"].shift(1)
        g["cycle_sec"] = (g["time"] - g["time"].shift(1)).dt.total_seconds()
        inc = g[(g["prev_shot"].notna()) & (g["shot"] > g["prev_shot"])].copy()
        if not inc.empty:
            parts.append(inc)
    if not parts:
        return pd.DataFrame(columns=["time", "machine_no", "shot", "prev_shot", "cycle_sec", "shots_added"])
    out = pd.concat(parts, ignore_index=True)
    out["shots_added"] = out["shot"] - out["prev_shot"]
    return out


def shots_produced(df_all: pd.DataFrame, machine: str, shift_start: pd.Timestamp) -> int:
    m = df_all[(df_all["machine_no"] == machine) & (df_all["state"] == "production")].sort_values("time")
    m = m[m["time"] >= shift_start]
    if m.empty:
        return 0
    total = 0
    prev = None
    for _, row in m.iterrows():
        s = int(row["shot"])
        if prev is not None and s > prev:
            total += s - prev
        prev = s
    return total


def maintenance_spells(df: pd.DataFrame) -> list[dict]:
    spells = []
    for machine, g in df.sort_values("time").groupby("machine_no", sort=False):
        g = g.sort_values("time").reset_index(drop=True)
        in_maint = False
        start = None
        prev_t = None
        for _, ev in g.iterrows():
            state = str(ev["state"]).lower()
            t = pd.Timestamp(ev["time"])
            if state == "maintenance":
                if not in_maint:
                    start = t
                    in_maint = True
            elif in_maint:
                end = prev_t or t
                dur = max((end - start).total_seconds(), 60)
                spells.append(
                    {
                        "machine_no": machine,
                        "from": start.strftime("%H:%M:%S"),
                        "to": end.strftime("%H:%M:%S"),
                        "duration": format_idle_hm(dur),
                        "duration_sec": int(dur),
                    }
                )
                in_maint = False
                start = None
            prev_t = t
        if in_maint and start is not None:
            end = prev_t or start
            dur = max((end - start).total_seconds(), 60)
            spells.append(
                {
                    "machine_no": machine,
                    "from": start.strftime("%H:%M:%S"),
                    "to": end.strftime("%H:%M:%S"),
                    "duration": format_idle_hm(dur),
                    "duration_sec": int(dur),
                }
            )
    spells.sort(key=lambda x: (-x["duration_sec"], x["machine_no"]))
    return spells


def hourly_shot_chart(deltas: pd.DataFrame, shift_start: datetime, shift_end: datetime) -> dict:
    if deltas.empty:
        return {"labels": [], "datasets": []}
    d = deltas.copy()
    d["hour_start"] = d["time"].dt.floor("h")
    grouped = d.groupby(["hour_start", "machine_no"], as_index=False)["shots_added"].sum()
    hours = pd.date_range(
        pd.Timestamp(shift_start).floor("h"),
        pd.Timestamp(shift_end).floor("h"),
        freq="h",
        inclusive="left",
    )
    labels = [f"{t.strftime('%H:%M')}-{(t + pd.Timedelta(hours=1)).strftime('%H:%M')}" for t in hours]
    machines = sorted(grouped["machine_no"].unique().tolist())
    colors = ["#4cc9f0", "#4361ee", "#3a0ca3", "#7209b7", "#f72585", "#4ade80", "#fbbf24", "#fb7185", "#38bdf8", "#a78bfa"]
    datasets = []
    for i, machine in enumerate(machines):
        mdata = grouped[grouped["machine_no"] == machine].set_index("hour_start")
        values = [int(mdata.loc[h, "shots_added"]) if h in mdata.index else 0 for h in hours]
        datasets.append({"label": machine, "data": values, "backgroundColor": colors[i % len(colors)], "borderWidth": 0})
    return {"labels": labels, "datasets": datasets}


def build_history_dashboard(
    *,
    unit_id: str,
    shift_id: str,
    csv_bytes: bytes,
    department: str = "",
    supervisor: str = "",
    machine: str = "",
    time_from: str = "",
    time_to: str = "",
) -> dict:
    shift_name, shift_start, shift_end = parse_shift_id(shift_id)
    window_start, window_end = resolve_time_window(shift_start, shift_end, time_from, time_to)
    shift_date = datetime.strptime(shift_id.rsplit("-", 1)[0], "%Y-%m-%d").date()
    df = parse_csv(csv_bytes)
    if not df.empty:
        df = df[(df["time"] >= window_start) & (df["time"] < window_end)].copy()

    idle_rows, shift_elapsed_sec = build_idle_history(df, window_end)
    window_elapsed_sec = max((pd.Timestamp(window_end) - pd.Timestamp(window_start)).total_seconds(), 1.0)

    idle_rows_with_secs = []
    for row in idle_rows:
        machine_no = row["Machine No"]
        meta = enrich_machine(unit_id, machine_no, shift_name, shift_date)
        row = dict(row)
        row["Unit"] = meta["unit"]
        row["Department"] = meta["department"]
        row["Supervisor"] = meta["supervisor"]
        row["_idle_seconds"] = _idle_seconds_for_machine(df[df["machine_no"] == machine_no], window_end)
        idle_rows_with_secs.append(row)

    deltas = compute_shot_deltas(df)
    avg_cycles = {}
    if not deltas.empty:
        valid = deltas[(deltas["cycle_sec"] >= CYCLE_MIN_SEC) & (deltas["cycle_sec"] <= CYCLE_MAX_SEC)]
        if not valid.empty:
            avg_cycles = valid.groupby("machine_no")["cycle_sec"].mean().to_dict()

    machines_out = []
    ts_start = pd.Timestamp(window_start)
    reg_machines = filter_options(unit_id, shift_name, shift_date)["machines"]
    all_machines = sorted(set(df["machine_no"].unique().tolist()) | set(reg_machines))

    for machine_no in all_machines:
        meta = enrich_machine(unit_id, machine_no, shift_name, shift_date)
        if department and meta["department"] != department:
            continue
        if supervisor and meta["supervisor"] != supervisor:
            continue
        if machine and machine_no != machine:
            continue

        shots = shots_produced(df, machine_no, ts_start)
        avg_cycle = avg_cycles.get(machine_no)
        efficiency = None
        if shots == 0:
            efficiency = 0.0
        elif avg_cycle and avg_cycle > 0:
            expected = window_elapsed_sec / avg_cycle
            efficiency = (shots / expected) * 100.0 if expected > 0 else 0.0

        idle_row = next((r for r in idle_rows_with_secs if r.get("Machine No") == machine_no), None)

        machines_out.append(
            {
                "Machine No": machine_no,
                "Department": meta["department"],
                "Supervisor": meta["supervisor"],
                "Shots": shots,
                "Avg Cycle Time": f"{avg_cycle:.1f}s" if avg_cycle else "—",
                "Efficiency": f"{efficiency:.1f}%" if efficiency is not None else "—",
                "EfficiencyDir": efficiency_band(efficiency),
                "Efficiency Loss": idle_row.get("Efficiency Loss", "—") if idle_row else "—",
                "Total Idle": idle_row.get("Total Idle", "—") if idle_row else "—",
            }
        )

    filtered_idle = [r for r in idle_rows_with_secs if r.get("Machine No") in {m["Machine No"] for m in machines_out}]

    eff_vals = []
    loss_vals = []
    total_shots = 0
    machines_high = 0
    machines_low = 0
    for m in machines_out:
        total_shots += int(m.get("Shots") or 0)
        try:
            eff = float(str(m.get("Efficiency", "")).replace("%", ""))
            eff_vals.append(eff)
            if eff > 80:
                machines_high += 1
            if eff < 30:
                machines_low += 1
        except Exception:
            pass
        ir = next((r for r in filtered_idle if r.get("Machine No") == m["Machine No"]), None)
        if ir:
            loss_vals.append(float(ir.get("_efficiency_loss_pct") or 0))
    maint_spells = maintenance_spells(df)
    if machine:
        maint_spells = [s for s in maint_spells if s["machine_no"] == machine]
    maint_sec = sum(s["duration_sec"] for s in maint_spells)

    overall_eff = round(sum(eff_vals) / len(eff_vals), 1) if eff_vals else 0.0
    overall_loss = round(sum(loss_vals) / len(loss_vals), 1) if loss_vals else 0.0

    idle_totals = {label: 0.0 for label, _ in IDLE_HISTORY_COLS}
    for row in filtered_idle:
        secs = row.get("_idle_seconds") or {}
        for label, key in IDLE_HISTORY_COLS:
            idle_totals[label] += float(secs.get(key, 0) or 0)

    idle_chart_labels = [k for k, v in idle_totals.items() if v > 0]
    idle_chart_values = [round(idle_totals[k] / 60, 1) for k in idle_chart_labels]

    eff_chart = {
        "labels": [m["Machine No"] for m in machines_out],
        "datasets": [
            {
                "label": "Efficiency %",
                "data": [float(str(m["Efficiency"]).replace("%", "")) if m["Efficiency"] != "—" else 0 for m in machines_out],
                "backgroundColor": "#4ade80",
            }
        ],
    }

    return {
        "ok": True,
        "unit_id": unit_id,
        "shift_id": shift_id,
        "shift_name": shift_name,
        "shift_range": f"{window_start.strftime('%d %b %H:%M')} – {window_end.strftime('%d %b %H:%M')}",
        "time_filter_active": bool(time_from or time_to),
        "shift_date": shift_date.isoformat(),
        "summary": {
            "machines": len(machines_out),
            "total_shots": total_shots,
            "overall_efficiency": overall_eff,
            "overall_loss": overall_loss,
            "machines_above_80": machines_high,
            "machines_below_30": machines_low,
            "maintenance_time": format_idle_hm(maint_sec),
            "maintenance_minutes": round(maint_sec / 60, 1),
            "row_count": len(df),
        },
        "machines": machines_out,
        "idle_history": filtered_idle,
        "idle_columns": [c[0] for c in IDLE_HISTORY_COLS] + ["Total Idle", "Efficiency Loss"],
        "maintenance": maint_spells,
        "chart_shots": hourly_shot_chart(
            deltas[deltas["machine_no"].isin({m["Machine No"] for m in machines_out})] if not deltas.empty else deltas,
            window_start,
            window_end,
        ),
        "chart_idle": {
            "labels": idle_chart_labels,
            "datasets": [{
                "data": idle_chart_values,
                "backgroundColor": [IDLE_CHART_COLORS.get(lbl, "#94a3b8") for lbl in idle_chart_labels],
                "borderColor": "#1a2533",
                "borderWidth": 2,
            }],
        },
        "chart_efficiency": eff_chart,
        "filters": filter_options(unit_id, shift_name, shift_date),
    }


def _idle_seconds_for_machine(g: pd.DataFrame, shift_end: datetime) -> dict:
    rows, _ = build_idle_history(g, shift_end)
    if not rows:
        return {}
    # rebuild totals by running simplified loop - duplicate from build_idle_history internals
    useful = g[g["state"].isin(IDLE_STATES | {"production", "disconnected", "reconnection"})].sort_values("time")
    if useful.empty:
        return {}
    reason_keys = [c[1] for c in IDLE_HISTORY_COLS]
    totals = {k: 0.0 for k in reason_keys}
    now = pd.Timestamp(shift_end)
    idle_state = idle_start = disc_start = None
    in_production = False
    last_shot_time = last_shot_val = wn_banked_until = None
    resume = False
    for _, ev in useful.iterrows():
        state = str(ev["state"]).lower()
        t = pd.Timestamp(ev["time"])
        cur_shot = int(ev["shot"])
        if state in IDLE_STATES:
            if in_production:
                wn_banked_until = _bank_without_notice(totals, last_shot_time, t, wn_banked_until)
            in_production = False
            last_shot_time = last_shot_val = wn_banked_until = None
            resume = False
            if disc_start is not None:
                totals["disconnected"] += max((t - disc_start).total_seconds(), 0)
                disc_start = None
            if idle_state is None:
                idle_state, idle_start = state, t
            elif state != idle_state:
                if idle_start is not None:
                    totals[idle_state] += max((t - idle_start).total_seconds(), 0)
                idle_state, idle_start = state, t
        elif state == "disconnected":
            if in_production:
                wn_banked_until = _bank_without_notice(totals, last_shot_time, t, wn_banked_until)
                resume = last_shot_time is not None
            in_production = False
            if idle_state and idle_start:
                totals[idle_state] += max((t - idle_start).total_seconds(), 0)
            idle_state = idle_start = None
            if disc_start is None:
                disc_start = t
        elif state == "production":
            if idle_state and idle_start:
                totals[idle_state] += max((t - idle_start).total_seconds(), 0)
            idle_state = idle_start = None
            if disc_start is not None:
                totals["disconnected"] += max((t - disc_start).total_seconds(), 0)
                disc_start = None
            if not in_production:
                in_production = True
                last_shot_time, last_shot_val = t, cur_shot
            elif last_shot_val is not None and cur_shot > last_shot_val:
                wn_banked_until = _bank_without_notice(totals, last_shot_time, t, wn_banked_until)
                last_shot_time, last_shot_val = t, cur_shot
    if in_production and last_shot_time:
        _bank_without_notice(totals, last_shot_time, now, wn_banked_until)
    if idle_state and idle_start:
        totals[idle_state] += max((now - idle_start).total_seconds(), 0)
    if disc_start:
        totals["disconnected"] += max((now - disc_start).total_seconds(), 0)
    return totals
