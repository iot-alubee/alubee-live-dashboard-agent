"""
Cloud Run API — low-cost live snapshot store for plant units.

  POST /ingest   (PC agents)   Header: X-API-Key
  GET  /live?unit=unit_i|unit_ii
  GET  /health
  GET  /         simple HTML poller (optional)

Uses Firestore when available; falls back to in-memory for local test.
"""

from __future__ import annotations

import base64
import os
from datetime import date, datetime, timezone

from flask import Flask, jsonify, request, render_template

from archive_service import (
    ARCHIVE_COLLECTION,
    archive_shift_csv,
    download_shift_csv,
    get_shift_archive,
    list_archived_shifts,
    should_archive_shift,
)
from history_analytics import build_history_dashboard
from machine_registry import enrich_machine, filter_options, live_filter_options

app = Flask(__name__, static_folder="static", template_folder="templates")

INGEST_API_KEY = os.environ.get("INGEST_API_KEY", "").strip()
USE_FIRESTORE = os.environ.get("USE_FIRESTORE", "1").strip() not in ("0", "false", "no")
FIRESTORE_DATABASE = os.environ.get("FIRESTORE_DATABASE", "(default)").strip() or "(default)"
GCS_ARCHIVE_BUCKET = os.environ.get("GCS_ARCHIVE_BUCKET", "").strip()
# Cloud Run service lives in alubee-prod; Firestore snapshots + shift_archives are there.
# GCS archive bucket may be in live-monitor-agent (cross-project bucket IAM).
GCP_PROJECT = (
    os.environ.get("GOOGLE_CLOUD_PROJECT")
    or os.environ.get("GCP_PROJECT")
    or os.environ.get("GCLOUD_PROJECT")
    or "alubee-prod"
).strip()

# In-memory fallback: { unit_id: payload }
_MEMORY: dict = {}
_db_error = None
_storage_error = None

_db = None
_storage = None
if USE_FIRESTORE:
    try:
        from google.cloud import firestore

        _db = firestore.Client(project=GCP_PROJECT, database=FIRESTORE_DATABASE)
        print(f"Firestore client OK project={GCP_PROJECT} database={FIRESTORE_DATABASE}")
    except Exception as e:
        _db_error = str(e)
        print(f"Firestore unavailable ({e}) — using memory store")
        _db = None

if GCS_ARCHIVE_BUCKET:
    try:
        from google.cloud import storage

        _storage = storage.Client(project=GCP_PROJECT)
        print(f"GCS client OK project={GCP_PROJECT} bucket={GCS_ARCHIVE_BUCKET}")
    except Exception as e:
        _storage_error = str(e)
        print(f"GCS unavailable ({e})")
        _storage = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _check_ingest_key() -> bool:
    if not INGEST_API_KEY:
        # Dev mode: allow if key not configured (local only — set key in Cloud Run)
        return True
    return request.headers.get("X-API-Key", "") == INGEST_API_KEY


def _save_unit(unit_id: str, payload: dict) -> None:
    payload = dict(payload)
    payload["unit_id"] = unit_id
    payload["cloud_received_at"] = _now_iso()
    if _db is not None:
        _db.collection("units").document(unit_id).set(payload, merge=False)
    else:
        _MEMORY[unit_id] = payload


def _load_unit(unit_id: str):
    if _db is not None:
        snap = _db.collection("units").document(unit_id).get()
        if snap.exists:
            return snap.to_dict()
        return None
    return _MEMORY.get(unit_id)


def _enrich_live_payload(unit_id: str, data: dict) -> dict:
    """Add registry Department/Supervisor and filter options (same as plant dashboard)."""
    shift_name = str(data.get("shift_name") or "")
    out = dict(data)

    machines = []
    for m in data.get("machines") or []:
        row = dict(m)
        mid = row.get("Machine No") or row.get("machine_no")
        if mid:
            meta = enrich_machine(unit_id, str(mid), shift_name)
            if not row.get("Department"):
                row["Department"] = meta["department"]
            if not row.get("Supervisor"):
                row["Supervisor"] = meta["supervisor"]
            if not row.get("Unit"):
                row["Unit"] = meta["unit"]
        machines.append(row)
    out["machines"] = machines

    idle_rows = []
    for r in data.get("idle_history") or []:
        row = dict(r)
        mid = row.get("Machine No")
        if mid:
            meta = enrich_machine(unit_id, str(mid), shift_name)
            if not row.get("Department"):
                row["Department"] = meta["department"]
            if not row.get("Supervisor"):
                row["Supervisor"] = meta["supervisor"]
        idle_rows.append(row)
    out["idle_history"] = idle_rows

    out["filters"] = _live_filters_from_snapshot(unit_id, shift_name, machines)
    return out


