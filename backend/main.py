import base64
import json
import mimetypes
import os
import re
import struct
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen


class SilenceStdout:
    """
    Prevent ddddocr or dependencies from printing to stdout.
    Chrome Native Messaging requires stdout to contain only binary JSON messages.
    """

    def __enter__(self):
        sys.stdout.flush()
        self.original_stdout_fd = os.dup(1)
        self.null_fd = os.open(os.devnull, os.O_WRONLY)
        os.dup2(self.null_fd, 1)
        return self

    def __exit__(self, exc_type, exc, tb):
        sys.stdout.flush()
        os.dup2(self.original_stdout_fd, 1)
        os.close(self.original_stdout_fd)
        os.close(self.null_fd)


def read_native_message():
    raw_length = sys.stdin.buffer.read(4)

    if not raw_length:
        sys.exit(0)

    message_length = struct.unpack("<I", raw_length)[0]
    message_body = sys.stdin.buffer.read(message_length)

    return json.loads(message_body.decode("utf-8"))


def send_native_message(payload):
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def decode_data_image_url(data_url):
    match = re.match(
        r"^data:(image/[^;]+);base64,(.+)$",
        data_url,
        re.IGNORECASE | re.DOTALL
    )

    if not match:
        raise ValueError("Invalid data image URL.")

    mime_type = match.group(1).lower()
    image_bytes = base64.b64decode(match.group(2))
    return image_bytes, mime_type, "data-url"


def read_http_image_url(image_url):
    request = Request(image_url, headers={"User-Agent": "URLGuardNativeHost/1.0"})

    with urlopen(request, timeout=20) as response:
        image_bytes = response.read()
        mime_type = response.headers.get_content_type() or "application/octet-stream"

    return image_bytes, mime_type, image_url


def read_local_image_path(image_path):
    path = Path(image_path).expanduser()

    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f"Image path does not exist: {path}")

    image_bytes = path.read_bytes()
    mime_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    return image_bytes, mime_type, str(path)

def get_public_image_dir():
    """
    Pick a public, user-visible folder without asking the browser user to choose a path.
    Screenshots/images are saved to the custom folder below.
    """
    override = r"F:\projects\Google Chrome\diplo_appoino\images\ocr"
    candidates = []

    if override:
        candidates.append(Path(override).expanduser())

    home = Path.home()
    candidates.extend([
        home / "Downloads" / "url-guard-auto",
        home / "Pictures" / "url-guard-auto",
        Path(tempfile.gettempdir()) / "url-guard-auto"
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

def get_public_image_dir_old():
    """
    Pick a public, user-visible folder without asking the browser user to choose a path.
    You can override it by setting URL_GUARD_IMAGE_DIR in the native host environment.
    """
    override = os.environ.get("URL_GUARD_IMAGE_DIR", "").strip()
    candidates = []

    if override:
        candidates.append(Path(override).expanduser())

    home = Path.home()
    candidates.extend([
        home / "Downloads" / "url-guard-auto",
        home / "Pictures" / "url-guard-auto",
        Path(tempfile.gettempdir()) / "url-guard-auto"
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


def extension_from_mime_type(mime_type):
    mapping = {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/svg+xml": "svg",
        "image/bmp": "bmp"
    }

    return mapping.get(str(mime_type or "").lower(), "img")


def save_image_bytes(image_bytes, mime_type, filename_prefix="c"):
    public_dir = get_public_image_dir()
    extension = extension_from_mime_type(mime_type)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    image_path = public_dir / f"{filename_prefix}-{timestamp}.{extension}"
    image_path.write_bytes(image_bytes)
    return str(image_path)


def load_image_bytes(message):
    image_path = str(message.get("imagePath") or "").strip()
    image_url = str(message.get("imageUrl") or "").strip()

    if image_path:
        return read_local_image_path(image_path)

    if image_url.startswith("data:image/"):
        return decode_data_image_url(image_url)

    if image_url.startswith(("http://", "https://")):
        return read_http_image_url(image_url)

    raise ValueError("No readable imagePath or imageUrl received from extension.")


def solve_with_ddddocr_bytes(image_bytes):
    with SilenceStdout():
        import ddddocr

        ocr = ddddocr.DdddOcr(show_ad=False)
        return ocr.classification(image_bytes)


def keep_only_alphanumeric(value):
    """
    Keep only A-Z, a-z, and 0-9.

    Examples:
    "A B-12_$x!" -> "AB12x"
    "ab@12#CD" -> "ab12CD"
    """
    return re.sub(r"[^A-Za-z0-9]", "", str(value or ""))


def process_message(message):
    event = str(message.get("event") or "").strip()
    image_bytes, mime_type, source = load_image_bytes(message)

    if event == "save_screenshot" or message.get("skipOcr") is True:
        saved_image_path = save_image_bytes(
            image_bytes,
            mime_type,
            "missing-form-screenshot"
        )

        return {
            "ok": True,
            "event": "save_screenshot",
            "savedImagePath": saved_image_path,
            "source": source,
            "mimeType": mime_type,
            "bytes": len(image_bytes),
            "processedAt": datetime.now(timezone.utc).isoformat(),
            "message": "Screenshot saved automatically. OCR was skipped."
        }

    saved_image_path = save_image_bytes(image_bytes, mime_type)

    raw_decoded_text = solve_with_ddddocr_bytes(image_bytes).strip()
    decoded_text = keep_only_alphanumeric(raw_decoded_text)

    return {
        "ok": True,
        "decodedText": decoded_text,
        "rawDecodedText": raw_decoded_text,
        "savedImagePath": saved_image_path,
        "source": source,
        "mimeType": mime_type,
        "bytes": len(image_bytes),
        "processedAt": datetime.now(timezone.utc).isoformat()
    }


def main():
    try:
        message = read_native_message()
        result = process_message(message)
        send_native_message(result)

    except Exception as exc:
        send_native_message({
            "ok": False,
            "error": str(exc),
            "processedAt": datetime.now(timezone.utc).isoformat()
        })


if __name__ == "__main__":
    main()