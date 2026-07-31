"""
Cloud Run API — low-cost live snapshot store for plant units.

  POST /ingest   (PC agents)   Header: X-API-Key
  GET  /live?unit=unit_i|unit_ii
  GET  /health
  GET  /         simple HTML poller (optional)

Uses Firestore when available; falls back to in-memory for local test.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from flask import Flask, jsonify, request, render_template

app = Flask(__name__, static_folder="static", template_folder="templates")

INGEST_API_KEY = os.environ.get("INGEST_API_KEY", "").strip()
USE_FIRESTORE = os.environ.get("USE_FIRESTORE", "1").strip() not in ("0", "false", "no")
# "(default)" or a named DB id — must match Firestore console
FIRESTORE_DATABASE = os.environ.get("FIRESTORE_DATABASE", "(default)").strip() or "(default)"

# In-memory fallback: { unit_id: payload }
_MEMORY: dict = {}
_db_error = None

_db = None
if USE_FIRESTORE:
    try:
        from google.cloud import firestore

        _db = firestore.Client(database=FIRESTORE_DATABASE)
        print(f"Firestore client OK database={FIRESTORE_DATABASE}")
    except Exception as e:
        _db_error = str(e)
        print(f"Firestore unavailable ({e}) — using memory store")
        _db = None


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


@app.get("/health")
def health():
    return jsonify(
        {
            "ok": True,
            "firestore": _db is not None,
            "firestore_database": FIRESTORE_DATABASE,
            "firestore_error": _db_error,
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
                "message": "No snapshot yet — is cloud_agent running on that PC?",
            }
        )

    out = dict(data)
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
