// @ts-check

import { parseFeedDateMs } from '../domain/dates.js';
import { createAppError, ERROR_CODES, toSafeError } from '../domain/errors.js';
import { normalizeFeedText } from '../domain/text.js';
import { tryNormalizeHttpUrl } from '../domain/urls.js';

export const MAX_FEED_BYTES = 5 * 1024 * 1024;
export const MAX_FEED_DEPTH = 64;
export const MAX_FEED_ENTRY_COUNT = 5000;
export const MAX_NORMALIZED_ENTRIES = 500;
export const TEXT_LIMITS = Object.freeze({
  author: 512,
  body: 32768,
  description: 4096,
  id: 2048,
  title: 2048,
});

/**
 * @typedef {object} ParserContext
 * @property {string} responseUrl
 * @property {number} [nowMs]
 *
 * @typedef {object} ParserNeutralFeed
 * @property {string} title
 * @property {string} siteUrl
 * @property {string} description
 * @property {string} language
 * @property {number} updatedAtMs
 * @property {string} iconUrl
 * @property {string} logoUrl
 *
 * @typedef {object} ParserNeutralEntry
 * @property {string} guid
 * @property {string} canonicalUrl
 * @property {string} title
 * @property {string} author
 * @property {number} publishedAtMs
 * @property {number} sourceUpdatedAtMs
 * @property {string} summaryText
 * @property {string} contentText
 * @property {import('../domain/article-content-blocks.js').Block[]} contentBlocks
 * @property {string} imageUrl
 *
 * @typedef {object} ParserNeutralResult
 * @property {'rss' | 'atom'} format
 * @property {ParserNeutralFeed} feed
 * @property {ParserNeutralEntry[]} entries
 *
 * @typedef {{ok: true, data: ParserNeutralResult} | {ok: false, error: import('../domain/errors.js').SafeError}} ParserResult
 */

/**
 * @param {ParserNeutralResult} data
 * @returns {{ok: true, data: ParserNeutralResult}}
 */
export function parserSuccess(data) {
  return { ok: true, data };
}

/**
 * @param {string} code
 * @param {{retryable?: boolean, reason?: string}} [options]
 * @returns {{ok: false, error: import('../domain/errors.js').SafeError}}
 */
export function parserFailure(code, options = {}) {
  return {
    ok: false,
    error: toSafeError(
      createAppError(code, {
        details: options.reason ? { reason: options.reason } : null,
        retryable: options.retryable ?? false,
      }),
    ),
  };
}

/**
 * @param {string} xmlText
 * @returns {{ok: false, error: import('../domain/errors.js').SafeError} | null}
 */
export function xmlTextBoundaryFailure(xmlText) {
  if (new TextEncoder().encode(xmlText).byteLength > MAX_FEED_BYTES) {
    return parserFailure(ERROR_CODES.FETCH_RESPONSE_TOO_LARGE, { reason: 'feed XML exceeds byte limit' });
  }
  if (xmlText.includes('\u0000')) {
    return parserFailure(ERROR_CODES.FEED_PARSE_ERROR, { reason: 'feed XML contains NUL' });
  }
  if (/<!DOCTYPE\b/iu.test(xmlText)) {
    return parserFailure(ERROR_CODES.FEED_PARSE_ERROR, { reason: 'DOCTYPE is not supported' });
  }
  return null;
}

/**
 * @param {unknown} value
 * @param {number} maxCodePoints
 * @returns {string}
 */
export function fieldText(value, maxCodePoints) {
  return normalizeFeedText(value, { maxCodePoints });
}

/**
 * Raw HTML slice for rich-content sanitization. It is bounded by code points
 * without collapsing whitespace, so pre/code layout survives parsing.
 * @param {unknown} value
 * @param {number} maxCodePoints
 * @returns {string}
 */
export function rawHtmlText(value, maxCodePoints) {
  if (typeof value !== 'string' || !value) return '';
  const cleaned = value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
  const window = cleaned.length > maxCodePoints * 2 ? cleaned.slice(0, maxCodePoints * 2) : cleaned;
  const points = [...window];
  return points.length > maxCodePoints ? points.slice(0, maxCodePoints).join('') : window;
}

/**
 * @param {unknown} value
 * @param {string} baseUrl
 * @returns {string}
 */
export function fieldUrl(value, baseUrl) {
  return tryNormalizeHttpUrl(value, baseUrl);
}

/**
 * @param {unknown} value
 * @param {number | undefined} nowMs
 * @returns {number}
 */
export function fieldDate(value, nowMs) {
  return parseFeedDateMs(value, nowMs ?? Date.now());
}

/**
 * @returns {import('./feed-parser-utils.js').ParserNeutralFeed}
 */
export function emptyFeed() {
  return {
    description: '',
    iconUrl: '',
    language: '',
    logoUrl: '',
    siteUrl: '',
    title: '',
    updatedAtMs: 0,
  };
}

/**
 * @returns {import('./feed-parser-utils.js').ParserNeutralEntry}
 */
export function emptyEntry() {
  return {
    author: '',
    canonicalUrl: '',
    contentBlocks: [],
    contentText: '',
    guid: '',
    imageUrl: '',
    publishedAtMs: 0,
    sourceUpdatedAtMs: 0,
    summaryText: '',
    title: '',
  };
}
