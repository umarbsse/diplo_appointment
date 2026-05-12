#!/usr/bin/env python3
"""
Chrome Native Messaging host for URL Guard Element Source Viewer.

Input: one JSON message from the extension.
Output: one JSON response back to the extension.

Replace process_saved_image() with your own OCR / ML / parsing logic.
"""
from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import struct
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.request import urlopen, Request


def read_native_message() -> Dict[str, Any]:
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) != 4:
        raise RuntimeError("No message received from Chrome.")

    message_length = struct.unpack("<I", raw_length)[0]
    if message_length <= 0:
        raise RuntimeError("Chrome sent an empty message.")

    message = sys.stdin.buffer.read(message_length)
    if len(message) != message_length:
        raise RuntimeError("Incomplete message received from Chrome.")

    return json.loads(message.decode("utf-8"))


def write_native_message(payload: Dict[str, Any]) -> None:
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def load_image_bytes(message: Dict[str, Any]) -> Tuple[bytes, str, str]:
    image_path = str(message.get("imagePath") or "").strip()
    image_url = str(message.get("imageUrl") or "").strip()
    mime_type = str(message.get("mimeType") or "").strip()

    if image_path:
        path = Path(image_path).expanduser()
        if path.exists() and path.is_file():
            data = path.read_bytes()
            detected_mime = mime_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
            return data, detected_mime, str(path)

    if image_url.startswith("data:image/"):
        header, encoded_data = image_url.split(",", 1)
        detected_mime = mime_type or header[5:].split(";", 1)[0]
        return base64.b64decode(encoded_data), detected_mime, "data-url"

    if image_url.startswith(("http://", "https://")):
        request = Request(image_url, headers={"User-Agent": "URLGuardNativeHost/1.0"})
        with urlopen(request, timeout=20) as response:
            data = response.read()
            detected_mime = mime_type or response.headers.get_content_type() or "application/octet-stream"
            return data, detected_mime, image_url

    raise RuntimeError("No readable imagePath or imageUrl was provided.")


def process_saved_image(message: Dict[str, Any]) -> Dict[str, Any]:
    image_bytes, mime_type, source = load_image_bytes(message)
    sha256 = hashlib.sha256(image_bytes).hexdigest()

    # Put your real Python logic here. For example:
    # - OCR with pytesseract
    # - captcha/image classification
    # - barcode/QR parsing
    # - validation against your backend rules
    return {
        "ok": True,
        "source": source,
        "mimeType": mime_type,
        "bytes": len(image_bytes),
        "sha256": sha256,
        "message": "Python script received and processed the saved image. Replace process_saved_image() with your custom logic."
    }


def main() -> int:
    try:
        message = read_native_message()
        result = process_saved_image(message)
        write_native_message(result)
        return 0
    except Exception as exc:  # Keep errors visible inside the extension popup.
        write_native_message({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
