FROM python:3.12-slim

# Node is needed to reuse the same API source adapters (scripts/fetch-jobs.mjs)
# as the hosted version — one normalization pipeline, two doors.
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /app
# The repo is mounted at /app by docker-compose; worker.py lives in selfhost/worker.
CMD ["python", "/app/selfhost/worker/worker.py"]
