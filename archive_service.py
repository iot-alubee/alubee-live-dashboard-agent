"""Shift event archive: CSV in GCS + metadata in Firestore."""

from __future__ import annotations

import io
import os
from datetime import date, datetime, timezone

MIN_ARCHIVE_DATE = date(2026, 8, 31)  # archive shifts with date > 2026-08-31

GCS_BUCKET = os.environ.get("GCS_ARCHIVE_BUCKET", "").strip()
ARCHIVE_COLLECTION = "shift_archives"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_shift_date(shift_id: str) -> date | None:
    """Parse date from shift_id like 2026-09-01-I."""
    try:
        part = str(shift_id or "").rsplit("-", 1)[0]
        return date.fromisoformat(part)
    except Exception:
        return None


def should_archive_shift(shift_id: str) -> bool:
    d = parse_shift_date(shift_id)
    if d is None:
        return False
    return d > MIN_ARCHIVE_DATE


def gcs_object_path(unit_id: str, shift_id: str) -> str:
    return f"{unit_id}/{shift_id}/events.csv"


def archive_shift_csv(
    *,
    db,
    storage_client,
    unit_id: str,
    shift_id: str,
    csv_bytes: bytes,
    row_count: int,
    pc_name: str = "",
) -> dict:
    """
    Upload CSV to GCS and write Firestore metadata.
    Returns result dict with gcs_path, doc_id, etc.
    """
    if unit_id not in ("unit_i", "unit_ii"):
        raise ValueError("unit_id must be unit_i or unit_ii")
    if not shift_id or "-" not in shift_id:
        raise ValueError("shift_id required, e.g. 2026-09-01-I")
    if not should_archive_shift(shift_id):
        return {
            "ok": True,
            "skipped": True,
            "reason": f"shift date not after {MIN_ARCHIVE_DATE.isoformat()}",
            "shift_id": shift_id,
        }
    if not GCS_BUCKET:
        raise RuntimeError("GCS_ARCHIVE_BUCKET not configured on Cloud Run")
    if db is None:
        raise RuntimeError("Firestore not available")
    if storage_client is None:
        raise RuntimeError("GCS client not available")

    shift_date = parse_shift_date(shift_id)
    shift_name = shift_id.rsplit("-", 1)[-1]
    object_path = gcs_object_path(unit_id, shift_id)
    doc_id = f"{unit_id}_{shift_id}"

    bucket = storage_client.bucket(GCS_BUCKET)
    blob = bucket.blob(object_path)
    blob.upload_from_string(
        csv_bytes,
        content_type="text/csv; charset=utf-8",
    )

    meta = {
        "unit_id": unit_id,
        "shift_id": shift_id,
        "shift_date": shift_date.isoformat() if shift_date else "",
        "shift_name": shift_name,
        "gcs_path": object_path,
        "gcs_bucket": GCS_BUCKET,
        "row_count": int(row_count or 0),
        "bytes": len(csv_bytes),
        "archived_at": _now_iso(),
        "pc_name": str(pc_name or ""),
    }
    db.collection(ARCHIVE_COLLECTION).document(doc_id).set(meta, merge=True)

    return {
        "ok": True,
        "skipped": False,
        "doc_id": doc_id,
        "gcs_path": object_path,
        "gcs_uri": f"gs://{GCS_BUCKET}/{object_path}",
        "row_count": meta["row_count"],
        "archived_at": meta["archived_at"],
    }


def list_archived_shifts(db, unit_id: str, date_from: str | None = None, date_to: str | None = None) -> list[dict]:
    if db is None:
        return []
    q = db.collection(ARCHIVE_COLLECTION).where("unit_id", "==", unit_id)
    docs = []
    for snap in q.stream():
        row = snap.to_dict() or {}
        row["id"] = snap.id
        sd = str(row.get("shift_date") or "")
        if date_from and sd and sd < date_from:
            continue
        if date_to and sd and sd > date_to:
            continue
        docs.append(row)
    docs.sort(key=lambda r: (r.get("shift_date") or "", r.get("shift_name") or ""), reverse=True)
    return docs


def download_shift_csv(storage_client, gcs_path: str) -> bytes:
    if not GCS_BUCKET or not storage_client:
        raise RuntimeError("GCS not configured")
    blob = storage_client.bucket(GCS_BUCKET).blob(gcs_path)
    return blob.download_as_bytes()
