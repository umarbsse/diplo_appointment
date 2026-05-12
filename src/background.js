import { getConfig, matchesConfiguredRule } from './config.js';

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
  lastAutoDownloadKey: 'lastAutoDownloadKey',
  savedInputValue: 'savedInputValue'
});

const pendingAutoScans = new Set();
const NATIVE_HOST_NAME = 'com.url_guard.processor';

chrome.runtime.onInstalled.addListener(() => {
  refreshActionForActiveTab().catch(console.error);
});

chrome.tabs.onActivated.addListener(() => {
  refreshActionForActiveTab().catch(console.error);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    refreshAction(tabId, tab.url || changeInfo.url).catch(console.error);
  }

  if (changeInfo.status === 'complete' && tab.url) {
    autoScanAndDownload(tabId, tab.url).catch(console.error);
    fillSavedInputOnTab(tabId).catch(console.error);
  }
});


chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'PROCESS_EXTRACTED_IMAGE') return false;

  handleExtractedImageMessage(message.payload, sender).catch(console.error);
  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && (changes.urlRule || changes.formId || changes.elementSelector)) {
    refreshActionForActiveTab().catch(console.error);
  }

  if (areaName === 'local' && (changes.savedInputValue?.newValue || changes.lastPythonResponse?.newValue)) {
    fillSavedInputOnActiveTab().catch(console.error);
  }
});



async function fillSavedInputOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.id) {
    await fillSavedInputOnTab(tab.id);
  }
}

async function fillSavedInputOnTab(tabId) {
  const state = await chrome.storage.local.get({
    [LOCAL_STORAGE_KEYS.savedInputValue]: '',
    [LOCAL_STORAGE_KEYS.lastPythonResponse]: ''
  });
  const inputName = String(state[LOCAL_STORAGE_KEYS.savedInputValue] || '').trim();
  const pythonValue = extractPythonResponseValue(state[LOCAL_STORAGE_KEYS.lastPythonResponse]);

  if (!inputName || !pythonValue) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [inputName, pythonValue],
      func: (targetInputName, valueToWrite) => {
        const input = Array.from(document.getElementsByName(targetInputName))
          .find((element) => element instanceof HTMLInputElement);

        if (!input) return false;

        input.focus();
        input.value = valueToWrite;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    });
  } catch (error) {
    console.warn('Could not fill saved input on tab.', error);
  }
}

async function handleExtractedImageMessage(payload, sender) {
  if (!payload?.imageUrl) return;

  const sourcePageUrl = payload.pageUrl || sender?.tab?.url || '';
  const savedAt = new Date().toISOString();
  const result = {
    ok: true,
    selector: payload.formId && payload.elementSelector ? `#${payload.formId} ${payload.elementSelector}` : '',
    html: payload.elementHtml || '',
    inlineStyle: payload.inlineStyle || '',
    backgroundImageUrl: payload.imageUrl,
    backgroundImageMimeType: detectDataUrlMimeType(payload.imageUrl)
  };

  const downloadId = await downloadBackgroundImage(result.backgroundImageUrl, result.backgroundImageMimeType);
  const downloadItem = downloadId ? await waitForDownloadComplete(downloadId) : null;

  await saveAutoDownloadState({
    result,
    savedAt,
    downloadId,
    downloadedFilename: downloadItem?.filename || '',
    imageKey: await buildStableImageKey(sourcePageUrl, payload.formId || '', payload.elementSelector || '', result.backgroundImageUrl)
  });

  await runPythonProcessor({
    result,
    savedAt,
    downloadId,
    downloadedFilename: downloadItem?.filename || '',
    tabUrl: sourcePageUrl,
    tabId: sender?.tab?.id
  });
}

function detectDataUrlMimeType(url) {
  const match = String(url || '').match(/^data:([^;,]+)[;,]/i);
  return match?.[1]?.toLowerCase() || '';
}

async function refreshActionForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.id) {
    await refreshAction(tab.id, tab.url);
  }
}

async function refreshAction(tabId, tabUrl) {
  const config = await getConfig();
  const isMatch = matchesConfiguredRule(tabUrl, config.urlRule);

  await chrome.action.setBadgeText({ tabId, text: isMatch ? 'ON' : '' });
  await chrome.action.setTitle({
    tabId,
    title: isMatch
      ? 'URL matched. Auto-download is enabled after page load.'
      : 'Configure or open a matching URL to view source.'
  });
}

