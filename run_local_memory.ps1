# Minimal local UI test — no GCP (Live uses in-memory only; History will be empty)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$env:PORT = "8080"
$env:USE_FIRESTORE = "0"
$env:INGEST_API_KEY = "iot_Gm4rZk9zkoaseaxB2W4s9G7rfvRidGQv0llM8R0W0Gg"

Write-Host "Memory-only mode -> http://127.0.0.1:8080"
Write-Host "History tab will not load archived shifts (no Firestore/GCS)."
Write-Host "To test Live: point Unit agent config cloud_url to http://127.0.0.1:8080"
Write-Host ""

python main.py
