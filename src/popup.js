import { getConfig, matchesConfiguredRule, toDisplaySelector, validateConfig } from './config.js';

const USE_CHROME_DOWNLOADS = false; // false avoids Chrome Save As prompts; Python saves images automatically.

const LOCAL_STORAGE_KEYS = Object.freeze({
  lastElementHtml: 'lastElementHtml',
  lastInlineStyle: 'lastInlineStyle',
  lastBackgroundImageUrl: 'lastBackgroundImageUrl',
  lastBackgroundImageMimeType: 'lastBackgroundImageMimeType',
  lastSavedAt: 'lastSavedAt',
  lastDownloadId: 'lastDownloadId',
  lastDownloadedFilename: 'lastDownloadedFilename',
  lastPythonResponse: 'lastPythonResponse',
  lastPythonError: 'lastPythonError',
  lastPythonProcessedAt: 'lastPythonProcessedAt',
  lastScreenshotPath: 'lastScreenshotPath',
  lastScreenshotSavedAt: 'lastScreenshotSavedAt',
  lastScreenshotError: 'lastScreenshotError'
});


const REMOVED_FRAME_ERROR_PATTERN = /Frame with ID \d+ was removed|No frame with id|Receiving end does not exist/i;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRemovedFrameError(error) {
  return REMOVED_FRAME_ERROR_PATTERN.test(String(error?.message || error || ''));
}

function isInjectableTab(tab) {
  return Boolean(tab?.id && /^https?:\/\//i.test(String(tab.url || '')) && !tab.discarded);
}

async function executePageScript(tabId, injection, options = {}) {
  const attempts = Number(options.attempts || 3);
  const retryDelayMs = Number(options.retryDelayMs || 500);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isInjectableTab(tab)) {
        return { ok: false, reason: 'This tab cannot be inspected. Open an http or https page first.' };
      }

      if (tab.status === 'loading') {
        await delay(retryDelayMs);
        continue;
      }

      const frames = await chrome.scripting.executeScript({
        ...injection,
        target: { tabId }
      });

      return { ok: true, frames };
    } catch (error) {
      if (isRemovedFrameError(error) && attempt < attempts) {
        await delay(retryDelayMs);
        continue;
      }

      return { ok: false, reason: error?.message || String(error), error };
    }
  }

  return { ok: false, reason: 'The page was still changing, so the frame could not be inspected.' };
}

const elements = {
  activeUrl: document.querySelector('#activeUrl'),
  copyButton: document.querySelector('#copyButton'),
  optionsButton: document.querySelector('#optionsButton'),
  refreshButton: document.querySelector('#refreshButton'),
  ruleValue: document.querySelector('#ruleValue'),
  targetValue: document.querySelector('#targetValue'),
  sourceTextarea: document.querySelector('#sourceTextarea'),
  pythonResponseTextarea: document.querySelector('#pythonResponseTextarea'),
  status: document.querySelector('#status')
};

elements.refreshButton.addEventListener('click', renderElementSourceForActiveTab);
elements.copyButton.addEventListener('click', copySource);
elements.optionsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());
document.addEventListener('DOMContentLoaded', async () => {
  await loadStoredPythonResponse();
  await renderElementSourceForActiveTab();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes.lastPythonResponse || changes.lastPythonError || changes.lastPythonProcessedAt || changes.lastScreenshotPath || changes.lastScreenshotError) {
    loadStoredPythonResponse().catch((error) => console.warn('URL Guard popup: response load failed.', error?.message || error));
  }
});

async function renderElementSourceForActiveTab() {
  setBusy(true);
  setStatus('Checking current tab...');
  elements.copyButton.disabled = true;
  elements.sourceTextarea.value = '';

  try {
    const config = await getConfig();
    elements.ruleValue.textContent = config.urlRule || 'Not configured';
    elements.targetValue.textContent = config.formId && config.elementSelector
      ? toDisplaySelector(config.formId, config.elementSelector)
      : 'Not configured';

    const validation = validateConfig(config);
    if (!validation.ok) {
      setStatus(validation.reason);
      return;
    }

    const tab = await getActiveTab();
    elements.activeUrl.textContent = tab.url || 'Unknown';

    if (!matchesConfiguredRule(tab.url, config.urlRule)) {
      setStatus('This tab does not match the configured target URL.');
      return;
    }

    const result = await getTargetElementSource(tab.id, config.formId, config.elementSelector);

    if (!result.ok) {
      setStatus(result.reason);
      return;
    }

    elements.sourceTextarea.value = result.html;
    elements.copyButton.disabled = result.html.length === 0;

    const saveResult = await saveExtractedBackgroundImage(result);
    setStatus(buildStatusMessage(result, saveResult));
  } catch (error) {
    setStatus(error.message || 'Could not read this page.');
  } finally {
    setBusy(false);
  }
}

