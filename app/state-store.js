// @ts-check

import { AppError, createAppError, ERROR_CODES } from '../domain/errors.js';
import { normalizeScope, scopeToStorageKey } from '../domain/scopes.js';
import { isArticleFilter } from './article-filter.js';

export const UI_STATE_STORAGE_KEY = 'uiState.v1';
export const MAX_SCROLL_SCOPES = 50;

const SETTINGS_STORAGE_KEY = 'settings.v1';

export const DEFAULT_UI_STATE = Object.freeze({
  version: 1,
  mode: 'reader',
  activeScope: Object.freeze({ type: 'system', id: 'unread' }),
  articleFilter: 'all',
  articleView: 'normal',
  readerSidebarOpen: true,
  settingsSidebarOpen: true,
  sidebarWidthPx: 278,
  activeSettingsSection: 'general',
  expandedArticleId: '',
  categoryCollapsed: Object.freeze({}),
  scrollByScope: Object.freeze({}),
});

const UI_STATE_FIELDS = new Set(Object.keys(DEFAULT_UI_STATE));
const MODES = new Set(['reader', 'settings', 'help']);
const ARTICLE_VIEWS = new Set(['compact', 'normal', 'large']);
const SETTINGS_SECTIONS = new Set(['general', 'appearance', 'reading', 'feeds', 'categories', 'storage', 'import']);

/**
 * @typedef {object} UiStateRecord
 * @property {1} version
 * @property {'reader' | 'settings' | 'help'} mode
 * @property {import('../domain/scopes.js').Scope} activeScope
 * @property {import('./article-filter.js').ArticleFilter} articleFilter
 * @property {'compact' | 'normal' | 'large'} articleView
 * @property {boolean} readerSidebarOpen
 * @property {boolean} settingsSidebarOpen
 * @property {number} sidebarWidthPx
 * @property {'general' | 'appearance' | 'reading' | 'feeds' | 'categories' | 'storage' | 'import'} activeSettingsSection
 * @property {string} expandedArticleId
 * @property {Record<string, boolean>} categoryCollapsed
 * @property {Record<string, {scrollTop: number, anchorArticleId: string, updatedAtMs: number}>} scrollByScope
 *
 * @typedef {object} StorageArea
 * @property {(keys: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} [remove]
 */

/**
 * @param {StorageArea} [storageArea]
 */
export function createUiStateStore(storageArea = getStorageArea()) {
  let mutationQueue = Promise.resolve();

  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  function enqueueMutation(operation) {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    async read() {
      return readUiState(storageArea);
    },
    /**
     * @param {Partial<UiStateRecord>} patch
     * @param {{applyIf?: () => boolean}} [options]
     */
    async write(patch, options = {}) {
      return enqueueMutation(async () => {
        const current = await readUiState(storageArea);
        const next = validateUiStateRecord({ ...current, ...validateUiStatePatch(patch) });
        if (options.applyIf && !options.applyIf()) return current;
        await storageArea.set({ [UI_STATE_STORAGE_KEY]: next });
        if (options.applyIf && !options.applyIf()) {
          await storageArea.set({ [UI_STATE_STORAGE_KEY]: current });
          return current;
        }
        return next;
      });
    },
    /**
     * @param {import('../domain/scopes.js').Scope} scope
     * @param {{scrollTop: number, anchorArticleId?: string}} entry
     */
    async rememberScroll(scope, entry) {
      return enqueueMutation(async () => {
        const current = await readUiState(storageArea);
        const key = scopeToStorageKey(scope);
        const updatedAtMs = nextScrollUpdate(current.scrollByScope);
        const scrollByScope = trimScrollByScope({
          ...current.scrollByScope,
          [key]: {
            anchorArticleId: entry.anchorArticleId ?? '',
            scrollTop: entry.scrollTop,
            updatedAtMs,
          },
        });
        const next = validateUiStateRecord({ ...current, scrollByScope });
        await storageArea.set({ [UI_STATE_STORAGE_KEY]: next });
        return next;
      });
    },
  };
}

/**
 * @param {StorageArea} storageArea
 * @returns {Promise<UiStateRecord>}
 */