def _live_filters_from_snapshot(unit_id: str, shift_name: str, machines: list) -> dict:
    """Registry options merged with supervisors/depts actually present in the snapshot."""
    base = live_filter_options(unit_id, shift_name)
    depts = set(base.get("departments") or [])
    sups = set(base.get("supervisors") or [])
    sup_by_dept: dict[str, set[str]] = {
        k: set(v) for k, v in (base.get("supervisors_by_department") or {}).items()
    }
    for m in machines or []:
        dept = str(m.get("Department") or "").strip()
        sup = str(m.get("Supervisor") or "").strip()
        if dept and dept not in ("—", "-"):
            depts.add(dept)
            if sup and sup not in ("—", "-"):
                sup_by_dept.setdefault(dept, set()).add(sup)
        if sup and sup not in ("—", "-"):
            sups.add(sup)
    return {
        **base,
        "departments": sorted(depts),
        "supervisors": sorted(sups),
        "supervisors_by_department": {k: sorted(v) for k, v in sup_by_dept.items()},
    }


@app.get("/health")
def health():
    return jsonify(
        {
            "ok": True,
            "firestore": _db is not None,
            "firestore_database": FIRESTORE_DATABASE,
            "firestore_error": _db_error,
            "gcp_project": GCP_PROJECT,
            "gcs_bucket": GCS_ARCHIVE_BUCKET or None,
            "gcs": _storage is not None and bool(GCS_ARCHIVE_BUCKET),
            "gcs_error": _storage_error,
            "archive_collection": ARCHIVE_COLLECTION,
            "time": _now_iso(),
        }
    )


