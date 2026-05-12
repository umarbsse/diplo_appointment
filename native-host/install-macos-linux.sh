#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <chrome-extension-id>" >&2
  exit 1
fi

EXTENSION_ID="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.url_guard.processor"
HOST_FILE="${HOST_NAME}.json"
PROCESSOR_PATH="${SCRIPT_DIR}/process_image.py"

case "$(uname -s)" in
  Darwin)
    HOST_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    HOST_DIR="${HOME}/.config/google-chrome/NativeMessagingHosts"
    ;;
  *)
    echo "Unsupported OS. Create the native host manifest manually from the template." >&2
    exit 1
    ;;
esac

mkdir -p "$HOST_DIR"
cat > "${HOST_DIR}/${HOST_FILE}" <<JSON
{
  "name": "${HOST_NAME}",
  "description": "URL Guard Python image processor",
  "path": "${PROCESSOR_PATH}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
JSON
chmod +x "$PROCESSOR_PATH"
echo "Installed native host manifest: ${HOST_DIR}/${HOST_FILE}"
