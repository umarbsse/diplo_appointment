import { getConfig, matchesConfiguredRule, toDisplaySelector, validateConfig } from './config.js';

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
  savedInputValue: 'savedInputValue'
});

const elements = {
  activeUrl: document.querySelector('#activeUrl'),
  copyButton: document.querySelector('#copyButton'),
  optionsButton: document.querySelector('#optionsButton'),
  refreshButton: document.querySelector('#refreshButton'),
  ruleValue: document.querySelector('#ruleValue'),
  targetValue: document.querySelector('#targetValue'),
  sourceTextarea: document.querySelector('#sourceTextarea'),
  pythonResponseTextarea: document.querySelector('#pythonResponseTextarea'),
  savedInput: document.querySelector('#savedInput'),
  status: document.querySelector('#status')
};

elements.refreshButton.addEventListener('click', renderElementSourceForActiveTab);
elements.copyButton.addEventListener('click', copySource);
elements.optionsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());
elements.savedInput.addEventListener('input', saveCustomInput);

document.addEventListener('DOMContentLoaded', async () => {
  await loadSavedCustomInput();
  await loadStoredPythonResponse();
  await renderElementSourceForActiveTab();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes.lastPythonResponse || changes.lastPythonError || changes.lastPythonProcessedAt) {
    loadStoredPythonResponse().catch(console.error);
    fillSavedInputOnActiveTab().catch(console.error);
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
      setStatus('This tab does not match the configured URL rule.');
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

async function loadSavedCustomInput() {
  const state = await chrome.storage.local.get({
    [LOCAL_STORAGE_KEYS.savedInputValue]: ''
  });

  elements.savedInput.value = state[LOCAL_STORAGE_KEYS.savedInputValue] || '';
}

async function saveCustomInput() {
  const inputName = elements.savedInput.value.trim();

  await chrome.storage.local.set({
    [LOCAL_STORAGE_KEYS.savedInputValue]: inputName
  });

  if (inputName) {
    await fillSavedInputOnActiveTab();
  }
}

async function fillSavedInputOnActiveTab() {
  try {
    const state = await chrome.storage.local.get({
      [LOCAL_STORAGE_KEYS.savedInputValue]: '',
      [LOCAL_STORAGE_KEYS.lastPythonResponse]: ''
    });
    const inputName = String(state[LOCAL_STORAGE_KEYS.savedInputValue] || '').trim();
    const pythonValue = extractPythonResponseValue(state[LOCAL_STORAGE_KEYS.lastPythonResponse]);

    if (!inputName || !pythonValue) return;

    const tab = await getActiveTab();

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [inputName, pythonValue],
      func: (targetInputName, valueToWrite) => {
        const input = Array.from(document.getElementsByName(targetInputName))
          .find((element) => element instanceof HTMLInputElement);

        if (!input) {
          return { ok: false, reason: `No input found with name=\"${targetInputName}\".` };
        }

        input.focus();
        input.value = valueToWrite;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        return { ok: true };
      }
    });
  } catch (error) {
    console.warn('Could not fill the live page input.', error);
  }
}



function extractPythonResponseValue(rawResponse) {
  if (!rawResponse) return '';

  if (typeof rawResponse !== 'string') {
    return extractPythonResponseValueFromObject(rawResponse);
  }

  const trimmed = rawResponse.trim();
  if (!trimmed) return '';

  try {
    return extractPythonResponseValueFromObject(JSON.parse(trimmed));
  } catch {
    return trimmed;
  }
}

function extractPythonResponseValueFromObject(response) {
  if (response == null) return '';

  if (typeof response === 'string' || typeof response === 'number' || typeof response === 'boolean') {
    return String(response);
  }

  const preferredKeys = ['decodedText', 'value', 'text', 'result', 'output', 'message'];
  for (const key of preferredKeys) {
    if (response[key] != null && String(response[key]).trim()) {
      return String(response[key]).trim();
    }
  }

  try {
    return JSON.stringify(response, null, 2).trim();
  } catch {
    return String(response).trim();
  }
}

async function loadStoredPythonResponse() {
  const state = await chrome.storage.local.get({
    [LOCAL_STORAGE_KEYS.lastPythonResponse]: '',
    [LOCAL_STORAGE_KEYS.lastPythonError]: '',
    [LOCAL_STORAGE_KEYS.lastPythonProcessedAt]: '',
    [LOCAL_STORAGE_KEYS.lastDownloadedFilename]: ''
  });

  const response = state[LOCAL_STORAGE_KEYS.lastPythonResponse];
  const error = state[LOCAL_STORAGE_KEYS.lastPythonError];
  const processedAt = state[LOCAL_STORAGE_KEYS.lastPythonProcessedAt];
  const filename = state[LOCAL_STORAGE_KEYS.lastDownloadedFilename];

  if (response) {
    elements.pythonResponseTextarea.value = [
      processedAt ? `Processed at: ${processedAt}` : '',
      filename ? `Image path: ${filename}` : '',
      response
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

  return tab;
}

async function getTargetElementSource(tabId, formId, elementSelector) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [formId, elementSelector],
    func: (configuredFormId, configuredElementSelector) => {
      const form = document.getElementById(configuredFormId);

      if (!form) {
        return {
          ok: false,
          reason: `No form found with id "${configuredFormId}".`
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
    return `Loaded ${htmlSize} characters. Background image saved and downloaded automatically.`;
  }

  return `Loaded ${htmlSize} characters. Background image URL saved in extension storage.`;
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
