# Cloud API — deploy to Google Cloud Run

## Local test

### Option A — Full History + Live (real GCP data)

Uses your PC’s Google credentials to read the same Firestore/GCS as Cloud Run.

```powershell
cd "Production-Upgraded\Cloud Setup\cloud_api"
pip install -r requirements.txt

# One-time (browser login):
gcloud auth application-default login

.\run_local.ps1
```

Open http://127.0.0.1:8080 → **History** tab → pick date/shift → **Load**.

**Live** tab on local still needs snapshots: either run `cloud_agent` with  
`"cloud_url": "http://127.0.0.1:8080"` while local server is running, or use Live on deployed Cloud Run only.

### Option B — UI only (no GCP)

```powershell
.\run_local_memory.ps1
```

`USE_FIRESTORE=0` — History empty; good for layout/filter checks only.

### Point plant agent at local (optional)

In `Cloud Setup\Unit_I\agent\config.json` temporarily:

```json
"cloud_url": "http://127.0.0.1:8080"
```

Run `python cloud_agent.py` on the same PC as local Flask (8501). Live tab fills within ~10s.

Revert `cloud_url` to the Cloud Run URL when done.

## Deploy to Cloud Run

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com firestore.googleapis.com cloudbuild.googleapis.com

# Create Firestore (Native) once in console if not done

cd "Production-Upgraded/Cloud Setup/cloud_api"

gcloud run deploy alubee-live-monitor \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 3 \
  --memory 512Mi \
  --cpu 1 \
  --set-env-vars "INGEST_API_KEY=YOUR_KEY,USE_FIRESTORE=1,FIRESTORE_DATABASE=(default),GCS_ARCHIVE_BUCKET=live-monitor-agent.firebasestorage.app"
```

**Live URL:** https://alubee-live-monitor-841494023550.asia-south1.run.app

**API key (same on Cloud Run + both agents):**  
`iot_Gm4rZk9zkoaseaxB2W4s9G7rfvRidGQv0llM8R0W0Gg`

After deploy, open `/health` — should show `"firestore": true`.

If ingest still fails with permission errors, grant the Cloud Run runtime SA role **Cloud Datastore User**:
IAM → find `...-compute@developer.gserviceaccount.com` → add role.

Agent `config.json` `cloud_url` must match the Live URL above.

## Endpoints

| Method | Path | Who |
|--------|------|-----|
| POST | `/ingest` | PC agents (`X-API-Key`) |
| POST | `/archive` | Plant PC shift archiver (`X-API-Key`, multipart CSV) |
| GET | `/api/history/shifts?unit=unit_i&from=&to=` | List archived shifts |
| GET | `/live?unit=unit_i` | Browsers |
| GET | `/api/mobile/status` | Mobile app — machines + servers online/offline |
| GET | `/api/mobile/history` | Mobile app — connectivity event log |
| GET | `/api/mobile/push/config` | Firebase web config for FCM |
| POST | `/api/mobile/push/subscribe` | Save phone FCM token |
| GET | `/mobile` or `/m` | Mobile status PWA |
| GET | `/firebase-messaging-sw.js` | FCM background service worker |
| GET | `/health` | Probe (shows `gcs`, `gcs_bucket`) |
| GET | `/` | Live Monitor page |

Keep **min-instances = 0** for low cost.

## Mobile push (FCM) — locked phone alarms

1. Firebase Console → your project (same as `alubee-prod` if possible) → **Project settings → Cloud Messaging**
2. Under **Web Push certificates**, generate a key pair → copy the **Key pair** (VAPID)
3. **Project settings → General → Your apps → Web app** → copy `apiKey`, `authDomain`, `projectId`, `messagingSenderId`, `appId`
4. Deploy Cloud Run with env vars (add to existing `--set-env-vars` or Console → Edit & deploy):

```text
FIREBASE_API_KEY=...
FIREBASE_AUTH_DOMAIN=alubee-prod.firebaseapp.com
FIREBASE_PROJECT_ID=alubee-prod
FIREBASE_STORAGE_BUCKET=alubee-prod.appspot.com
FIREBASE_MESSAGING_SENDER_ID=...
FIREBASE_APP_ID=1:...:web:...
FIREBASE_VAPID_KEY=...
PUBLIC_BASE_URL=https://alubee-live-monitor-841494023550.asia-south1.run.app
```

5. Grant Cloud Run runtime SA role **Firebase Cloud Messaging Admin** (or Firebase Admin SDK Administrator Service Agent)
6. On phone: open `/mobile` → **Enable** notifications → allow
7. Redeploy:

```bash
cd "Production-Upgraded/Cloud Setup/cloud_api"
gcloud run deploy alubee-live-monitor --source . --region asia-south1
```

Only phones that opened `/mobile` and tapped **Enable** receive FCM. The main Live dashboard does not.
