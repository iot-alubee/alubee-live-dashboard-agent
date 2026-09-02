# Production Monitor App — Cloud Run deployment

Flask dashboard: **Live** snapshots (Firestore) + **History** (GCS archived shift CSV).

## Folder contents

| Path | Purpose |
|------|---------|
| `main.py` | Flask app, routes, ingest |
| `archive_service.py` | GCS / Firestore shift archives |
| `history_analytics.py` | History dashboard analytics |
| `machine_registry.py` | Machine metadata & filters |
| `data/` | Unit I / II machine registry JSON |
| `templates/` | Dashboard HTML |
| `static/` | CSS + JS |
| `Dockerfile` | Cloud Run container |
| `requirements.txt` | Python dependencies |

## Prerequisites

- GCP project (e.g. `alubee-prod`) with Firestore (Native) enabled
- GCS bucket for shift CSV archives
- Plant PC agents posting to `/ingest` with `X-API-Key`
- Cloud Run runtime service account: **Cloud Datastore User** (+ GCS read on archive bucket if cross-project)

## Deploy

```bash
cd production-monitor-app

gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com firestore.googleapis.com cloudbuild.googleapis.com

gcloud run deploy alubee-live-monitor \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 3 \
  --memory 512Mi \
  --cpu 1 \
  --set-env-vars "INGEST_API_KEY=YOUR_SECRET_KEY,USE_FIRESTORE=1,FIRESTORE_DATABASE=(default),GCS_ARCHIVE_BUCKET=YOUR_BUCKET,GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID"
```

After deploy:

1. Open `https://YOUR_SERVICE_URL/health` — expect `"firestore": true` and GCS bucket set.
2. Set plant agent `cloud_url` to the Cloud Run URL.
3. Open `/` for the dashboard (Live + History tabs).

## Local test (before deploy)

```powershell
cd production-monitor-app
pip install -r requirements.txt
gcloud auth application-default login

$env:USE_FIRESTORE = "1"
$env:GOOGLE_CLOUD_PROJECT = "YOUR_PROJECT_ID"
$env:GCS_ARCHIVE_BUCKET = "YOUR_BUCKET"
python main.py
```

Open http://127.0.0.1:8080

## Endpoints

| Method | Path | Who |
|--------|------|-----|
| POST | `/ingest` | PC agents (`X-API-Key`) |
| POST | `/archive` | Shift archiver (`X-API-Key`) |
| GET | `/live?unit=unit_i` | Browsers |
| GET | `/api/history/*` | History dashboard |
| GET | `/health` | Health probe |
| GET | `/` | Dashboard UI |
