from datetime import datetime
from pathlib import Path

import mss
import mss.tools


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "images" / "screenshots"
LOG_FILE = DEFAULT_OUTPUT_DIR / "screenshot_debug.log"


def _write_log(message):
    try:
        DEFAULT_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with LOG_FILE.open("a", encoding="utf-8") as log:
            log.write(f"[{timestamp}] {message}\n")
    except Exception:
        pass


def take_screenshots(output_dir=None):
    """Capture screenshots and return absolute saved file paths.

    Chrome runs the native host from a batch file, so relative folders can point
    to the backend directory. This function always defaults to the extension
    project folder: <project>/images/screenshots.
    """
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = Path(output_dir).expanduser() if output_dir else DEFAULT_OUTPUT_DIR
    output_path.mkdir(parents=True, exist_ok=True)

    saved_paths = []
    _write_log(f"take_screenshots started. output_dir={output_path}")

    with mss.mss() as sct:
        monitors = list(sct.monitors[1:])

        # Some Windows/remote desktop setups expose only the combined monitor.
        # In that case, capture sct.monitors[0] instead of returning nothing.
        if not monitors and sct.monitors:
            monitors = [sct.monitors[0]]

        for monitor_number, monitor in enumerate(monitors, start=1):
            filename = output_path / f"screenshot_screen_{monitor_number}_{timestamp}.png"
            screenshot = sct.grab(monitor)
            mss.tools.to_png(
                screenshot.rgb,
                screenshot.size,
                output=str(filename)
            )
            saved_paths.append(str(filename.resolve()))
            _write_log(f"saved {filename.resolve()}")

    if not saved_paths:
        raise RuntimeError("mss did not return any monitor to capture.")

    _write_log(f"take_screenshots completed. count={len(saved_paths)}")
    return saved_paths


if __name__ == "__main__":
    for path in take_screenshots():
        print(f"Saved screenshot: {path}")
