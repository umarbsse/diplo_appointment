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
  savedInputValue: 'savedInputValue',
  clickInputSelector: 'clickInputSelector',
  lastClickInputError: 'lastClickInputError',
  lastFormLookupError: 'lastFormLookupError',
  lastScreenshotPath: 'lastScreenshotPath',
  lastScreenshotSavedAt: 'lastScreenshotSavedAt',
  lastScreenshotError: 'lastScreenshotError',
  lastMissingFormScreenshotKey: 'lastMissingFormScreenshotKey'
});

const pendingAutoScans = new Set();
const NATIVE_HOST_NAME = 'com.url_guard.processor';
const USE_CHROME_DOWNLOADS = false; // false avoids Chrome Save As prompts; Python saves the image automatically.

const REMOVED_FRAME_ERROR_PATTERN = /Frame with ID \d+ was removed|No frame with id|Receiving end does not exist/i;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRemovedFrameError(error) {
  return REMOVED_FRAME_ERROR_PATTERN.test(String(error?.message || error || ''));
}

function isExtensionInjectableUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

async function getUsableTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.id || tab.discarded || !isExtensionInjectableUrl(tab.url)) return null;
    return tab;
  } catch (error) {
    console.warn('URL Guard: tab is no longer available.', { tabId, error });
    return null;
  }
}

async function executePageScript(tabId, injection, options = {}) {
  const attempts = Number(options.attempts || 3);
  const retryDelayMs = Number(options.retryDelayMs || 500);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const tab = await getUsableTab(tabId);
    if (!tab) {
      return { ok: false, reason: `Tab ${tabId} is not available or is not an http/https page.` };
    }

    if (tab.status === 'loading') {
      await delay(retryDelayMs);
      continue;
    }

    const urlBeforeInjection = tab.url || '';

    try {
      const frames = await chrome.scripting.executeScript({
        ...injection,
        target: { tabId }
      });

      const tabAfterInjection = await getUsableTab(tabId);
      if (tabAfterInjection?.url && tabAfterInjection.url !== urlBeforeInjection && attempt < attempts) {
        await delay(retryDelayMs);
        continue;
      }

      return { ok: true, frames, tab: tabAfterInjection || tab };
    } catch (error) {
      if (isRemovedFrameError(error) && attempt < attempts) {
        await delay(retryDelayMs);
        continue;
      }

      return { ok: false, reason: error?.message || String(error), error };
    }
  }

  return { ok: false, reason: 'Script injection failed because the page frame was still changing.' };
}

chrome.runtime.onInstalled.addListener(() => {
  refreshActionForActiveTab().catch((error) => console.warn('URL Guard: refresh failed.', error?.message || error));
});

chrome.tabs.onActivated.addListener(() => {
  refreshActionForActiveTab().catch((error) => console.warn('URL Guard: refresh failed.', error?.message || error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    refreshAction(tabId, tab.url || changeInfo.url).catch((error) => console.warn('URL Guard: action refresh failed.', error?.message || error));
  }

  if (changeInfo.status === 'complete' && tab.url) {
    scheduleAutoScan(tabId, tab.url).catch((error) => {
      console.warn('URL Guard: scheduled scan failed.', error?.message || error);
    });
  }
});


chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'PROCESS_EXTRACTED_IMAGE') return false;

  handleExtractedImageMessage(message.payload, sender).catch((error) => console.warn('URL Guard: image message failed.', error?.message || error));
  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && (changes.urlRule || changes.urlRules || changes.formId || changes.elementSelector)) {
    refreshActionForActiveTab().catch((error) => console.warn('URL Guard: refresh failed.', error?.message || error));
  }

  if (areaName === 'local' && (changes.savedInputValue?.newValue || changes.clickInputSelector?.newValue || changes.lastPythonResponse?.newValue)) {
    handleLivePageInputsOnActiveTab().catch((error) => console.warn('URL Guard: live page input handling failed.', error?.message || error));
  }
});



async function handleLivePageInputsOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.id) {
    await handleLivePageInputsOnTab(tab.id);
  }
}

