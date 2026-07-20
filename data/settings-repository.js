// @ts-check

import { AppError, ERROR_CODES } from '../domain/errors.js';
import { requireRecord, validationError } from './validators.js';

export const SETTINGS_STORAGE_KEY = 'settings.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  language: 'auto',
  colorScheme: 'system',
  accentColor: 'blue',
  defaultArticleView: 'normal',
  articlesPerPage: 100,
  refreshIntervalMinutes: 30,
  feedTimeoutSeconds: 30,
  imageLoading: 'on-expand',
  lazyLoadImages: true,
  openLinksMode: 'background-tab',
  markReadOnExpand: true,
  markReadOnOpen: true,
  markReadOnScroll: false,
  purgeMaxArticles: 10000,
  purgeMaxAgeDays: 90,
  keepUnreadOnPurge: true,
  keepStarredOnPurge: true,
});

const SETTINGS_FIELDS = new Set(Object.keys(DEFAULT_SETTINGS));
const ENUMS = Object.freeze({
  language: new Set(['auto', 'en', 'da']),
  colorScheme: new Set(['system', 'light', 'dark']),
  accentColor: new Set(['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'slate']),
  defaultArticleView: new Set(['compact', 'normal', 'large']),
  imageLoading: new Set(['on-expand', 'always', 'never']),
  openLinksMode: new Set(['background-tab', 'foreground-tab', 'current-tab']),
});
const NUMERIC_LIMITS = Object.freeze({
  articlesPerPage: [20, 250],
  refreshIntervalMinutes: [15, 1440],
  feedTimeoutSeconds: [5, 120],
  purgeMaxArticles: [1000, 100000],
  purgeMaxAgeDays: [7, 3650],
});
const BOOLEAN_FIELDS = new Set([
  'lazyLoadImages',
  'markReadOnExpand',
  'markReadOnOpen',
  'markReadOnScroll',
  'keepUnreadOnPurge',
  'keepStarredOnPurge',
]);

/**
 * @typedef {object} SettingsRecord
 * @property {1} version
 * @property {'auto' | 'en' | 'da'} language
 * @property {'system' | 'light' | 'dark'} colorScheme
 * @property {'blue' | 'teal' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple' | 'slate'} accentColor
 * @property {'compact' | 'normal' | 'large'} defaultArticleView
 * @property {number} articlesPerPage
 * @property {number} refreshIntervalMinutes
 * @property {number} feedTimeoutSeconds
 * @property {'on-expand' | 'always' | 'never'} imageLoading
 * @property {boolean} lazyLoadImages
 * @property {'background-tab' | 'foreground-tab' | 'current-tab'} openLinksMode
 * @property {boolean} markReadOnExpand
 * @property {boolean} markReadOnOpen
 * @property {boolean} markReadOnScroll
 * @property {number} purgeMaxArticles
 * @property {number} purgeMaxAgeDays
 * @property {boolean} keepUnreadOnPurge
 * @property {boolean} keepStarredOnPurge
 */

/**
 * @typedef {object} StorageArea
 * @property {(keys: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} [remove]
 */

/**
 * @param {StorageArea} storageArea
 */
export function createSettingsRepository(storageArea) {
  return {
    async read() {
      return readSettings(storageArea);
    },
    /**
     * @param {Record<string, unknown>} patch
     */
    async write(patch) {
      const current = await readSettings(storageArea);
      const next = validateSettingsRecord({ ...current, ...validateSettingsPatch(patch) });
      await storageArea.set({ [SETTINGS_STORAGE_KEY]: next });
      return next;
    },
  };
}

/**
 * @param {StorageArea} storageArea
 * @returns {Promise<SettingsRecord>}
 */
export async function readSettings(storageArea) {
  const stored = (await storageArea.get(SETTINGS_STORAGE_KEY))[SETTINGS_STORAGE_KEY];
  try {
    return validateSettingsRecord(stored);
  } catch (error) {
    if (!isExpectedStoredSettingsError(error)) throw error;
    const fallback = { ...DEFAULT_SETTINGS };
    await storageArea.set({ [SETTINGS_STORAGE_KEY]: fallback });
    return fallback;
  }
}

/**
 * @param {unknown} error
 */
function isExpectedStoredSettingsError(error) {
  return error instanceof AppError && error.code === ERROR_CODES.VALIDATION_ERROR;
}

/**
 * @param {unknown} input
 * @returns {SettingsRecord}
 */
export function validateSettingsRecord(input) {
  const record = validateSettingsObject(input);
  for (const key of SETTINGS_FIELDS) validateSettingsField(key, record[key]);
  return /** @type {SettingsRecord} */ ({ ...record });
}

/**
 * @param {unknown} input
 * @returns {Partial<SettingsRecord>}
 */
function validateSettingsPatch(input) {
  const record = validateSettingsObject(input);
  for (const [key, value] of Object.entries(record)) validateSettingsField(key, value);
  return /** @type {Partial<SettingsRecord>} */ (record);
}

/**
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
function validateSettingsObject(input) {
  const record = requireRecord(input, 'settings');
  for (const key of Object.keys(record)) {
    if (!SETTINGS_FIELDS.has(key)) throw validationError(key, `unknown field: ${key}`);
  }
  return record;
}

/**
 * @param {string} key
 * @param {unknown} value
 */
function validateSettingsField(key, value) {
  if (key === 'version' && value !== 1) throw validationError(key, 'must be 1');
  if (Object.hasOwn(ENUMS, key) && (typeof value !== 'string' || !enumFor(key).has(value))) {
    throw validationError(key, 'invalid enum value');
  }
  if (Object.hasOwn(NUMERIC_LIMITS, key)) validateNumberLimit(key, value);
  if (BOOLEAN_FIELDS.has(key) && typeof value !== 'boolean') throw validationError(key, 'must be boolean');
}

/**
 * @param {string} key
 * @param {unknown} value
 */
function validateNumberLimit(key, value) {
  const [min, max] = numericLimitFor(key);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw validationError(key, `must be between ${min} and ${max}`);
  }
}

/**
 * @param {string} key
 * @returns {Set<string>}
 */
function enumFor(key) {
  return /** @type {Record<string, Set<string>>} */ (ENUMS)[key];
}

/**
 * @param {string} key
 * @returns {readonly number[]}
 */
function numericLimitFor(key) {
  return /** @type {Record<string, readonly number[]>} */ (NUMERIC_LIMITS)[key];
}
