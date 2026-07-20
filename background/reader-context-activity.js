// @ts-check

import { AppError, ERROR_CODES, createAppError } from '../domain/errors.js';

export const READER_CONTEXT_ACTIVITY_KEY = 'readerContextActivity.v1';
export const READER_CONTEXT_ACTIVITY_KEY_PREFIX = 'readerContextActivity.v2.';
const ACTIVITY_RECORD_KEYS = new Set(['contexts', 'version']);
const ACTIVITY_CONTEXT_KEYS = new Set(['lastActiveAtMs', 'tabId', 'windowId']);
const MAX_CONTEXTS = 16;
const MIN_WRITE_INTERVAL_MS = 1000;

/**
 * @typedef {object} StorageArea
 * @property {(keys: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} [remove]
 *
 * @typedef {object} ReaderContextActivityEntry
 * @property {number} lastActiveAtMs
 * @property {number} tabId
 * @property {number} windowId
 *
 * @typedef {object} ReaderContextActivityRecord
 * @property {1} version
 * @property {ReaderContextActivityEntry[]} contexts
 */

/**
 * @param {StorageArea | undefined} storageArea
 * @returns {Promise<ReaderContextActivityRecord>}
 */
export async function readReaderContextActivity(storageArea) {
  if (!storageArea) return emptyRecord();
  const stored = await storageArea.get(null);
  const contexts = [];
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(READER_CONTEXT_ACTIVITY_KEY_PREFIX)) continue;
    const context = maybeActivityContext(value);
    if (context) contexts.push(context);
  }
  const legacy = stored[READER_CONTEXT_ACTIVITY_KEY];
  const legacyRecord = maybeReaderContextActivityRecord(legacy);
  if (legacyRecord) contexts.push(...legacyRecord.contexts);
  return compactActivityRecord({ version: 1, contexts });
}

/**
 * @param {StorageArea | undefined} storageArea
 * @param {ReaderContextActivityRecord} record
 */
export async function writeReaderContextActivity(storageArea, record) {
  if (!storageArea) return;
  const next = compactActivityRecord(validateReaderContextActivity(record));
  const nextItems = Object.fromEntries(next.contexts.map((context) => [activeContextStorageKey(context), context]));
  const stored = await storageArea.get(null);
  const stale = Object.keys(stored).filter(
    (key) =>
      key === READER_CONTEXT_ACTIVITY_KEY ||
      (key.startsWith(READER_CONTEXT_ACTIVITY_KEY_PREFIX) && !(key in nextItems)),
  );
  if (stale.length > 0) await storageArea.remove?.(stale);
  await storageArea.set(nextItems);
}

/**
 * @param {StorageArea | undefined} storageArea
 * @param {{tabId: number, windowId: number}} context
 * @param {number} now
 * @param {Map<string, number>} throttleCache
 */
export async function recordReaderContextActivity(storageArea, context, now, throttleCache) {
  const key = contextKey(context);
  const previousWriteAtMs = throttleCache.get(key) ?? Number.NEGATIVE_INFINITY;
  if (now - previousWriteAtMs < MIN_WRITE_INTERVAL_MS) return { recorded: false, throttled: true };
  const entry = validateActivityContext({ ...context, lastActiveAtMs: now });
  const nextKey = activeContextStorageKey(entry);
  if (storageArea) {
    const stored = await storageArea.get(null);
    const keptKeys = new Set(boundedActiveContextStorageEntries(stored, nextKey, entry).map((item) => item.key));
    const stale = Object.keys(stored).filter(
      (storedKey) =>
        storedKey === READER_CONTEXT_ACTIVITY_KEY ||
        (storedKey.startsWith(READER_CONTEXT_ACTIVITY_KEY_PREFIX) && !keptKeys.has(storedKey)),
    );
    if (stale.length > 0) await storageArea.remove?.(stale);
    if (keptKeys.has(nextKey)) {
      await storageArea.set({ [nextKey]: entry });
      await pruneActiveContextStorageKeys(storageArea);
    }
  }
  throttleCache.set(key, Math.max(throttleCache.get(key) ?? Number.NEGATIVE_INFINITY, now));
  return { recorded: true, throttled: false };
}