export async function readUiState(storageArea) {
  const values = await storageArea.get([UI_STATE_STORAGE_KEY, SETTINGS_STORAGE_KEY]);
  const stored = values[UI_STATE_STORAGE_KEY];
  try {
    return validateUiStateRecord(stored);
  } catch (error) {
    if (!isExpectedStoredUiStateError(error)) throw error;
    const fallback = cloneDefaultUiState(defaultArticleView(values[SETTINGS_STORAGE_KEY]));
    await storageArea.set({ [UI_STATE_STORAGE_KEY]: fallback });
    return fallback;
  }
}

/**
 * @param {unknown} error
 */
function isExpectedStoredUiStateError(error) {
  return error instanceof AppError && error.code === ERROR_CODES.VALIDATION_ERROR;
}

/**
 * @param {unknown} input
 * @returns {UiStateRecord}
 */
export function validateUiStateRecord(input) {
  const record = validateUiStateObject(input);
  return /** @type {UiStateRecord} */ ({
    version: record.version,
    mode: validateMode(record.mode),
    activeScope: normalizeScope(record.activeScope),
    articleFilter: validateArticleFilter(record.articleFilter),
    articleView: validateEnum('articleView', record.articleView, ARTICLE_VIEWS),
    readerSidebarOpen: validateBoolean('readerSidebarOpen', record.readerSidebarOpen),
    settingsSidebarOpen: validateBoolean('settingsSidebarOpen', record.settingsSidebarOpen),
    sidebarWidthPx: validateBoundedInteger('sidebarWidthPx', record.sidebarWidthPx, 200, 1200),
    activeSettingsSection: validateEnum('activeSettingsSection', record.activeSettingsSection, SETTINGS_SECTIONS),
    expandedArticleId: validateString('expandedArticleId', record.expandedArticleId),
    categoryCollapsed: validateBooleanMap('categoryCollapsed', record.categoryCollapsed),
    scrollByScope: trimScrollByScope(validateScrollMap(record.scrollByScope)),
  });
}

/**
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
function validateUiStatePatch(input) {
  const record = requireRecord(input, 'uiState');
  for (const key of Object.keys(record)) {
    if (!UI_STATE_FIELDS.has(key)) throw validationError(key, `unknown field: ${key}`);
  }
  if ('version' in record && record.version !== 1) throw validationError('version', 'must be 1');
  return { ...record };
}

/**
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
function validateUiStateObject(input) {
  const record = requireRecord(input, 'uiState');
  for (const key of Object.keys(record)) {
    if (!UI_STATE_FIELDS.has(key)) throw validationError(key, `unknown field: ${key}`);
  }
  if ('version' in record && record.version !== 1) throw validationError('version', 'must be 1');
  return { ...cloneDefaultUiState(), ...record };
}

/**
 * @param {'compact' | 'normal' | 'large'} [articleView]
 * @returns {UiStateRecord}
 */
function cloneDefaultUiState(articleView = DEFAULT_UI_STATE.articleView) {
  return /** @type {UiStateRecord} */ ({ ...structuredClone(DEFAULT_UI_STATE), articleView });
}

/**
 * @param {unknown} settings
 * @returns {'compact' | 'normal' | 'large'}
 */
function defaultArticleView(settings) {
  return isPlainRecord(settings) &&
    typeof settings.defaultArticleView === 'string' &&
    ARTICLE_VIEWS.has(settings.defaultArticleView)
    ? /** @type {'compact' | 'normal' | 'large'} */ (settings.defaultArticleView)
    : DEFAULT_UI_STATE.articleView;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * @param {string} field
 * @param {unknown} value
 * @param {ReadonlySet<string>} allowed
 * @returns {string}
 */
function validateEnum(field, value, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) throw validationError(field, 'invalid enum value');
  return value;
}

/**
 * @param {unknown} value
 * @returns {'reader' | 'settings' | 'help'}
 */
function validateMode(value) {
  if (value === 'about' || value === 'shortcuts') return DEFAULT_UI_STATE.mode;
  return /** @type {'reader' | 'settings' | 'help'} */ (validateEnum('mode', value, MODES));
}

