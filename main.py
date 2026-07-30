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

from flask import Flask, jsonify, request, Response

app = Flask(__name__)

INGEST_API_KEY = os.environ.get("INGEST_API_KEY", "").strip()
USE_FIRESTORE = os.environ.get("USE_FIRESTORE", "1").strip() not in ("0", "false", "no")

# In-memory fallback: { unit_id: payload }
_MEMORY: dict = {}

_db = None
if USE_FIRESTORE:
    try:
        from google.cloud import firestore

        _db = firestore.Client()
    except Exception as e:
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


def _load_unit(unit_id: str) -> dict | None:
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
        "pc_name": data.get("pc_name") or "",
        "agent_version": data.get("agent_version") or "1.0.0",
    }
    _save_unit(unit_id, payload)
    return jsonify({"ok": True, "unit_id": unit_id, "machines": len(machines)})


@app.get("/live")
def live():
    unit_id = str(request.args.get("unit") or "unit_i").strip().lower()
    if unit_id not in ("unit_i", "unit_ii"):
        return jsonify({"ok": False, "error": "unit must be unit_i or unit_ii"}), 400

    data = _load_unit(unit_id)
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

    # Age hint for UI
    stale = False
    try:
        # Prefer agent updated_at
        pass
    except Exception:
        stale = False

    out = dict(data)
    out["ok"] = True
    out["stale"] = stale
    out["polled_at"] = _now_iso()
    return jsonify(out)


@app.get("/")
def index():
    """Minimal remote viewer — polls /live every 2s."""
    html = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cloud Live Monitor</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1rem; background: #0f172a; color: #e2e8f0; }
    select, button { padding: 0.4rem 0.6rem; margin-right: 0.5rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; font-size: 0.9rem; }
    th, td { border-bottom: 1px solid #334155; padding: 0.4rem 0.5rem; text-align: left; }
    th { color: #94a3b8; }
    .meta { color: #94a3b8; font-size: 0.85rem; margin-top: 0.5rem; }
    .run { color: #4ade80; } .idle { color: #fbbf24; } .disc { color: #f87171; }
  </style>
</head>
<body>
  <h1>Cloud Live Monitor</h1>
  <div>
    <label>Unit
      <select id="unit">
        <option value="unit_i">Unit I</option>
        <option value="unit_ii">Unit II</option>
      </select>
    </label>
    <span class="meta" id="meta">Starting…</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Machine</th><th>Status</th><th>Shots</th><th>Idle</th>
        <th>Act Qty/Hr</th><th>Efficiency</th><th>Updated</th><th>Ping</th>
      </tr>
    </thead>
    <tbody id="body"></tbody>
  </table>
  <script>
    const body = document.getElementById("body");
    const meta = document.getElementById("meta");
    const unitSel = document.getElementById("unit");
    let busy = false;
    function esc(v) {
      return String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }
    function statusClass(s) {
      const k = String(s||"").toLowerCase();
      if (k === "running") return "run";
      if (k === "idle") return "idle";
      if (k === "disconnected") return "disc";
      return "";
    }
    async function tick() {
      if (busy) return;
      busy = true;
      try {
        const u = unitSel.value;
        const res = await fetch("/live?unit=" + encodeURIComponent(u), { cache: "no-store" });
        const data = await res.json();
        const rows = data.machines || [];
        meta.textContent = (data.shift_name || "") + " · " + (data.updated_at || "no data") +
          " · " + rows.length + " machines · poll 2s";
        body.innerHTML = rows.map(r => `<tr>
          <td>${esc(r["Machine No"] || r.machine_no)}</td>
          <td class="${statusClass(r.Status || r.status)}">${esc(r.Status || r.status)}</td>
          <td>${esc(r.Shots ?? r.shots ?? "—")}</td>
          <td>${esc(r.Idle || r.idle || "—")}</td>
          <td>${esc(r["Actual Qty/Hour"] || "—")}</td>
          <td>${esc(r.Efficiency || "—")}</td>
          <td>${esc(r["Last Updated"] || "—")}</td>
          <td>${esc(r["Latest Ping"] || "—")}</td>
        </tr>`).join("") || `<tr><td colspan="8">No snapshot yet</td></tr>`;
      } catch (e) {
        meta.textContent = "Error: " + e.message;
      } finally {
        busy = false;
      }
    }
    unitSel.addEventListener("change", tick);
    tick();
    setInterval(tick, 2000);
  </script>
</body>
</html>"""
    return Response(html, mimetype="text/html")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port, debug=False)