async function autoScanAndDownload(tabId, tabUrl) {
  const config = await getConfig();

  if (!config.urlRule || !config.formId || !config.elementSelector) return;
  if (!matchesConfiguredRule(tabUrl, config.urlRule)) return;

  const scanKey = `${tabId}:${tabUrl}:${config.formId}:${config.elementSelector}`;
  if (pendingAutoScans.has(scanKey)) return;

  pendingAutoScans.add(scanKey);

  try {
    const result = await extractFromTab(tabId, config.formId, config.elementSelector);
    if (!result?.ok || !result.backgroundImageUrl) return;

    const imageKey = await buildStableImageKey(tabUrl, config.formId, config.elementSelector, result.backgroundImageUrl);
    const lastState = await chrome.storage.local.get(LOCAL_STORAGE_KEYS.lastAutoDownloadKey);

    if (lastState[LOCAL_STORAGE_KEYS.lastAutoDownloadKey] === imageKey) return;

    const downloadId = await downloadBackgroundImage(result.backgroundImageUrl, result.backgroundImageMimeType);
    const downloadItem = downloadId ? await waitForDownloadComplete(downloadId) : null;
    const savedAt = new Date().toISOString();

    await saveAutoDownloadState({
      result,
      savedAt,
      downloadId,
      downloadedFilename: downloadItem?.filename || '',
      imageKey
    });

    await runPythonProcessor({
      result,
      savedAt,
      downloadId,
      downloadedFilename: downloadItem?.filename || '',
      tabUrl,
      tabId
    });
  } finally {
    pendingAutoScans.delete(scanKey);
  }
}

async function extractFromTab(tabId, formId, elementSelector) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [formId, elementSelector],
    func: extractBackgroundImageFromConfiguredElement
  });

  return result || { ok: false, reason: 'No result returned from the page.' };
}

