#!/usr/bin/env python3
"""
Chrome Native Messaging host for URL Guard Element Source Viewer.

This host receives an image URL/path from the extension, saves the image into a
public writable folder automatically, then processes it. No Chrome Save As dialog
is required.
"""
from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import re
import struct
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Tuple
from urllib.request import Request, urlopen


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


def decode_data_image_url(data_url: str) -> Tuple[bytes, str, str]:
    match = re.match(r"^data:(image/[^;]+);base64,(.+)$", data_url, re.IGNORECASE | re.DOTALL)
    if not match:
        raise RuntimeError("Invalid data image URL.")

    mime_type = match.group(1).lower()
    return base64.b64decode(match.group(2)), mime_type, "data-url"


def read_http_image_url(image_url: str) -> Tuple[bytes, str, str]:
    request = Request(image_url, headers={"User-Agent": "URLGuardNativeHost/1.0"})
    with urlopen(request, timeout=20) as response:
        return response.read(), response.headers.get_content_type() or "application/octet-stream", image_url


def read_local_image_path(image_path: str) -> Tuple[bytes, str, str]:
    path = Path(image_path).expanduser()
    if not path.exists() or not path.is_file():
        raise RuntimeError(f"Image path does not exist: {path}")

    return path.read_bytes(), mimetypes.guess_type(str(path))[0] or "application/octet-stream", str(path)


def get_public_image_dir() -> Path:
    override = os.environ.get("URL_GUARD_IMAGE_DIR", "").strip()
    candidates = []

    if override:
        candidates.append(Path(override).expanduser())

    home = Path.home()
    candidates.extend([
        home / "Downloads" / "url-guard-auto",
        home / "Pictures" / "url-guard-auto",
        Path(tempfile.gettempdir()) / "url-guard-auto",
    ])

    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            test_file = candidate / ".write-test"
            test_file.write_text("ok", encoding="utf-8")
            test_file.unlink(missing_ok=True)
            return candidate
        except Exception:
            continue

    raise RuntimeError("Could not create a writable public image folder.")


def extension_from_mime_type(mime_type: str) -> str:
    return {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/svg+xml": "svg",
        "image/bmp": "bmp",
    }.get(str(mime_type or "").lower(), "img")


def save_image_bytes(image_bytes: bytes, mime_type: str, filename_prefix: str = "background-image") -> str:
    public_dir = get_public_image_dir()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    path = public_dir / f"{filename_prefix}-{timestamp}.{extension_from_mime_type(mime_type)}"
    path.write_bytes(image_bytes)
    return str(path)


def load_image_bytes(message: Dict[str, Any]) -> Tuple[bytes, str, str]:
    image_path = str(message.get("imagePath") or "").strip()
    image_url = str(message.get("imageUrl") or "").strip()

    if image_path:
        return read_local_image_path(image_path)

    if image_url.startswith("data:image/"):
        return decode_data_image_url(image_url)

    if image_url.startswith(("http://", "https://")):
        return read_http_image_url(image_url)

    raise RuntimeError("No readable imagePath or imageUrl was provided.")


def process_saved_image(message: Dict[str, Any]) -> Dict[str, Any]:
    event = str(message.get("event") or "").strip()
    image_bytes, mime_type, source = load_image_bytes(message)
    filename_prefix = "missing-form-screenshot" if event == "save_screenshot" or message.get("skipOcr") is True else "background-image"
    saved_image_path = save_image_bytes(image_bytes, mime_type, filename_prefix)
    sha256 = hashlib.sha256(image_bytes).hexdigest()

    return {
        "ok": True,
        "event": event or "image_saved",
        "source": source,
        "savedImagePath": saved_image_path,
        "mimeType": mime_type,
        "bytes": len(image_bytes),
        "sha256": sha256,
        "message": "Screenshot saved automatically. OCR was skipped." if filename_prefix == "missing-form-screenshot" else "Python script automatically saved and processed the image. Replace process_saved_image() with your OCR logic if needed."
    }


def main() -> int:
    try:
        message = read_native_message()
        result = process_saved_image(message)
        write_native_message(result)
        return 0
    except Exception as exc:
        write_native_message({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
