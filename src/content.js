(function () {
  const DEFAULT_CONFIG = {
    urlRule: '',
    urlRules: [],
    formId: '',
    elementSelector: ''
  };

  function matchesConfiguredRule(candidateUrl, ruleOrRules) {
    const rule = Array.isArray(ruleOrRules) ? normalizeUrlRules(ruleOrRules)[0] : String(ruleOrRules || '').trim();

    if (!candidateUrl || !rule || !/^https?:\/\//i.test(rule)) {
      return false;
    }

    try {
      const current = new URL(candidateUrl);
      const configured = new URL(rule);
      const configuredPath = configured.pathname || '/';

      if (current.protocol.toLowerCase() !== configured.protocol.toLowerCase()) return false;
      if (current.hostname.toLowerCase() !== configured.hostname.toLowerCase()) return false;

      const escapedPath = configuredPath
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replaceAll('*', '.*');

      return new RegExp(`^${escapedPath}$`, 'i').test(current.pathname || '/');
    } catch {
      return false;
    }
  }

  function normalizeUrlRules(value) {
    const values = Array.isArray(value) ? value : [value];
    return values
      .map((item) => String(item || '').trim())
      .filter(Boolean);
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
    const config = await chrome.storage.sync.get(DEFAULT_CONFIG);
    const urlRules = normalizeUrlRules(config.urlRules);
    const urlRule = String(config.urlRule || '').trim() || urlRules[0] || '';
    return {
      ...config,
      urlRule,
      urlRules: urlRule ? [urlRule] : []
    };
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