async function handleLivePageInputsOnTab(tabId) {
  await fillSavedInputOnTab(tabId);
  await clickConfiguredInputOnTab(tabId);
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
    const injection = await executePageScript(tabId, {
      args: [inputName, pythonValue],
      func: (targetInputName, valueToWrite) => {
        const input = findInputByIdOrName(targetInputName);

        if (!input) {
          console.warn(`URL Guard: no input found to fill for id or name "${targetInputName}".`);
          return false;
        }

        input.focus();
        input.value = valueToWrite;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;

        function findInputByIdOrName(value) {
          const target = String(value || '').trim();
          if (!target) return null;

          const byId = document.getElementById(target);
          if (byId instanceof HTMLInputElement) return byId;

          return Array.from(document.getElementsByName(target))
            .find((element) => element instanceof HTMLInputElement) || null;
        }
      }
    });

    if (!injection.ok) {
      console.warn('URL Guard: could not fill saved input because the page frame was unavailable.', injection.reason);
    }
  } catch (error) {
    console.warn('Could not fill saved input on tab.', error);
  }
}

async function clickConfiguredInputOnTab(tabId) {
  const state = await chrome.storage.local.get({
    [LOCAL_STORAGE_KEYS.clickInputSelector]: '',
    [LOCAL_STORAGE_KEYS.lastPythonResponse]: ''
  });
  const target = String(state[LOCAL_STORAGE_KEYS.clickInputSelector] || '').trim();
  const pythonValue = extractPythonResponseValue(state[LOCAL_STORAGE_KEYS.lastPythonResponse]);

  if (!target || !pythonValue) return;

  try {
    const injection = await executePageScript(tabId, {
      args: [target],
      func: (targetInput) => {
        const input = findInputByIdNameOrSelector(targetInput);

        if (!input) {
          const message = `URL Guard: no input found to click for id, name, or selector "${targetInput}".`;
          console.warn(message);
          return { ok: false, reason: message };
        }

        input.scrollIntoView({ block: 'center', inline: 'nearest' });
        input.focus();
        input.click();
        return { ok: true };

        function findInputByIdNameOrSelector(value) {
          const target = String(value || '').trim();
          if (!target) return null;

          const byId = document.getElementById(target);
          if (byId instanceof HTMLInputElement) return byId;

          const byName = Array.from(document.getElementsByName(target))
            .find((element) => element instanceof HTMLInputElement);
          if (byName) return byName;

          try {
            const bySelector = document.querySelector(target);
            if (bySelector instanceof HTMLInputElement) return bySelector;
          } catch (error) {
            return null;
          }

          return null;
        }
      }
    });

    if (!injection.ok) {
      const reason = `URL Guard: could not click configured input because the page frame was unavailable: ${injection.reason}`;
      await chrome.storage.local.set({ [LOCAL_STORAGE_KEYS.lastClickInputError]: reason });
      console.warn(reason, injection.error || '');
      return;
    }

    const [{ result } = {}] = injection.frames || [];

    if (!result?.ok) {
      const reason = result?.reason || `No matching input found for "${target}".`;
      await chrome.storage.local.set({ [LOCAL_STORAGE_KEYS.lastClickInputError]: reason });
      console.warn(reason);
      return;
    }

    await chrome.storage.local.set({ [LOCAL_STORAGE_KEYS.lastClickInputError]: '' });
  } catch (error) {
    const reason = error?.message || 'Could not click configured live page input.';
    await chrome.storage.local.set({ [LOCAL_STORAGE_KEYS.lastClickInputError]: reason });
    console.warn('Could not click configured live page input.', error);
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
      ? 'Target URL matched. Auto-download is enabled after page load.'
      : 'Configure or open the matching target URL to view source.'
  });
}