/**
 * @param {unknown} value
 * @returns {import('./article-filter.js').ArticleFilter}
 */
function validateArticleFilter(value) {
  if (!isArticleFilter(value)) throw validationError('articleFilter', 'invalid enum value');
  return value;
}

/**
 * @param {string} field
 * @param {unknown} value
 * @returns {boolean}
 */
function validateBoolean(field, value) {
  if (typeof value !== 'boolean') throw validationError(field, 'must be boolean');
  return value;
}

/**
 * @param {string} field
 * @param {unknown} value
 * @returns {string}
 */
function validateString(field, value) {
  if (typeof value !== 'string') throw validationError(field, 'must be string');
  return value;
}

/**
 * @param {keyof typeof DEFAULT_UI_STATE} field
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function validateBoundedInteger(field, value, min, max) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  return /** @type {number} */ (DEFAULT_UI_STATE[field]);
}

/**
 * @param {string} field
 * @param {unknown} value
 * @returns {Record<string, boolean>}
 */
function validateBooleanMap(field, value) {
  const record = requireRecord(value, field);
  /** @type {Record<string, boolean>} */
  const output = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'boolean') throw validationError(field, `invalid boolean map entry: ${key}`);
    output[key] = item;
  }
  return output;
}

/**
 * @param {unknown} value
 * @returns {Record<string, {scrollTop: number, anchorArticleId: string, updatedAtMs: number}>}
 */
function validateScrollMap(value) {
  const record = requireRecord(value, 'scrollByScope');
  /** @type {Record<string, {scrollTop: number, anchorArticleId: string, updatedAtMs: number}>} */
  const output = {};
  for (const [key, item] of Object.entries(record)) {
    const entry = requireRecord(item, `scrollByScope.${key}`);
    const scrollTop = entry.scrollTop ?? entry.top;
    const anchorArticleId = entry.anchorArticleId ?? '';
    const updatedAtMs = entry.updatedAtMs ?? entry.touchedAt;
    if (typeof scrollTop !== 'number' || !Number.isSafeInteger(scrollTop) || scrollTop < 0) {
      throw validationError('scrollByScope', 'invalid scrollTop');
    }
    if (typeof anchorArticleId !== 'string') {
      throw validationError('scrollByScope', 'invalid anchorArticleId');
    }
    if (typeof updatedAtMs !== 'number' || !Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
      throw validationError('scrollByScope', 'invalid updatedAtMs');
    }
    output[key] = { anchorArticleId, scrollTop, updatedAtMs };
  }
  return output;
}

/**
 * @param {Record<string, {scrollTop: number, anchorArticleId: string, updatedAtMs: number}>} scrollByScope
 * @returns {Record<string, {scrollTop: number, anchorArticleId: string, updatedAtMs: number}>}
 */
function trimScrollByScope(scrollByScope) {
  return Object.fromEntries(
    Object.entries(scrollByScope)
      .sort((left, right) => right[1].updatedAtMs - left[1].updatedAtMs)
      .slice(0, MAX_SCROLL_SCOPES)
      .sort((left, right) => left[1].updatedAtMs - right[1].updatedAtMs),
  );
}

/**
 * @param {Record<string, {scrollTop: number, anchorArticleId: string, updatedAtMs: number}>} scrollByScope
 * @returns {number}
 */
function nextScrollUpdate(scrollByScope) {
  const current = Object.values(scrollByScope).map((entry) => entry.updatedAtMs);
  return (current.length > 0 ? Math.max(...current) : 0) + 1;
}

/**
 * @returns {StorageArea}
 */
function getStorageArea() {
  return /** @type {{browser: {storage: {local: StorageArea}}}} */ (/** @type {unknown} */ (globalThis)).browser.storage
    .local;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function requireRecord(value, label) {
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  throw validationError(label, 'must be a plain object');
}

/**
 * @param {string} field
 * @param {string} reason
 * @returns {import('../domain/errors.js').AppError}
 */
function validationError(field, reason) {
  return createAppError(ERROR_CODES.VALIDATION_ERROR, {
    details: { field, reason },
    message: `${field}: ${reason}`,
  });
}