@app.post("/ingest")
def ingest():
    if not _check_ingest_key():
        return jsonify({"ok": False, "error": "unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    unit_id = str(data.get("unit_id") or "").strip().lower()
    if unit_id not in ("unit_i", "unit_ii"):
        return jsonify({"ok": False, "error": "unit_id must be unit_i or unit_ii"}), 400

    # Keep payload small — agents should already send a snapshot, not raw JSONL
    machines = data.get("machines") or []
    if not isinstance(machines, list):
        return jsonify({"ok": False, "error": "machines must be a list"}), 400
    if len(machines) > 64:
        return jsonify({"ok": False, "error": "too many machines"}), 400

    payload = {
        "unit_id": unit_id,
        "updated_at": data.get("updated_at") or _now_iso(),
        "shift_name": data.get("shift_name") or "",
        "shift_range": data.get("shift_range") or "",
        "counts": data.get("counts") or {},
        "machines": machines,
        "idle_history": data.get("idle_history") or [],
        "idle_columns": data.get("idle_columns") or [],
        "chart": data.get("chart") or {"labels": [], "datasets": []},
        "pc_name": data.get("pc_name") or "",
        "agent_version": data.get("agent_version") or "1.0.0",
    }
    try:
        _save_unit(unit_id, payload)
    except Exception as e:
        print(f"INGEST Firestore error: {e}")
        return jsonify(
            {
                "ok": False,
                "error": "firestore_write_failed",
                "detail": str(e),
                "firestore_database": FIRESTORE_DATABASE,
            }
        ), 500
    return jsonify({"ok": True, "unit_id": unit_id, "machines": len(machines)})


@app.post("/archive")
def archive():
    """Receive shift CSV from plant PC; store in GCS + Firestore metadata."""
    if not _check_ingest_key():
        return jsonify({"ok": False, "error": "unauthorized"}), 401

    unit_id = str(request.form.get("unit_id") or request.args.get("unit_id") or "").strip().lower()
    shift_id = str(request.form.get("shift_id") or request.args.get("shift_id") or "").strip()
    pc_name = str(request.form.get("pc_name") or request.args.get("pc_name") or "").strip()
    try:
        row_count = int(request.form.get("row_count") or request.args.get("row_count") or 0)
    except Exception:
        row_count = 0

    csv_bytes = b""
    if "file" in request.files:
        csv_bytes = request.files["file"].read()
    elif request.data:
        csv_bytes = request.data

    if not unit_id or not shift_id:
        return jsonify({"ok": False, "error": "unit_id and shift_id required"}), 400
    if unit_id not in ("unit_i", "unit_ii"):
        return jsonify({"ok": False, "error": "unit_id must be unit_i or unit_ii"}), 400
    if not csv_bytes:
        return jsonify({"ok": False, "error": "csv file or body required"}), 400

    if not should_archive_shift(shift_id):
        return jsonify(
            {
                "ok": True,
                "skipped": True,
                "reason": "shift date not after 2026-08-31",
                "shift_id": shift_id,
            }
        )

    try:
        result = archive_shift_csv(
            db=_db,
            storage_client=_storage,
            unit_id=unit_id,
            shift_id=shift_id,
            csv_bytes=csv_bytes,
            row_count=row_count,
            pc_name=pc_name,
        )
        return jsonify(result)
    except Exception as e:
        print(f"ARCHIVE error: {e}")
        return jsonify({"ok": False, "error": "archive_failed", "detail": str(e)}), 500


@app.get("/api/history/shifts")
def history_shifts():
    unit_id = str(request.args.get("unit") or "unit_i").strip().lower()
    if unit_id not in ("unit_i", "unit_ii"):
        return jsonify({"ok": False, "error": "unit must be unit_i or unit_ii"}), 400
    date_from = str(request.args.get("from") or "").strip() or None
    date_to = str(request.args.get("to") or "").strip() or None
    try:
        rows = list_archived_shifts(_db, unit_id, date_from=date_from, date_to=date_to)
        return jsonify({"ok": True, "unit_id": unit_id, "shifts": rows, "count": len(rows)})
    except Exception as e:
        return jsonify({"ok": False, "error": "history_list_failed", "detail": str(e)}), 500


@app.get("/api/history/filters")
def history_filters():
    unit_id = str(request.args.get("unit") or "unit_i").strip().lower()
    date_str = str(request.args.get("date") or "").strip()
    shift = str(request.args.get("shift") or "I").strip().upper()
    if unit_id not in ("unit_i", "unit_ii"):
        return jsonify({"ok": False, "error": "unit must be unit_i or unit_ii"}), 400
    if not date_str:
        return jsonify({"ok": False, "error": "date required (YYYY-MM-DD)"}), 400
    try:
        on_date = date.fromisoformat(date_str)
    except ValueError:
        return jsonify({"ok": False, "error": "invalid date"}), 400
    shift_name = "Shift II" if shift == "II" else "Shift I"
    return jsonify({"ok": True, "filters": filter_options(unit_id, shift_name, on_date)})


def _strip_idle_internals(payload: dict) -> dict:
    for row in payload.get("idle_history") or []:
        for k in list(row.keys()):
            if k.startswith("_"):
                row.pop(k, None)
    return payload


def _history_process_payload(
    *,
    unit_id: str,
    shift_id: str,
    csv_bytes: bytes,
    department: str = "",
    supervisor: str = "",
    machine: str = "",
    time_from: str = "",
    time_to: str = "",
    archive_meta: dict | None = None,
) -> dict:
    payload = build_history_dashboard(
        unit_id=unit_id,
        shift_id=shift_id,
        csv_bytes=csv_bytes,
        department=department,
        supervisor=supervisor,
        machine=machine,
        time_from=time_from,
        time_to=time_to,
    )
    if archive_meta:
        payload["archive"] = {
            "archived_at": archive_meta.get("archived_at"),
            "row_count": archive_meta.get("row_count"),
            "bytes": archive_meta.get("bytes"),
            "gcs_path": archive_meta.get("gcs_path"),
        }
    return _strip_idle_internals(payload)


@app.get("/api/history/day")
def history_day():
    """Download archived CSV(s) for a calendar day (GCS). Client caches for fast re-filter."""
    unit_id = str(request.args.get("unit") or "unit_i").strip().lower()
    date_str = str(request.args.get("date") or "").strip()
    if unit_id not in ("unit_i", "unit_ii"):
        return jsonify({"ok": False, "error": "unit must be unit_i or unit_ii"}), 400
    if not date_str:
        return jsonify({"ok": False, "error": "date required (YYYY-MM-DD)"}), 400
    if _storage is None:
        return jsonify({"ok": False, "error": "gcs_not_configured"}), 503

    shifts = {}
    try:
        for suffix in ("I", "II"):
            shift_id = f"{date_str}-{suffix}"
            meta = get_shift_archive(_db, unit_id, shift_id)
            if not meta:
                continue
            csv_bytes = download_shift_csv(_storage, meta["gcs_path"])
            shifts[suffix] = {
                "shift_id": shift_id,
                "csv_b64": base64.b64encode(csv_bytes).decode("ascii"),
                "archive": {
                    "archived_at": meta.get("archived_at"),
                    "row_count": meta.get("row_count"),
                    "bytes": meta.get("bytes"),
                    "gcs_path": meta.get("gcs_path"),
                },
            }
        if not shifts:
            return jsonify({"ok": False, "error": "no_archives_for_date", "date": date_str}), 404
        return jsonify({"ok": True, "unit_id": unit_id, "date": date_str, "shifts": shifts})
    except Exception as e:
        print(f"HISTORY day error: {e}")
        return jsonify({"ok": False, "error": "history_day_failed", "detail": str(e)}), 500


@app.post("/api/history/process")
def history_process():
    """Process cached CSV with filters — no GCS download."""
    body = request.get_json(silent=True) or {}
    unit_id = str(body.get("unit") or "unit_i").strip().lower()
    shift_id = str(body.get("shift_id") or "").strip()
    csv_b64 = str(body.get("csv_b64") or "").strip()
    if unit_id not in ("unit_i", "unit_ii"):
        return jsonify({"ok": False, "error": "unit must be unit_i or unit_ii"}), 400
    if not shift_id or not csv_b64:
        return jsonify({"ok": False, "error": "shift_id and csv_b64 required"}), 400
    try:
        csv_bytes = base64.b64decode(csv_b64)
        payload = _history_process_payload(
            unit_id=unit_id,
            shift_id=shift_id,
            csv_bytes=csv_bytes,
            department=str(body.get("department") or "").strip(),
            supervisor=str(body.get("supervisor") or "").strip(),
            machine=str(body.get("machine") or "").strip(),
            time_from=str(body.get("time_from") or "").strip(),
            time_to=str(body.get("time_to") or "").strip(),
            archive_meta=body.get("archive") if isinstance(body.get("archive"), dict) else None,
        )
        return jsonify(payload)
    except Exception as e:
        print(f"HISTORY process error: {e}")
        return jsonify({"ok": False, "error": "history_process_failed", "detail": str(e)}), 500


@app.get("/api/history/dashboard")
def history_dashboard():
    unit_id = str(request.args.get("unit") or "unit_i").strip().lower()
    shift_id = str(request.args.get("shift_id") or "").strip()
    if unit_id not in ("unit_i", "unit_ii"):
        return jsonify({"ok": False, "error": "unit must be unit_i or unit_ii"}), 400
    if not shift_id:
        return jsonify({"ok": False, "error": "shift_id required"}), 400

    meta = get_shift_archive(_db, unit_id, shift_id)
    if not meta:
        return jsonify({"ok": False, "error": "shift_not_archived", "shift_id": shift_id}), 404
    if _storage is None:
        return jsonify({"ok": False, "error": "gcs_not_configured"}), 503

    try:
        csv_bytes = download_shift_csv(_storage, meta["gcs_path"])
        payload = _history_process_payload(
            unit_id=unit_id,
            shift_id=shift_id,
            csv_bytes=csv_bytes,
            department=str(request.args.get("department") or "").strip(),
            supervisor=str(request.args.get("supervisor") or "").strip(),
            machine=str(request.args.get("machine") or "").strip(),
            time_from=str(request.args.get("time_from") or "").strip(),
            time_to=str(request.args.get("time_to") or "").strip(),
            archive_meta=meta,
        )
        return jsonify(payload)
    except Exception as e:
        print(f"HISTORY dashboard error: {e}")
        return jsonify({"ok": False, "error": "history_dashboard_failed", "detail": str(e)}), 500


@app.get("/live")
def live():
    unit_id = str(request.args.get("unit") or "unit_i").strip().lower()
    if unit_id not in ("unit_i", "unit_ii"):
        return jsonify({"ok": False, "error": "unit must be unit_i or unit_ii"}), 400

    try:
        data = _load_unit(unit_id)
    except Exception as e:
        return jsonify({"ok": False, "error": "firestore_read_failed", "detail": str(e)}), 500

    if not data:
        return jsonify(
            {
                "ok": True,
                "unit_id": unit_id,
                "stale": True,
                "machines": [],
                "filters": live_filter_options(unit_id, ""),
                "message": "No snapshot yet — is cloud_agent running on that PC?",
            }
        )

    out = _enrich_live_payload(unit_id, data)
    out["ok"] = True
    out["stale"] = False
    out["polled_at"] = _now_iso()
    return jsonify(out)


@app.get("/")
def index():
    """Same Live Monitor look as plant Flask — data from /live snapshot."""
    return render_template("index.html")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port, debug=False)
