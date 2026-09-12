@echo off
cd /d "%~dp0"

REM One-time (if not done): gcloud auth application-default login

set PORT=8080
set USE_FIRESTORE=1
set GOOGLE_CLOUD_PROJECT=alubee-prod
set FIRESTORE_DATABASE=(default)
set GCS_ARCHIVE_BUCKET=live-monitor-agent.firebasestorage.app
set INGEST_API_KEY=iot_Gm4rZk9zkoaseaxB2W4s9G7rfvRidGQv0llM8R0W0Gg

echo Cloud API local - http://127.0.0.1:8080
echo Health - http://127.0.0.1:8080/health
echo.

python main.py
