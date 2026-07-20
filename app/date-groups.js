// @ts-check

const FALLBACK_TIME_ZONE = 'UTC';
const FORMATTER_CACHE_LIMIT = 16;
/** @type {Map<string, Intl.DateTimeFormat>} */
const formatterCache = new Map();
/** @type {WeakMap<Array<Record<string, unknown>>, Map<string, DateGroup[]>>} */
const groupCache = new WeakMap();

/**
 * @typedef {object} DateGroupOptions
 * @property {string} [locale]
 * @property {string} [timeZone]
 *
 * @typedef {object} DateGroup
 * @property {string} key
 * @property {string} label
 * @property {Array<Record<string, unknown>>} items
 */

/**
 * @param {Array<Record<string, unknown>>} articles
 * @param {DateGroupOptions} [options]
 * @returns {DateGroup[]}
 */
export function groupArticlesByDate(articles, options = {}) {
  const locale = options.locale ?? 'en';
  const timeZone = options.timeZone ?? resolvedTimeZone();
  const cacheKey = `${locale}:${timeZone}`;
  const cached = groupCache.get(articles)?.get(cacheKey);
  if (cached) return cached;
  const labels = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone });
  const groups = new Map();

  for (const article of articles) {
    const timestamp = timestampForArticle(article);
    const key = dateKey(timestamp, timeZone);
    if (!groups.has(key)) groups.set(key, { key, label: labels.format(new Date(timestamp)), items: [] });
    groups.get(key).items.push(article);
  }

  const result = [...groups.values()];
  const articleCache = groupCache.get(articles) ?? new Map();
  articleCache.set(cacheKey, result);
  groupCache.set(articles, articleCache);
  return result;
}

/**
 * @param {Record<string, unknown>} article
 * @returns {number}
 */
export function timestampForArticle(article) {
  for (const field of ['sortAtMs', 'publishedAtMs', 'sourceUpdatedAtMs', 'fetchedAtMs']) {
    const value = article[field];
    if (isValidEpochMs(value)) return value;
  }
  return 0;
}

/**
 * @param {number} timestamp
 * @param {string} locale
 * @param {string} timeZone
 */
export function formatArticleTime(timestamp, locale, timeZone = resolvedTimeZone()) {
  return cachedFormatter(`time:${locale}:${timeZone}`, locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(timestamp));
}

/** @param {number} timestamp @param {string} locale @param {string} timeZone */
export function formatArticleDateTime(timestamp, locale, timeZone = resolvedTimeZone()) {
  return cachedFormatter(`date-time:${locale}:${timeZone}`, locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(timestamp));
}

/**
 * @param {number} timestamp
 * @param {string} timeZone
 */
function dateKey(timestamp, timeZone) {
  const parts = cachedFormatter(`date-key:${timeZone}`, 'en', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(new Date(timestamp));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

/**
 * @param {string} key
 * @param {string} locale
 * @param {Intl.DateTimeFormatOptions} options
 */
function cachedFormatter(key, locale, options) {
  const existing = formatterCache.get(key);
  if (existing) return existing;
  if (formatterCache.size >= FORMATTER_CACHE_LIMIT) {
    const firstKey = formatterCache.keys().next().value;
    if (typeof firstKey === 'string') formatterCache.delete(firstKey);
  }
  const formatter = new Intl.DateTimeFormat(locale, options);
  formatterCache.set(key, formatter);
  return formatter;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isValidEpochMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0;
}

function resolvedTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE;
}
