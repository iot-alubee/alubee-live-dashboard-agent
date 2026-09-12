"""
Firebase Cloud Messaging (FCM) for mobile status alarms.

Works when the phone is locked / PWA closed (system notification).
Requires Cloud Run env: FIREBASE_* web config + FIREBASE_VAPID_KEY,
and runtime SA with Firebase Cloud Messaging Admin (or a service account).
"""

from __future__ import annotations

import hashlib
import os
import threading
from datetime import datetime, timezone

TOKENS_COLLECTION = "mobile_push_tokens"

_MEMORY_TOKENS: dict[str, dict] = {}
_admin_ready = False
_admin_lock = threading.Lock()
_db_ref = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def set_db(db) -> None:
    global _db_ref
    _db_ref = db


def web_config() -> dict:
    """Public Firebase web app config (safe to expose to browsers)."""
    project = (
        os.environ.get("FIREBASE_PROJECT_ID")
        or os.environ.get("GOOGLE_CLOUD_PROJECT")
        or os.environ.get("GCP_PROJECT")
        or "alubee-prod"
    ).strip()
    return {
        "apiKey": os.environ.get("FIREBASE_API_KEY", "").strip(),
        "authDomain": os.environ.get("FIREBASE_AUTH_DOMAIN", f"{project}.firebaseapp.com").strip(),
        "projectId": project,
        "storageBucket": os.environ.get(
            "FIREBASE_STORAGE_BUCKET", f"{project}.appspot.com"
        ).strip(),
        "messagingSenderId": os.environ.get("FIREBASE_MESSAGING_SENDER_ID", "").strip(),
        "appId": os.environ.get("FIREBASE_APP_ID", "").strip(),
        "vapidKey": os.environ.get("FIREBASE_VAPID_KEY", "").strip(),
    }


def push_configured() -> bool:
    cfg = web_config()
    return bool(
        cfg["apiKey"]
        and cfg["messagingSenderId"]
        and cfg["appId"]
        and cfg["vapidKey"]
    )


def _ensure_admin() -> bool:
    global _admin_ready
    if _admin_ready:
        return True
    with _admin_lock:
        if _admin_ready:
            return True
        try:
            import firebase_admin
            from firebase_admin import credentials

            if not firebase_admin._apps:
                project = web_config()["projectId"]
                # Cloud Run ADC / default credentials
                try:
                    firebase_admin.initialize_app(
                        credentials.ApplicationDefault(),
                        options={"projectId": project},
                    )
                except Exception:
                    firebase_admin.initialize_app(options={"projectId": project})
            _admin_ready = True
            print(f"FCM admin ready project={web_config()['projectId']}")
            return True
        except Exception as e:
            print(f"FCM admin init failed: {e}")
            return False


def _token_doc_id(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:40]


def save_token(db, token: str, meta: dict | None = None) -> None:
    token = str(token or "").strip()
    if not token or len(token) < 20:
        raise ValueError("invalid token")
    row = {
        "token": token,
        "updated_at": _now_iso(),
        "user_agent": (meta or {}).get("user_agent") or "",
        "platform": (meta or {}).get("platform") or "",
    }
    doc_id = _token_doc_id(token)
    _MEMORY_TOKENS[doc_id] = row
    store = db if db is not None else _db_ref
    if store is not None:
        store.collection(TOKENS_COLLECTION).document(doc_id).set(row, merge=True)


def delete_token(db, token: str) -> None:
    token = str(token or "").strip()
    if not token:
        return
    doc_id = _token_doc_id(token)
    _MEMORY_TOKENS.pop(doc_id, None)
    store = db if db is not None else _db_ref
    if store is not None:
        try:
            store.collection(TOKENS_COLLECTION).document(doc_id).delete()
        except Exception as e:
            print(f"FCM token delete failed: {e}")


def list_tokens(db=None) -> list[str]:
    store = db if db is not None else _db_ref
    tokens: list[str] = []
    if store is not None:
        try:
            for snap in store.collection(TOKENS_COLLECTION).stream():
                d = snap.to_dict() or {}
                t = str(d.get("token") or "").strip()
                if t:
                    tokens.append(t)
            if tokens:
                return tokens
        except Exception as e:
            print(f"FCM list tokens failed: {e}")
    return [r["token"] for r in _MEMORY_TOKENS.values() if r.get("token")]