async function scheduleAutoScan(tabId, expectedUrl) {
  await delay(1000);
  const tab = await getUsableTab(tabId);

  if (!tab?.url || tab.url !== expectedUrl || tab.status === 'loading') {
    console.warn('URL Guard: skipped auto-scan because the page changed before it became stable.', {
      tabId,
      expectedUrl,
      currentUrl: tab?.url || '',
      status: tab?.status || ''
    });
    return;
  }

  await autoScanAndDownload(tabId, tab.url);
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

    if (!result?.ok) {
      await handleExtractionFailure({ tabId, tabUrl, config, result });
      return;
    }

    if (!result.backgroundImageUrl) return;

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
  const injection = await executePageScript(tabId, {
    args: [formId, elementSelector],
    func: extractBackgroundImageFromConfiguredElement
  }, { attempts: 3, retryDelayMs: 400 });

  if (!injection.ok) {
    const reason = `Could not inspect the page because the frame was removed or unavailable: ${injection.reason}`;
    console.warn('URL Guard:', reason, injection.error || '');
    return { ok: false, reason, transientFrameError: isRemovedFrameError(injection.error) };
  }

  const [{ result } = {}] = injection.frames || [];
  return result || { ok: false, reason: 'No result returned from the page.' };
}

async function handleExtractionFailure({ tabId, tabUrl, config, result }) {
  const reason = result?.reason || 'Could not extract the configured element.';

  await chrome.storage.local.set({
    [LOCAL_STORAGE_KEYS.lastFormLookupError]: reason,
    [LOCAL_STORAGE_KEYS.lastScreenshotPath]: '',
    [LOCAL_STORAGE_KEYS.lastScreenshotError]: ''
  });

  if (result?.formMissing) {
    const screenshotKey = await buildMissingFormScreenshotKey(tabUrl, config.formId);

    console.log(`URL Guard: saved form id "${config.formId}" was not found on this page.`, {
      tabUrl,
      formId: config.formId,
      reason
    });

    await captureAndSaveMissingFormScreenshot({
      tabId,
      tabUrl,
      formId: config.formId,
      reason,
      screenshotKey
    });
    return;
  }

  console.warn('URL Guard:', reason);
}

