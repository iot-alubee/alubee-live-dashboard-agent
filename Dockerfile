FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
COPY templates ./templates
COPY static ./static

ENV PORT=8080
ENV USE_FIRESTORE=1
CMD exec gunicorn --bind :$PORT --workers 1 --threads 8 --timeout 60 main:app
