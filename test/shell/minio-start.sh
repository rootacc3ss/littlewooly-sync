#!/usr/bin/env bash
# Start a throwaway MinIO for integration tests. Idempotent.
set -euo pipefail

NAME="${LWS_MINIO_NAME:-lws-minio}"
PORT="${LWS_MINIO_PORT:-9000}"
USER="${LWS_S3_ACCESS_KEY:-minioadmin}"
PASS="${LWS_S3_SECRET_KEY:-minioadmin}"

if docker ps -a --format '{{.Names}}' | grep -q "^${NAME}$"; then
  docker start "${NAME}" >/dev/null
else
  docker run -d --name "${NAME}" \
    -p "${PORT}:9000" \
    -e "MINIO_ROOT_USER=${USER}" \
    -e "MINIO_ROOT_PASSWORD=${PASS}" \
    minio/minio server /data >/dev/null
fi

echo "MinIO starting on http://127.0.0.1:${PORT} (user=${USER})"
