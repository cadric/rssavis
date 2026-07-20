// @ts-check

const SETTINGS_STORAGE_KEY = 'settings.v1';

export const DEFAULT_READER_SETTINGS = Object.freeze({
  articlesPerPage: 100,
  imageLoading: 'on-expand',
  lazyLoadImages: true,
  markReadOnExpand: true,
  markReadOnOpen: true,
  markReadOnScroll: false,
  openLinksMode: 'background-tab',
});

const IMAGE_LOADING_VALUES = new Set(['on-expand', 'always', 'never']);
const OPEN_MODE_VALUES = new Set(['background-tab', 'foreground-tab', 'current-tab']);

/**
 * @typedef {object} StorageArea
 * @property {(keys: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>} get
 *
 * @typedef {object} ReaderSettings
 * @property {number} articlesPerPage
 * @property {'on-expand' | 'always' | 'never'} imageLoading
 * @property {boolean} lazyLoadImages
 * @property {boolean} markReadOnExpand
 * @property {boolean} markReadOnOpen
 * @property {boolean} markReadOnScroll
 * @property {'background-tab' | 'foreground-tab' | 'current-tab'} openLinksMode
 */

/**
 * @param {StorageArea} storageArea
 * @returns {Promise<ReaderSettings>}
 */
export async function readReaderSettings(storageArea) {
  const stored = (await storageArea.get(SETTINGS_STORAGE_KEY))[SETTINGS_STORAGE_KEY];
  return normalizeReaderSettings(stored);
}

/**
 * @param {unknown} input
 * @returns {ReaderSettings}
 */
export function normalizeReaderSettings(input) {
  const record = isRecord(input) ? input : {};
  return {
    articlesPerPage: integerRangeValue(record.articlesPerPage, 20, 250, DEFAULT_READER_SETTINGS.articlesPerPage),
    imageLoading: imageLoadingValue(record.imageLoading),
    lazyLoadImages: booleanValue(record.lazyLoadImages, DEFAULT_READER_SETTINGS.lazyLoadImages),
    markReadOnExpand: booleanValue(record.markReadOnExpand, DEFAULT_READER_SETTINGS.markReadOnExpand),
    markReadOnOpen: booleanValue(record.markReadOnOpen, DEFAULT_READER_SETTINGS.markReadOnOpen),
    markReadOnScroll: booleanValue(record.markReadOnScroll, DEFAULT_READER_SETTINGS.markReadOnScroll),
    openLinksMode: openModeValue(record.openLinksMode),
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * @param {unknown} value
 * @returns {ReaderSettings['imageLoading']}
 */
function imageLoadingValue(value) {
  if (typeof value === 'string' && IMAGE_LOADING_VALUES.has(value)) {
    return /** @type {ReaderSettings['imageLoading']} */ (value);
  }
  return DEFAULT_READER_SETTINGS.imageLoading;
}

/**
 * @param {unknown} value
 * @returns {ReaderSettings['openLinksMode']}
 */
function openModeValue(value) {
  if (typeof value === 'string' && OPEN_MODE_VALUES.has(value)) {
    return /** @type {ReaderSettings['openLinksMode']} */ (value);
  }
  return DEFAULT_READER_SETTINGS.openLinksMode;
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 */
function booleanValue(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function integerRangeValue(value, min, max, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
