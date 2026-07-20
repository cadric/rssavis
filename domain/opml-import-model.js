// @ts-check

import { createAppError, ERROR_CODES } from './errors.js';
import { normalizePlainText } from './text.js';
import { normalizeFeedUrl, originPatternForUrl, tryNormalizeHttpUrl } from './urls.js';

export const MAX_OPML_IMPORT_FEEDS = 5000;

/**
 * @typedef {object} OpmlImportFeed
 * @property {string} categoryTitle
 * @property {string} htmlUrl
 * @property {string} normalizedUrl
 * @property {string} originPattern
 * @property {number} sourceOrder
 * @property {string} title
 * @property {'rss' | 'atom' | null} type
 * @property {string} xmlUrl
 *
 * @typedef {object} OpmlImportModel
 * @property {1} version
 * @property {readonly string[]} originPatterns
 * @property {readonly OpmlImportFeed[]} feeds
 */

/**
 * @param {unknown} input
 * @returns {OpmlImportModel}
 */
export function normalizeOpmlImportModel(input) {
  if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.feeds)) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field: 'importModel' } });
  }
  if (input.feeds.length > MAX_OPML_IMPORT_FEEDS) {
    throw createAppError(ERROR_CODES.OPML_TOO_LARGE, { details: { reason: 'too many OPML feeds' } });
  }
  const feeds = input.feeds.map(normalizeOpmlImportFeed);
  return freezeImportModel({
    feeds,
    originPatterns: [...new Set(feeds.map((feed) => feed.originPattern))],
    version: 1,
  });
}

/**
 * @param {unknown} input
 * @param {number} index
 * @returns {OpmlImportFeed}
 */
function normalizeOpmlImportFeed(input, index) {
  if (!isRecord(input)) throw createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field: 'feed' } });
  const normalizedUrl = normalizeFeedUrl(stringField(input, 'normalizedUrl') || stringField(input, 'xmlUrl'));
  const title = normalizePlainText(stringField(input, 'title') || normalizedUrl, { maxCodePoints: 2048 });
  const categoryTitle = stringField(input, 'categoryTitle')
    ? normalizePlainText(stringField(input, 'categoryTitle'), { maxCodePoints: 200 })
    : '';
  const htmlUrl = tryNormalizeHttpUrl(stringField(input, 'htmlUrl'));
  return Object.freeze({
    categoryTitle,
    htmlUrl,
    normalizedUrl,
    originPattern: originPatternForUrl(normalizedUrl),
    sourceOrder: safeSourceOrder(input.sourceOrder, index),
    title,
    type: opmlFeedType(input.type),
    xmlUrl: normalizedUrl,
  });
}

/**
 * @param {OpmlImportModel} model
 */
function freezeImportModel(model) {
  return Object.freeze({
    feeds: Object.freeze([...model.feeds]),
    originPatterns: Object.freeze([...model.originPatterns]),
    version: 1,
  });
}

/**
 * @param {Record<string, unknown>} input
 * @param {string} field
 */
function stringField(input, field) {
  const value = input[field];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function safeSourceOrder(value, fallback) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

/**
 * @param {unknown} value
 * @returns {'rss' | 'atom' | null}
 */
function opmlFeedType(value) {
  if (typeof value !== 'string') return null;
  const type = value.trim().toLowerCase();
  if (type === 'rss' || type === 'atom') return type;
  return null;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