async function buildMissingFormScreenshotKey(tabUrl, formId) {
  const value = `${stripUrlQueryAndHash(tabUrl)}\n${formId}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stripUrlQueryAndHash(url) {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return String(url || '').split('#')[0].split('?')[0];
  }
}

async function captureAndSaveMissingFormScreenshot({ tabId, tabUrl, formId, reason, screenshotKey }) {
  const savedAt = new Date().toISOString();

  try {
    console.log('URL Guard: captureVisibleTab starting.', { tabId, tabUrl, formId });
    await logToPageConsole(tabId, 'URL Guard: captureVisibleTab starting.');

    const tab = await getUsableTab(tabId);
    if (!tab) {
      throw new Error(`Cannot capture screenshot because tab ${tabId} is no longer available.`);
    }

    console.log('URL Guard: captureVisibleTab window id:', tab.windowId);
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

    console.log(`URL Guard: screenshot captured. Data URL length: ${screenshotDataUrl.length}. Sending to native host for save only.`);
    await logToPageConsole(tabId, `URL Guard: screenshot captured. Sending to native host for save only. Data URL length: ${screenshotDataUrl.length}.`);

    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      event: 'save_screenshot',
      savedAt,
      tabUrl,
      formId,
      reason,
      imageUrl: screenshotDataUrl,
      mimeType: 'image/png',
      skipOcr: true
    });

    const screenshotPath = extractSavedImagePath(response);
    const displayResponse = stringifyForDisplay(response);
    const didSave = response?.ok !== false && Boolean(screenshotPath);

    await chrome.storage.local.set({
      [LOCAL_STORAGE_KEYS.lastScreenshotPath]: screenshotPath,
      [LOCAL_STORAGE_KEYS.lastScreenshotSavedAt]: savedAt,
      [LOCAL_STORAGE_KEYS.lastScreenshotError]: response?.ok === false ? (response?.error || displayResponse) : '',
      [LOCAL_STORAGE_KEYS.lastDownloadedFilename]: screenshotPath || '',
      [LOCAL_STORAGE_KEYS.lastSavedAt]: savedAt,
      ...(didSave ? { [LOCAL_STORAGE_KEYS.lastMissingFormScreenshotKey]: screenshotKey } : {})
    });

    console.log('URL Guard: native host screenshot save response:', response);

    if (response?.ok === false) {
      const message = `URL Guard: screenshot save failed: ${response?.error || displayResponse}`;
      console.warn(message);
      await logToPageConsole(tabId, message);
      return;
    }

    if (!screenshotPath) {
      const message = 'URL Guard: screenshot save response did not include a savedImagePath. Check native host configuration.';
      console.warn(message, response);
      await logToPageConsole(tabId, message);
      return;
    }

    const successMessage = `URL Guard: screenshot saved automatically to: ${screenshotPath}`;
    console.log(successMessage);
    await logToPageConsole(tabId, successMessage);
  } catch (error) {
    const message = error?.message || 'Could not capture and save a screenshot after the form lookup failed.';
    await chrome.storage.local.set({
      [LOCAL_STORAGE_KEYS.lastScreenshotPath]: '',
      [LOCAL_STORAGE_KEYS.lastScreenshotSavedAt]: savedAt,
      [LOCAL_STORAGE_KEYS.lastScreenshotError]: message
    });
    console.warn('URL Guard: could not capture and save missing-form screenshot.', error);
    await logToPageConsole(tabId, `URL Guard: screenshot failed: ${message}`);
  }
}

async function logToPageConsole(tabId, message, data) {
  // Do not inject console logging into the live page. During navigation Chrome can remove
  // frame 0 between scheduling and injection, which produces the extension-page error:
  // "Frame with ID 0 was removed." Keep debug output in the extension service worker
  // console instead.
  if (data) {
    console.log(message, data);
  } else {
    console.log(message);
  }
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

        if (result.formMissing) {
          logMissingFormToConsole(configuredFormId, result.pageUrl);
        }

        resolve(result);
      }
    }, RETRY_DELAY_MS);
  });

  function logMissingFormToConsole(formId, pageUrl) {
    const message = `URL Guard: form id "${formId}" was not found on this page. Page: ${pageUrl}. Please check the Form ID saved in extension options.`;

    try {
      console.warn(message);
    } catch (error) {
      // Keep this fallback so an unexpected console issue does not break the extension.
      try {
        console.log(message, error);
      } catch (_) {}
    }

    try {
      window.alert(message);
    } catch (error) {
      // Some pages may block alert dialogs. In that case, the console warning above
      // still shows the missing saved Form ID message.
      try {
        console.warn('URL Guard: unable to show missing form alert.', error);
      } catch (_) {}
    }
  }

  function findTargetBackgroundImage(formId, selector) {
    const form = document.getElementById(formId);

    if (!form) {
      return {
        ok: false,
        reason: `No form found with id "${formId}".`,
        formMissing: true,
        formId,
        pageUrl: window.location.href
      };
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
    const savedImagePath = extractSavedImagePath(response);

    await chrome.storage.local.set({
      [LOCAL_STORAGE_KEYS.lastPythonResponse]: displayResponse,
      [LOCAL_STORAGE_KEYS.lastPythonError]: '',
      [LOCAL_STORAGE_KEYS.lastPythonProcessedAt]: processedAt,
      [LOCAL_STORAGE_KEYS.lastDownloadedFilename]: savedImagePath || downloadedFilename || ''
    });

    if (tabId) {
      await handleLivePageInputsOnTab(tabId);
    } else {
      await handleLivePageInputsOnActiveTab();
    }
  } catch (error) {
    await chrome.storage.local.set({
      [LOCAL_STORAGE_KEYS.lastPythonResponse]: '',
      [LOCAL_STORAGE_KEYS.lastPythonError]: error?.message || 'Python Native Messaging host failed.',
      [LOCAL_STORAGE_KEYS.lastPythonProcessedAt]: processedAt
    });
  }
}


function extractSavedImagePath(response) {
  if (response == null) return '';

  if (typeof response === 'string') {
    try {
      return extractSavedImagePath(JSON.parse(response));
    } catch {
      return '';
    }
  }

  if (typeof response !== 'object') return '';

  const pathKeys = ['savedImagePath', 'imagePath', 'filePath', 'path', 'downloadedFilename'];
  for (const key of pathKeys) {
    if (response[key] != null && String(response[key]).trim()) {
      return String(response[key]).trim();
    }
  }

  return '';
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
  if (!USE_CHROME_DOWNLOADS) return null;
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
