export const STORAGE_KEYS = Object.freeze({
  urlRule: 'urlRule',
  formId: 'formId',
  elementSelector: 'elementSelector'
});

export const DEFAULT_CONFIG = Object.freeze({
  urlRule: '',
  formId: '',
  elementSelector: ''
});

export const URL_RULE_HELP = [
  'Use an http(s) URL or wildcard pattern.',
  'Examples: https://example.com/*, https://*.example.com/orders/*, https://app.example.com/dashboard'
].join(' ');

export const SELECTOR_HELP = [
  'Enter the form id without #, then enter a tag or safe CSS selector inside that form.',
  'Examples: input, textarea, select[name="country"], button[type="submit"], div.summary'
].join(' ');

const DANGEROUS_URL_CHARS = /[<>"'`\n\r\t]/;
const CHROME_MATCH_PATTERN = /^(https?):\/\/([^/]+)(\/.*)?$/i;
const FORM_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_:\-.]{0,127}$/;
const BLOCKED_SELECTOR_CHARS = /[<>`{}]/;
const ALLOWED_TAG_PATTERN = /^[a-z][a-z0-9-]*$/i;
const MAX_SELECTOR_LENGTH = 180;

export async function getConfig() {
  const result = await chrome.storage.sync.get(DEFAULT_CONFIG);

  return {
    urlRule: normalizeText(result[STORAGE_KEYS.urlRule]),
    formId: normalizeText(result[STORAGE_KEYS.formId]),
    elementSelector: normalizeText(result[STORAGE_KEYS.elementSelector])
  };
}

export async function setConfig(nextConfig) {
  const config = {
    urlRule: normalizeText(nextConfig?.urlRule),
    formId: normalizeText(nextConfig?.formId),
    elementSelector: normalizeText(nextConfig?.elementSelector)
  };

  const validation = validateConfig(config);
  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  await chrome.storage.sync.set(config);
  return config;
}

export async function clearConfig() {
  await chrome.storage.sync.remove(Object.values(STORAGE_KEYS));
}

export function validateConfig(config) {
  const urlValidation = validateUrlRule(config?.urlRule);
  if (!urlValidation.ok) return urlValidation;

  const formValidation = validateFormId(config?.formId);
  if (!formValidation.ok) return formValidation;

  const selectorValidation = validateElementSelector(config?.elementSelector);
  if (!selectorValidation.ok) return selectorValidation;

  return { ok: true };
}

export function normalizeText(value) {
  return String(value ?? '').trim();
}

export function validateUrlRule(rule) {
  const normalizedRule = normalizeText(rule);

  if (!normalizedRule) {
    return { ok: false, reason: 'Enter a URL rule first.' };
  }

  if (normalizedRule.length > 2048) {
    return { ok: false, reason: 'URL rule is too long.' };
  }

  if (DANGEROUS_URL_CHARS.test(normalizedRule)) {
    return { ok: false, reason: 'URL rule contains unsafe characters.' };
  }

  const match = normalizedRule.match(CHROME_MATCH_PATTERN);
  if (!match) {
    return { ok: false, reason: 'Only http:// or https:// URL rules are allowed.' };
  }

  const [, scheme, host, path = '/'] = match;

  if (!['http', 'https'].includes(scheme.toLowerCase())) {
    return { ok: false, reason: 'Only http:// or https:// URL rules are allowed.' };
  }

  if (host.includes('@')) {
    return { ok: false, reason: 'Username/password URLs are not allowed.' };
  }

  if (host === '*' || host === '*:*' || normalizedRule === '*://*/*') {
    return { ok: false, reason: 'Overly broad URL rules are not allowed.' };
  }

  if (!isSafeHostPattern(host)) {
    return { ok: false, reason: 'Host must be a valid domain, localhost, IP address, or a leading wildcard like *.example.com.' };
  }

  if (!path.startsWith('/')) {
    return { ok: false, reason: 'Path must start with /.' };
  }

  return { ok: true };
}

export function validateFormId(formId) {
  const normalizedFormId = normalizeText(formId);

  if (!normalizedFormId) {
    return { ok: false, reason: 'Enter the form id first.' };
  }

  if (!FORM_ID_PATTERN.test(normalizedFormId)) {
    return { ok: false, reason: 'Form id may contain letters, numbers, underscore, dash, colon, and dot. Start with a letter.' };
  }

  return { ok: true };
}

export function validateElementSelector(selector) {
  const normalizedSelector = normalizeText(selector);

  if (!normalizedSelector) {
    return { ok: false, reason: 'Enter an HTML tag or selector inside the form.' };
  }

  if (normalizedSelector.length > MAX_SELECTOR_LENGTH) {
    return { ok: false, reason: 'Element selector is too long.' };
  }

  if (BLOCKED_SELECTOR_CHARS.test(normalizedSelector)) {
    return { ok: false, reason: 'Element selector contains unsafe characters.' };
  }

  try {
    document.createDocumentFragment().querySelector(normalizedSelector);
  } catch {
    return { ok: false, reason: 'Element selector is not valid CSS.' };
  }

  return { ok: true };
}

export function matchesConfiguredRule(candidateUrl, rule) {
  const normalizedRule = normalizeText(rule);
  const validation = validateUrlRule(normalizedRule);

  if (!validation.ok || !candidateUrl) {
    return false;
  }

  let url;
  try {
    url = new URL(candidateUrl);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return false;
  }

  const [, scheme, hostPattern, pathPattern = '/'] = normalizedRule.match(CHROME_MATCH_PATTERN);

  if (url.protocol.replace(':', '').toLowerCase() !== scheme.toLowerCase()) {
    return false;
  }

  return matchesHost(url.hostname, hostPattern) && matchesPath(url.pathname + url.search + url.hash, pathPattern);
}

export function toDisplaySelector(formId, elementSelector) {
  return `#${formId} ${elementSelector}`;
}

export function isPlainHtmlTag(selector) {
  return ALLOWED_TAG_PATTERN.test(normalizeText(selector));
}

function isSafeHostPattern(hostPattern) {
  const normalizedHost = hostPattern.toLowerCase();

  if (normalizedHost === 'localhost') {
    return true;
  }

  if (/^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/.test(normalizedHost)) {
    return normalizedHost
      .split(':')[0]
      .split('.')
      .every((octet) => Number(octet) >= 0 && Number(octet) <= 255);
  }

  const hostWithoutPort = normalizedHost.replace(/:\d{1,5}$/, '');
  const wildcardStripped = hostWithoutPort.startsWith('*.') ? hostWithoutPort.slice(2) : hostWithoutPort;

  if (wildcardStripped.includes('*')) {
    return false;
  }

  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(wildcardStripped);
}

function matchesHost(hostname, hostPattern) {
  const host = hostname.toLowerCase();
  const pattern = hostPattern.toLowerCase().replace(/:\d{1,5}$/, '');

  if (pattern.startsWith('*.')) {
    const root = pattern.slice(2);
    return host === root || host.endsWith(`.${root}`);
  }

  return host === pattern;
}

function matchesPath(candidatePath, pathPattern) {
  return wildcardToRegExp(pathPattern).test(candidatePath || '/');
}

function wildcardToRegExp(pattern) {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('.*');

  return new RegExp(`^${escaped}$`, 'i');
}