/**
 * @param {ReaderContextActivityRecord} record
 * @param {Array<{tabId?: number, windowId?: number}>} contexts
 * @returns {{changed: boolean, record: ReaderContextActivityRecord}}
 */
export function pruneReaderContextActivity(record, contexts) {
  const liveKeys = new Set(contexts.map(contextKey).filter((key) => key !== ''));
  const kept = record.contexts.filter((context) => liveKeys.has(contextKey(context)));
  return { changed: kept.length !== record.contexts.length, record: { version: 1, contexts: kept } };
}

/**
 * @param {unknown} value
 * @returns {ReaderContextActivityRecord}
 */
function validateReaderContextActivity(value) {
  const record = requireRecord(value, 'readerContextActivity');
  requireOnlyKeys(record, ACTIVITY_RECORD_KEYS, 'readerContextActivity');
  if (record.version !== 1) throw validationError('readerContextActivity.version');
  return compactActivityRecord({
    version: 1,
    contexts: requireArray(record.contexts, 'readerContextActivity.contexts').map(validateActivityContext),
  });
}

/**
 * @param {unknown} value
 * @returns {ReaderContextActivityEntry}
 */
function validateActivityContext(value) {
  const record = requireRecord(value, 'readerContextActivity.context');
  requireOnlyKeys(record, ACTIVITY_CONTEXT_KEYS, 'readerContextActivity.context');
  return {
    lastActiveAtMs: requireNonNegativeInteger(record.lastActiveAtMs, 'lastActiveAtMs'),
    tabId: requireNonNegativeInteger(record.tabId, 'tabId'),
    windowId: requireNonNegativeInteger(record.windowId, 'windowId'),
  };
}

/**
 * @param {ReaderContextActivityRecord} record
 * @param {ReaderContextActivityEntry} entry
 * @returns {ReaderContextActivityRecord}
 */
/**
 * @param {ReaderContextActivityEntry} left
 * @param {ReaderContextActivityEntry} right
 */
function compareActivityEntry(left, right) {
  if (left.lastActiveAtMs !== right.lastActiveAtMs) return right.lastActiveAtMs - left.lastActiveAtMs;
  return compareContextIdentity(left, right);
}

/**
 * @param {{tabId?: number, windowId?: number}} value
 */
function contextKey(value) {
  return isNonNegativeInteger(value.tabId) && isNonNegativeInteger(value.windowId)
    ? `${value.windowId}:${value.tabId}`
    : '';
}

/**
 * @param {{tabId?: number, windowId?: number}} left
 * @param {{tabId?: number, windowId?: number}} right
 */
export function compareContextIdentity(left, right) {
  const windowDelta = numberValue(left.windowId) - numberValue(right.windowId);
  return windowDelta === 0 ? numberValue(left.tabId) - numberValue(right.tabId) : windowDelta;
}

function emptyRecord() {
  return /** @type {ReaderContextActivityRecord} */ ({ version: 1, contexts: [] });
}

/**
 * @param {unknown} value
 * @returns {ReaderContextActivityEntry | null}
 */
