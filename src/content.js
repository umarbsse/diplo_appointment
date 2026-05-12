(function () {
  const DEFAULT_CONFIG = {
    urlRule: '',
    formId: '',
    elementSelector: ''
  };

  function matchesConfiguredRule(candidateUrl, rule) {
    const url = String(candidateUrl || '');
    const pattern = String(rule || '').trim();

    if (!url || !pattern) {
      return false;
    }

    if (!/^https?:\/\//i.test(url) || !/^https?:\/\//i.test(pattern)) {
      return false;
    }

    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replaceAll('*', '.*');

    return new RegExp(`^${escaped}$`, 'i').test(url);
  }

  function extractBackgroundUrl(styleValue) {
    if (!styleValue) {
      return '';
    }

    const match = String(styleValue).match(/url\((['"]?)(.*?)\1\)/i);
    return match ? match[2].trim() : '';
  }

  function resolveImageUrl(rawUrl) {
    if (!rawUrl) {
      return '';
    }

    if (/^data:image\//i.test(rawUrl)) {
      return rawUrl;
    }

    return new URL(rawUrl, window.location.href).href;
  }

  function extractConfiguredElement(config) {
    const form = document.getElementById(config.formId);

    if (!form) {
      throw new Error(`Form not found: #${config.formId}`);
    }

    const target = form.querySelector(config.elementSelector);

    if (!target) {
      throw new Error(`Target element not found inside #${config.formId}: ${config.elementSelector}`);
    }

    const inlineStyle = target.getAttribute('style') || '';
    const computedBackground = window.getComputedStyle(target).backgroundImage || '';
    const rawImageUrl = extractBackgroundUrl(inlineStyle) || extractBackgroundUrl(computedBackground);
    const imageUrl = resolveImageUrl(rawImageUrl);

    return {
      ok: true,
      pageUrl: window.location.href,
      formId: config.formId,
      elementSelector: config.elementSelector,
      elementHtml: target.outerHTML,
      inlineStyle,
      imageUrl
    };
  }

  async function getConfig() {
    return chrome.storage.sync.get(DEFAULT_CONFIG);
  }

  async function runAutoProcessing() {
    const config = await getConfig();
    const currentPageUrl = window.location.href;

    if (!matchesConfiguredRule(currentPageUrl, config.urlRule)) {
      return;
    }

    try {
      const payload = extractConfiguredElement(config);

      if (!payload.imageUrl) {
        throw new Error('No background image URL found in configured element.');
      }

      chrome.runtime.sendMessage({
        type: 'PROCESS_EXTRACTED_IMAGE',
        trigger: 'page-load',
        payload
      }, () => {
        // Ignore missing receiver errors; the background service worker may not need this message.
        void chrome.runtime.lastError;
      });
    } catch (error) {
      chrome.storage.local.set({
        lastStatusMessage: error.message,
        lastPageUrl: currentPageUrl,
        lastProcessedAt: new Date().toISOString()
      });
    }
  }

  if (document.readyState === 'complete') {
    window.setTimeout(runAutoProcessing, 250);
  } else {
    window.addEventListener('load', () => window.setTimeout(runAutoProcessing, 250), { once: true });
  }
})();
