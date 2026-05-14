#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${SCRIPT_DIR}/../backend"
exec python3 "${SCRIPT_DIR}/../backend/main.py" 2>> "${SCRIPT_DIR}/native_host_error.log"
