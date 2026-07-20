// @ts-check

import { AppError, createAppError, ERROR_CODES } from './errors.js';

/**
 * @param {string} value
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function normalizeHttpUrl(value, baseUrl = '') {
  let url;
  try {
    url = baseUrl ? new URL(value.trim(), baseUrl) : new URL(value.trim());
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw urlError('url', 'invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw createAppError(ERROR_CODES.UNSUPPORTED_URL_SCHEME, {
      details: { field: 'url', reason: 'only http and https URLs are supported' },
      message: 'url: unsupported URL scheme',
    });
  }
  url.hash = '';
  return url.href;
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeFeedUrl(value) {
  return normalizeHttpUrl(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeArticleUrl(value) {
  return normalizeHttpUrl(value);
}

/**
 * @param {unknown} value
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function tryNormalizeHttpUrl(value, baseUrl = '') {
  if (typeof value !== 'string' || value.trim() === '') return '';
  try {
    return normalizeHttpUrl(value, baseUrl);
  } catch (error) {
    if (!isExpectedUrlParseError(error)) throw error;
    return '';
  }
}

/**
 * @param {string} value
 * @param {string} [baseUrl]
 * @returns {string} the normalized absolute https URL, or '' if not a valid https URL
 */
export function httpsOnlyUrl(value, baseUrl = '') {
  const normalized = tryNormalizeHttpUrl(value, baseUrl);
  if (!normalized) return '';
  return new URL(normalized).protocol === 'https:' ? normalized : '';
}

/**
 * @param {string} value
 * @returns {string}
 */
export function originPatternForUrl(value) {
  const url = new URL(normalizeHttpUrl(value));
  return `${url.origin}/*`;
}

/**
 * Second-level labels that combine with a two-letter ccTLD to form a public
 * suffix (e.g. `co.uk`, `gov.au`). LOCKED decision #4 keeps this a small
 * hand-maintained set rather than shipping the full Public Suffix List.
 */
const SLD_LABELS = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu']);

/**
 * Derives the eTLD+1 (registrable domain) of a hostname for per-host
 * throttling. This is a zero-dependency heuristic, NOT the full Public Suffix
 * List: it takes the last two labels, and three labels when the second-to-last
 * label is one of {co,com,net,org,gov,ac,edu} under a two-letter ccTLD
 * (e.g. `news.bbc.co.uk` → `bbc.co.uk`). Pass the punycode hostname (as
 * produced by the `URL` parser) so IDN hosts key on their ASCII form.
 *
 * @param {string} hostname
 * @returns {string}
 */
export function eTldPlusOne(hostname) {
  const host = String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/u, '');
  if (!host) return '';
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return host;
  const last = labels[labels.length - 1];
  const secondLast = labels[labels.length - 2];
  const count = labels.length >= 3 && SLD_LABELS.has(secondLast) && /^[a-z]{2}$/u.test(last) ? 3 : 2;
  return labels.slice(-count).join('.');
}

/**
 * Maps a feed/site URL to its eTLD+1 host key for per-host throttling.
 * Uses the `URL` parser's punycode hostname so IDN hosts share a stable
 * ASCII key. Invalid or non-http(s) input yields an empty string.
 *
 * @param {string} value
 * @returns {string}
 */
export function hostKey(value) {
  const normalized = tryNormalizeHttpUrl(value);
  if (!normalized) return '';
  return eTldPlusOne(new URL(normalized).hostname);
}

/**
 * @param {string} field
 * @param {string} reason
 * @returns {import('./errors.js').AppError}
 */
function urlError(field, reason) {
  return createAppError(ERROR_CODES.VALIDATION_ERROR, {
    details: { field, reason },
    message: `${field}: ${reason}`,
  });
}

/**
 * @param {unknown} error
 */
function isExpectedUrlParseError(error) {
  return (
    error instanceof AppError &&
    (error.code === ERROR_CODES.VALIDATION_ERROR || error.code === ERROR_CODES.UNSUPPORTED_URL_SCHEME)
  );
}