function maybeActivityContext(value) {
  try {
    return validateActivityContext(value);
  } catch (error) {
    if (!isReaderContextActivityValidationError(error)) throw error;
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {ReaderContextActivityRecord | null}
 */
function maybeReaderContextActivityRecord(value) {
  if (value === undefined) return null;
  try {
    return validateReaderContextActivity(value);
  } catch (error) {
    if (!isReaderContextActivityValidationError(error)) throw error;
    return null;
  }
}

/**
 * @param {unknown} error
 */
function isReaderContextActivityValidationError(error) {
  return error instanceof AppError && error.code === ERROR_CODES.VALIDATION_ERROR;
}

/**
 * @param {ReaderContextActivityRecord} record
 * @returns {ReaderContextActivityRecord}
 */
function compactActivityRecord(record) {
  const byContext = new Map();
  for (const context of record.contexts) {
    const key = contextKey(context);
    const existing = byContext.get(key);
    if (!existing || compareActivityEntry(context, existing) < 0) byContext.set(key, context);
  }
  return { version: 1, contexts: [...byContext.values()].sort(compareActivityEntry).slice(0, MAX_CONTEXTS) };
}

/**
 * @param {Record<string, unknown>} stored
 * @param {string} nextKey
 * @param {ReaderContextActivityEntry} entry
 * @returns {Array<{key: string, context: ReaderContextActivityEntry}>}
 */
function boundedActiveContextStorageEntries(stored, nextKey, entry) {
  const byContext = new Map();
  rememberActiveContextEntry(byContext, { key: nextKey, context: entry });
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(READER_CONTEXT_ACTIVITY_KEY_PREFIX) || key === nextKey) continue;
    const context = maybeActivityContext(value);
    if (context) rememberActiveContextEntry(byContext, { key, context });
  }
  return [...byContext.values()]
    .sort((left, right) => compareActivityEntry(left.context, right.context))
    .slice(0, MAX_CONTEXTS);
}

/**
 * @param {StorageArea} storageArea
 */
async function pruneActiveContextStorageKeys(storageArea) {
  const stored = await storageArea.get(null);
  const keptKeys = new Set(boundedStoredActiveContextEntries(stored).map((item) => item.key));
  const stale = Object.keys(stored).filter(
    (storedKey) => storedKey.startsWith(READER_CONTEXT_ACTIVITY_KEY_PREFIX) && !keptKeys.has(storedKey),
  );
  if (stale.length > 0) await storageArea.remove?.(stale);
}

/**
 * @param {Record<string, unknown>} stored
 * @returns {Array<{key: string, context: ReaderContextActivityEntry}>}
 */
function boundedStoredActiveContextEntries(stored) {
  const byContext = new Map();
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(READER_CONTEXT_ACTIVITY_KEY_PREFIX)) continue;
    const context = maybeActivityContext(value);
    if (context) rememberActiveContextEntry(byContext, { key, context });
  }
  return [...byContext.values()]
    .sort((left, right) => compareActivityEntry(left.context, right.context))
    .slice(0, MAX_CONTEXTS);
}

/**
 * @param {Map<string, {key: string, context: ReaderContextActivityEntry}>} byContext
 * @param {{key: string, context: ReaderContextActivityEntry}} candidate
 */
function rememberActiveContextEntry(byContext, candidate) {
  const key = contextKey(candidate.context);
  const existing = byContext.get(key);
  if (!existing || compareActivityEntry(candidate.context, existing.context) < 0) byContext.set(key, candidate);
}

/**
 * @param {ReaderContextActivityEntry} context
 */
function activeContextStorageKey(context) {
  return `${READER_CONTEXT_ACTIVITY_KEY_PREFIX}${context.windowId}.${context.tabId}.${context.lastActiveAtMs}`;
}

/**
 * @param {ReaderContextActivityEntry} context
 */
function activeContextStoragePrefix(context) {
  return `${READER_CONTEXT_ACTIVITY_KEY_PREFIX}${context.windowId}.${context.tabId}.`;
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
  throw validationError(label);
}

/**
 * @param {Record<string, unknown>} record
 * @param {ReadonlySet<string>} allowed
 * @param {string} label
 */
function requireOnlyKeys(record, allowed, label) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw validationError(`${label}.${key}`);
  }
  for (const key of allowed) {
    if (!(key in record)) throw validationError(`${label}.${key}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function requireArray(value, field) {
  if (Array.isArray(value)) return value;
  throw validationError(field);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function requireNonNegativeInteger(value, field) {
  if (isNonNegativeInteger(value)) return value;
  throw validationError(field);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function numberValue(value) {
  return isNonNegativeInteger(value) ? value : 0;
}

/**
 * @param {string} field
 */
function validationError(field) {
  return createAppError(ERROR_CODES.VALIDATION_ERROR, {
    details: { field, reason: 'invalid reader context activity record' },
  });
}