async function loadStoredPythonResponse() {
  const state = await chrome.storage.local.get({
    [LOCAL_STORAGE_KEYS.lastPythonResponse]: '',
    [LOCAL_STORAGE_KEYS.lastPythonError]: '',
    [LOCAL_STORAGE_KEYS.lastPythonProcessedAt]: '',
    [LOCAL_STORAGE_KEYS.lastDownloadedFilename]: '',
    [LOCAL_STORAGE_KEYS.lastScreenshotPath]: '',
    [LOCAL_STORAGE_KEYS.lastScreenshotSavedAt]: '',
    [LOCAL_STORAGE_KEYS.lastScreenshotError]: ''
  });

  const response = state[LOCAL_STORAGE_KEYS.lastPythonResponse];
  const error = state[LOCAL_STORAGE_KEYS.lastPythonError];
  const processedAt = state[LOCAL_STORAGE_KEYS.lastPythonProcessedAt];
  const filename = state[LOCAL_STORAGE_KEYS.lastDownloadedFilename];
  const screenshotPath = state[LOCAL_STORAGE_KEYS.lastScreenshotPath];
  const screenshotSavedAt = state[LOCAL_STORAGE_KEYS.lastScreenshotSavedAt];
  const screenshotError = state[LOCAL_STORAGE_KEYS.lastScreenshotError];

  if (response) {
    elements.pythonResponseTextarea.value = [
      processedAt ? `Processed at: ${processedAt}` : '',
      filename ? `Image path: ${filename}` : '',
      screenshotPath ? `Last screenshot path: ${screenshotPath}` : '',
      response
    ].filter(Boolean).join('\n\n');
    return;
  }

  if (screenshotPath || screenshotError) {
    elements.pythonResponseTextarea.value = [
      screenshotSavedAt ? `Screenshot saved at: ${screenshotSavedAt}` : '',
      screenshotPath ? `Screenshot path: ${screenshotPath}` : '',
      screenshotError ? `Screenshot error: ${screenshotError}` : ''
    ].filter(Boolean).join('\n\n');
    return;
  }

  if (error) {
    elements.pythonResponseTextarea.value = [
      processedAt ? `Processed at: ${processedAt}` : '',
      `Python error: ${error}`
    ].filter(Boolean).join('\n\n');
    return;
  }

  elements.pythonResponseTextarea.value = '';
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error('No active tab found.');
  }

  if (!isInjectableTab(tab)) {
    throw new Error('Open the configured http/https target page before using the popup. Chrome internal pages cannot be inspected.');
  }

  return tab;
}