function extractBackgroundImageFromConfiguredElement(configuredFormId, configuredElementSelector) {
  const MAX_ATTEMPTS = 40;
  const RETRY_DELAY_MS = 250;

  return new Promise((resolve) => {
    let attempts = 0;

    const timer = window.setInterval(() => {
      attempts += 1;
      const result = findTargetBackgroundImage(configuredFormId, configuredElementSelector);

      if (result.ok || attempts >= MAX_ATTEMPTS) {
        window.clearInterval(timer);
        resolve(result);
      }
    }, RETRY_DELAY_MS);
  });

  function findTargetBackgroundImage(formId, selector) {
    const form = document.getElementById(formId);

    if (!form) {
      return { ok: false, reason: `No form found with id "${formId}".` };
    }

    let target;
    try {
      target = form.querySelector(selector);
    } catch {
      return { ok: false, reason: `Invalid selector "${selector}".` };
    }

    if (!target) {
      return { ok: false, reason: `No element found inside #${formId} for selector "${selector}".` };
    }

    const inlineStyle = target.getAttribute('style') || '';
    const backgroundImageUrl = extractBackgroundImageUrl(target, inlineStyle);

    if (!backgroundImageUrl) {
      return { ok: false, reason: 'Target element was found, but no background url(...) was found.' };
    }

    return {
      ok: true,
      selector: `#${formId} ${selector}`,
      html: target.outerHTML,
      inlineStyle,
      backgroundImageUrl,
      backgroundImageMimeType: detectDataUrlMimeType(backgroundImageUrl)
    };
  }

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

async function saveAutoDownloadState({ result, savedAt, downloadId, downloadedFilename, imageKey }) {
  const fullState = {
    [LOCAL_STORAGE_KEYS.lastElementHtml]: result.html,
    [LOCAL_STORAGE_KEYS.lastInlineStyle]: result.inlineStyle,
    [LOCAL_STORAGE_KEYS.lastBackgroundImageUrl]: result.backgroundImageUrl,
    [LOCAL_STORAGE_KEYS.lastBackgroundImageMimeType]: result.backgroundImageMimeType,
    [LOCAL_STORAGE_KEYS.lastSavedAt]: savedAt,
    [LOCAL_STORAGE_KEYS.lastDownloadId]: downloadId ?? '',
    [LOCAL_STORAGE_KEYS.lastDownloadedFilename]: downloadedFilename || '',
    [LOCAL_STORAGE_KEYS.lastPythonResponse]: '',
    [LOCAL_STORAGE_KEYS.lastPythonError]: '',
    [LOCAL_STORAGE_KEYS.lastPythonProcessedAt]: '',
    [LOCAL_STORAGE_KEYS.lastAutoDownloadKey]: imageKey
  };

  try {
    await chrome.storage.local.set(fullState);
  } catch (error) {
    await chrome.storage.local.set({
      [LOCAL_STORAGE_KEYS.lastElementHtml]: truncateForStorage(result.html, 50000),
      [LOCAL_STORAGE_KEYS.lastInlineStyle]: truncateForStorage(result.inlineStyle, 50000),
      [LOCAL_STORAGE_KEYS.lastBackgroundImageUrl]: truncateForStorage(result.backgroundImageUrl, 50000),
      [LOCAL_STORAGE_KEYS.lastBackgroundImageMimeType]: result.backgroundImageMimeType,
      [LOCAL_STORAGE_KEYS.lastSavedAt]: savedAt,
      [LOCAL_STORAGE_KEYS.lastDownloadId]: downloadId ?? '',
      [LOCAL_STORAGE_KEYS.lastDownloadedFilename]: downloadedFilename || '',
      [LOCAL_STORAGE_KEYS.lastPythonResponse]: '',
      [LOCAL_STORAGE_KEYS.lastPythonError]: '',
      [LOCAL_STORAGE_KEYS.lastPythonProcessedAt]: '',
      [LOCAL_STORAGE_KEYS.lastAutoDownloadKey]: imageKey
    });

    console.warn('Saved compressed auto-download metadata because the extracted source was too large for storage.', error);
  }
}


async function waitForDownloadComplete(downloadId) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(async () => {
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(await findDownloadItem(downloadId));
    }, 30000);

    async function onChanged(delta) {
      if (delta.id !== downloadId) return;

      if (delta.error) {
        clearTimeout(timeoutId);
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(await findDownloadItem(downloadId));
        return;
      }

      if (delta.state?.current === 'complete') {
        clearTimeout(timeoutId);
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(await findDownloadItem(downloadId));
      }
    }

    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function findDownloadItem(downloadId) {
  const [item] = await chrome.downloads.search({ id: downloadId });
  return item || null;
}

async function runPythonProcessor({ result, savedAt, downloadId, downloadedFilename, tabUrl, tabId }) {
  const processedAt = new Date().toISOString();

  try {
    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      event: 'image_saved',
      savedAt,
      tabUrl,
      selector: result.selector,
      downloadId: downloadId ?? null,
      imagePath: downloadedFilename || '',
      imageUrl: result.backgroundImageUrl,
      mimeType: result.backgroundImageMimeType || '',
      elementHtml: truncateForStorage(result.html, 50000)
    });

    const displayResponse = stringifyForDisplay(response);

    await chrome.storage.local.set({
      [LOCAL_STORAGE_KEYS.lastPythonResponse]: displayResponse,
      [LOCAL_STORAGE_KEYS.lastPythonError]: '',
      [LOCAL_STORAGE_KEYS.lastPythonProcessedAt]: processedAt
    });

    if (tabId) {
      await fillSavedInputOnTab(tabId);
    } else {
      await fillSavedInputOnActiveTab();
    }
  } catch (error) {
    await chrome.storage.local.set({
      [LOCAL_STORAGE_KEYS.lastPythonResponse]: '',
      [LOCAL_STORAGE_KEYS.lastPythonError]: error?.message || 'Python Native Messaging host failed.',
      [LOCAL_STORAGE_KEYS.lastPythonProcessedAt]: processedAt
    });
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

  return stringifyForDisplay(response).trim();
}

function stringifyForDisplay(value) {
  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateForStorage(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}... [truncated]` : text;
}

async function downloadBackgroundImage(imageUrl, mimeType) {
  if (!isDownloadableImageUrl(imageUrl)) return null;

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

  if (byMimeType[normalizedMimeType]) return byMimeType[normalizedMimeType];

  const urlExtension = String(imageUrl || '').match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1]?.toLowerCase();
  return urlExtension || 'img';
}

async function buildStableImageKey(tabUrl, formId, selector, imageUrl) {
  const value = `${tabUrl}\n${formId}\n${selector}\n${imageUrl}`;
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