def notify_offline(event: dict) -> None:
    """Send one FCM notification for an offline transition (fire-and-forget safe)."""
    if str(event.get("event") or "") != "offline":
        return
    kind = str(event.get("kind") or "device")
    name = str(event.get("name") or "device")
    unit = str(event.get("unit_id") or "")
    if kind == "server":
        label = "Unit II Server" if unit == "unit_ii" else "Unit I Server"
        title = "Server offline"
        body = f"{label} is offline"
    else:
        title = "Machine offline"
        body = f"{name} disconnected ({unit or 'plant'})"
    # Avoid blocking ingest/status on FCM latency
    threading.Thread(
        target=_send_all,
        kwargs={
            "title": title,
            "body": body,
            "data": {
                "kind": kind,
                "name": name,
                "unit_id": unit,
                "event": "offline",
                "url": "/mobile",
            },
        },
        daemon=True,
    ).start()


def _send_all(title: str, body: str, data: dict | None = None) -> None:
    if not _ensure_admin():
        print("FCM skip send — admin not ready")
        return
    tokens = list_tokens()
    if not tokens:
        print("FCM skip send — no subscribed phones")
        return
    try:
        from firebase_admin import messaging
    except Exception as e:
        print(f"FCM import failed: {e}")
        return

    data = {k: str(v) for k, v in (data or {}).items()}
    base = (
        os.environ.get("PUBLIC_BASE_URL")
        or "https://alubee-live-monitor-841494023550.asia-south1.run.app"
    ).rstrip("/")
    # Multicast in chunks of 500
    ok = 0
    fail = 0
    stale: list[str] = []
    for i in range(0, len(tokens), 500):
        chunk = tokens[i : i + 500]
        msg = messaging.MulticastMessage(
            tokens=chunk,
            notification=messaging.Notification(title=title, body=body),
            data=data,
            android=messaging.AndroidConfig(
                priority="high",
                notification=messaging.AndroidNotification(
                    channel_id="alubee_status",
                    sound="default",
                    priority="high",
                ),
            ),
            webpush=messaging.WebpushConfig(
                headers={"Urgency": "high"},
                notification=messaging.WebpushNotification(
                    title=title,
                    body=body,
                    icon=f"{base}/static/mobile/icon-192.png",
                    require_interaction=True,
                    # Locked phone: OS notification sound + strong vibration
                    # (custom ringtone only plays after user opens /mobile)
                    silent=False,
                    vibrate=[500, 200, 500, 200, 500, 200, 500, 200, 500, 200, 500],
                    tag=f"{data.get('kind', 'status')}:{data.get('name', 'alert')}",
                    renotify=True,
                ),
                fcm_options=messaging.WebpushFCMOptions(link=f"{base}/mobile?alarm=1"),
            ),
        )
        try:
            if hasattr(messaging, "send_each_for_multicast"):
                resp = messaging.send_each_for_multicast(msg)
            else:
                resp = messaging.send_multicast(msg)
            ok += resp.success_count
            fail += resp.failure_count
            for idx, send_resp in enumerate(resp.responses):
                if send_resp.success:
                    continue
                err = str(getattr(send_resp, "exception", "") or "")
                if (
                    "NotRegistered" in err
                    or "UNREGISTERED" in err
                    or "invalid-registration" in err.lower()
                ):
                    stale.append(chunk[idx])
        except Exception as e:
            print(f"FCM multicast failed: {e}")
            for t in chunk:
                try:
                    messaging.send(
                        messaging.Message(
                            token=t,
                            notification=messaging.Notification(title=title, body=body),
                            data=data,
                        )
                    )
                    ok += 1
                except Exception as ie:
                    fail += 1
                    err = str(ie)
                    if "NotRegistered" in err or "UNREGISTERED" in err:
                        stale.append(t)

    for t in stale:
        delete_token(_db_ref, t)
    print(f"FCM sent ok={ok} fail={fail} stale_removed={len(stale)} title={title!r}")
