// @ts-check

import { createAppError, ERROR_CODES } from './errors.js';

export const SEARCH_TEXT_VERSION = 2;

/**
 * @typedef {object} TextOptions
 * @property {number} maxCodePoints
 */

/**
 * @param {unknown} value
 * @param {TextOptions} options
 * @returns {string}
 */
export function normalizePlainText(value, options) {
  if (typeof value !== 'string') throw textError('text', 'must be a string');
  const normalized = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if ([...normalized].length > options.maxCodePoints) throw textError('text', 'exceeds code point limit');
  return normalized;
}

/**
 * @param {unknown} value
 * @param {Partial<TextOptions>} [options]
 * @returns {string}
 */
export function normalizeFeedText(value, options = {}) {
  if (typeof value !== 'string') return '';
  const maxCodePoints = options.maxCodePoints ?? 2048;
  const normalized = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const codePoints = [...normalized];
  return codePoints.length > maxCodePoints ? codePoints.slice(0, maxCodePoints).join('').trim() : normalized;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSearchText(value) {
  return String(value).normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * @param {{title: string, author?: string, summaryText?: string}} input
 * @returns {string}
 */
export function buildSearchText(input) {
  const parts = [
    normalizePlainText(input.title, { maxCodePoints: 2048 }),
    normalizePlainText(input.author ?? '', { maxCodePoints: 512 }),
    normalizePlainText(input.summaryText ?? '', { maxCodePoints: 32768 }),
  ].filter(Boolean);
  const value = normalizeSearchText(parts.join(' '));
  return value;
}

/**
 * @param {string} field
 * @param {string} reason
 * @returns {import('./errors.js').AppError}
 */
function textError(field, reason) {
  return createAppError(ERROR_CODES.VALIDATION_ERROR, {
    details: { field, reason },
    message: `${field}: ${reason}`,
  });
}