async function getTargetElementSource(tabId, formId, elementSelector) {
  const injection = await executePageScript(tabId, {
    args: [formId, elementSelector],
    func: (configuredFormId, configuredElementSelector) => {
      const form = document.getElementById(configuredFormId);

      if (!form) {
        const reason = `No form found with id "${configuredFormId}".`;

        try {
          console.log(`URL Guard: form id "${configuredFormId}" was not found on this page. Please check the Form ID saved in extension options.`);
        } catch (error) {
          console.warn(reason, error);
        }

        return {
          ok: false,
          reason,
          formMissing: true
        };
      }

      const target = form.querySelector(configuredElementSelector);

      if (!target) {
        return {
          ok: false,
          reason: `No element found inside #${configuredFormId} for selector "${configuredElementSelector}".`
        };
      }

      const inlineStyle = target.getAttribute('style') || '';
      const backgroundImageUrl = extractBackgroundImageUrl(target, inlineStyle);

      return {
        ok: true,
        selector: `#${configuredFormId} ${configuredElementSelector}`,
        html: target.outerHTML,
        inlineStyle,
        backgroundImageUrl,
        backgroundImageMimeType: detectDataUrlMimeType(backgroundImageUrl)
      };

      function extractBackgroundImageUrl(element, styleAttribute) {
        const fromInlineStyle = extractFirstCssUrl(styleAttribute);
        if (fromInlineStyle) return normalizeCssUrl(fromInlineStyle, document.baseURI);

        const computedBackgroundImage = window.getComputedStyle(element).backgroundImage || '';
        const fromComputedStyle = extractFirstCssUrl(computedBackgroundImage);
        return fromComputedStyle ? normalizeCssUrl(fromComputedStyle, document.baseURI) : '';
      }

      function extractFirstCssUrl(cssValue) {
        const match = String(cssValue || '').match(/url\(\s*(['"]?)(.*?)\1\s*\)/i);
        return match?.[2]?.trim() || '';
      }

      function normalizeCssUrl(rawUrl, baseUrl) {
        if (!rawUrl) return '';
        if (/^data:image\//i.test(rawUrl)) return rawUrl;

        try {
          return new URL(rawUrl, baseUrl).href;
        } catch {
          return rawUrl;
        }
      }

      function detectDataUrlMimeType(url) {
        const match = String(url || '').match(/^data:([^;,]+)[;,]/i);
        return match?.[1]?.toLowerCase() || '';
      }
    }
  });

  if (!injection.ok) {
    console.warn('URL Guard popup: page inspection skipped.', injection.reason);
    return { ok: false, reason: injection.reason };
  }

  const [{ result } = {}] = injection.frames || [];
  return result || { ok: false, reason: 'No result returned from the active page.' };
}

async function saveExtractedBackgroundImage(result) {
  if (!result.backgroundImageUrl) {
    await chrome.storage.local.set({
      [LOCAL_STORAGE_KEYS.lastElementHtml]: result.html,
      [LOCAL_STORAGE_KEYS.lastInlineStyle]: result.inlineStyle,
      [LOCAL_STORAGE_KEYS.lastBackgroundImageUrl]: '',
      [LOCAL_STORAGE_KEYS.lastBackgroundImageMimeType]: '',
      [LOCAL_STORAGE_KEYS.lastSavedAt]: new Date().toISOString()
    });

    return { saved: false, downloaded: false, reason: 'No background url(...) found in the target element style.' };
  }

  const savedAt = new Date().toISOString();
  await chrome.storage.local.set({
    [LOCAL_STORAGE_KEYS.lastElementHtml]: result.html,
    [LOCAL_STORAGE_KEYS.lastInlineStyle]: result.inlineStyle,
    [LOCAL_STORAGE_KEYS.lastBackgroundImageUrl]: result.backgroundImageUrl,
    [LOCAL_STORAGE_KEYS.lastBackgroundImageMimeType]: result.backgroundImageMimeType,
    [LOCAL_STORAGE_KEYS.lastSavedAt]: savedAt
  });

  const downloadId = await downloadBackgroundImage(result.backgroundImageUrl, result.backgroundImageMimeType);

  if (downloadId) {
    await chrome.storage.local.set({ [LOCAL_STORAGE_KEYS.lastDownloadId]: downloadId });
  }

  return {
    saved: true,
    downloaded: Boolean(downloadId),
    downloadId,
    savedAt
  };
}

async function downloadBackgroundImage(imageUrl, mimeType) {
  if (!USE_CHROME_DOWNLOADS) {
    return null;
  }

  if (!isDownloadableImageUrl(imageUrl)) {
    return null;
  }

  const extension = getImageFileExtension(mimeType, imageUrl);
  const filename = `url-guard/background-image-${Date.now()}.${extension}`;

  return chrome.downloads.download({
    url: imageUrl,
    filename,
    saveAs: false,
    conflictAction: 'uniquify'
  });
}

function isDownloadableImageUrl(imageUrl) {
  return /^data:image\//i.test(imageUrl) || /^https?:\/\//i.test(imageUrl);
}

function getImageFileExtension(mimeType, imageUrl) {
  const normalizedMimeType = String(mimeType || '').toLowerCase();

  const byMimeType = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp'
  };

  if (byMimeType[normalizedMimeType]) {
    return byMimeType[normalizedMimeType];
  }

  const urlExtension = String(imageUrl || '').match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1]?.toLowerCase();
  return urlExtension || 'img';
}

function buildStatusMessage(result, saveResult) {
  const htmlSize = result.html.length.toLocaleString();

  if (!saveResult.saved) {
    return `Loaded ${htmlSize} characters from ${result.selector}. ${saveResult.reason}`;
  }

  if (saveResult.downloaded) {
    return `Loaded ${htmlSize} characters. Background image saved automatically by Python without a Save As prompt.`;
  }

  return `Loaded ${htmlSize} characters. Background image URL saved. Python will auto-save it during processing.`;
}

async function copySource() {
  await navigator.clipboard.writeText(elements.sourceTextarea.value);
  setStatus('Element HTML copied to clipboard.');
}

function setBusy(isBusy) {
  elements.refreshButton.disabled = isBusy;
}

function setStatus(message) {
  elements.status.textContent = message;
}
