#!/usr/bin/env bash
# Stop and remove the throwaway MinIO container.
set -euo pipefail
NAME="${LWS_MINIO_NAME:-lws-minio}"
docker rm -f "${NAME}" >/dev/null 2>&1 || true
echo "MinIO ${NAME} stopped"
