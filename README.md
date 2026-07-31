# Cloud API — deploy to Google Cloud Run

## Local test (memory store, no Firestore)

```bash
cd "Production-Upgraded/Cloud Setup/cloud_api"
pip install -r requirements.txt
set USE_FIRESTORE=0
set INGEST_API_KEY=dev-secret
python main.py
```

Open http://127.0.0.1:8080

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
  --set-env-vars "INGEST_API_KEY=iot_Gm4rZk9zkoaseaxB2W4s9G7rfvRidGQv0llM8R0W0Gg,USE_FIRESTORE=1,FIRESTORE_DATABASE=(default)"
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
| GET | `/live?unit=unit_i` | Browsers |
| GET | `/health` | Probe |
| GET | `/` | Simple 2s live page |

Keep **min-instances = 0** for low cost.
