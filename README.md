# URL Guard Element Source Viewer

Manifest V3 Chrome extension that:

1. Runs only after the active page URL matches your configured safe URL rule.
2. Finds a configured form by `id`.
3. Finds a configured element / CSS selector inside that form.
4. Extracts the first CSS `url(...)` from its inline or computed background style.
5. Automatically downloads the image when the page finishes loading.
6. Sends the saved image information to a local Python script through Chrome Native Messaging.
7. Stores the Python response and shows it in the popup under **Python response**.

## Install the extension

1. Extract this folder.
2. Open Chrome: `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this extension folder.
6. Copy the extension ID shown by Chrome. You need it for the native host install step.

## Configure the extension

Open the extension **Options** page and enter:

```text
Allowed URL rule: https://example.com/checkout/*
Form ID: checkoutForm
HTML tag or selector: div[style*="background"]
```

## Install the Python Native Messaging host

Chrome extensions cannot execute Python directly. This extension uses Chrome Native Messaging.

### macOS / Linux

From the `native-host` folder:

```bash
./install-macos-linux.sh YOUR_EXTENSION_ID
```

### Windows PowerShell

From the `native-host` folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -ExtensionId YOUR_EXTENSION_ID
```

## Customize the Python script

Edit:

```text
native-host/process_image.py
```

Replace the logic inside:

```python
def process_saved_image(message):
    ...
```

The extension sends this JSON shape:

```json
{
  "event": "image_saved",
  "savedAt": "2026-05-13T...Z",
  "tabUrl": "https://example.com/checkout/123",
  "selector": "#checkoutForm div[style*=\"background\"]",
  "downloadId": 123,
  "imagePath": "/absolute/path/to/Downloads/url-guard/background-image-....jpg",
  "imageUrl": "data:image/jpg;base64,...",
  "mimeType": "image/jpg",
  "elementHtml": "<div style=\"background:white url(...)\"></div>"
}
```

The Python script must return a JSON object. Whatever it returns is displayed in the popup field named **Python response**.

## Notes

- Automatic page-load processing needs `host_permissions` for `http://*/*` and `https://*/*`; the code still checks your saved safe URL rule before extracting anything.
- Native Messaging requires a registered native host named `com.url_guard.processor`.
- If the native host is not installed, the popup will show a Python error instead of a response.
