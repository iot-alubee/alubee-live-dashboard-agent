# Run cloud dashboard locally (connects to real Firestore + GCS if ADC is set up)
# Prerequisites: Python 3.11+, pip install -r requirements.txt
# One-time: gcloud auth application-default login  (same Google account with bucket access)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$env:PORT = "8080"
$env:USE_FIRESTORE = "1"
$env:GOOGLE_CLOUD_PROJECT = "alubee-prod"
$env:FIRESTORE_DATABASE = "(default)"
$env:GCS_ARCHIVE_BUCKET = "live-monitor-agent.firebasestorage.app"
$env:INGEST_API_KEY = "iot_Gm4rZk9zkoaseaxB2W4s9G7rfvRidGQv0llM8R0W0Gg"

Write-Host "Cloud API local -> http://127.0.0.1:8080"
Write-Host "Health     -> http://127.0.0.1:8080/health"
Write-Host "History    -> http://127.0.0.1:8080/ (History tab)"
Write-Host ""
Write-Host "Live data: needs cloud_agent posting to this URL, OR use deployed Cloud Run for live."
Write-Host "History:   uses your GCP credentials (Firestore + GCS archive)."
Write-Host ""

python main.py
