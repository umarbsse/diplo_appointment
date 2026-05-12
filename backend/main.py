import base64
import json
import os
import re
import struct
import sys
from datetime import datetime, timezone


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
        r"^data:image/[^;]+;base64,(.+)$",
        data_url,
        re.IGNORECASE | re.DOTALL
    )

    if not match:
        raise ValueError("Invalid data image URL.")

    return base64.b64decode(match.group(1))


def solve_with_ddddocr_bytes(image_bytes):
    with SilenceStdout():
        import ddddocr

        ocr = ddddocr.DdddOcr(show_ad=False)
        return ocr.classification(image_bytes)

def process_message(message):
    image_url = message.get("imageUrl")
    image_path = message.get("imagePath")

    if image_url and image_url.startswith("data:image/"):
        image_bytes = decode_data_image_url(image_url)
        decoded_text = solve_with_ddddocr_bytes(image_bytes)

    elif image_path:
        with open(image_path, "rb") as image_file:
            decoded_text = solve_with_ddddocr_bytes(image_file.read())

    else:
        raise ValueError("No imageUrl or imagePath received from extension.")

    decoded_text = decoded_text.strip()

    #if len(decoded_text) != 6:
        #raise ValueError(f"Decoded text must be exactly 6 characters, got {len(decoded_text)}.")
    #    return "Error: Decoded text must be exactly 6 characters."

    return decoded_text
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