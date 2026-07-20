// @ts-check

import { STORES } from './constants.js';
import { readMetaValue, writeMetaValue } from './meta-repository.js';
import { runTransaction } from './transaction.js';

/**
 * Single META key that holds the bounded per-host throttle map. The map is
 * internal timing bookkeeping (not snapshot data), so it lives outside the
 * FeedRecord model and its writes never increment `dataRevision`.
 */
export const HOST_THROTTLE_META_KEY = 'hostThrottle';

/** Upper bound on tracked hosts; the oldest entries are evicted past this. */
export const HOST_THROTTLE_MAX_HOSTS = 200;

/** @type {HostWindow} */
const DEFAULT_WINDOW = Object.freeze({ nextAllowedAtMs: 0, lastStatus: 0 });

/**
 * @typedef {object} HostWindow
 * @property {number} nextAllowedAtMs
 * @property {number} lastStatus
 *
 * @typedef {HostWindow & {updatedAtMs: number}} HostEntry
 */

/**
 * Reads the live throttle window for a host key in its own readonly
 * transaction. Expired or unknown windows resolve to a zeroed default so the
 * caller never treats a lapsed budget as still open.
 *
 * @param {import('./transaction.js').TransactionOptions} options
 * @param {string} hostKey
 * @param {number} nowMs
 * @returns {Promise<HostWindow>}
 */
export async function readHostWindow(options, hostKey, nowMs) {
  if (!hostKey) return { ...DEFAULT_WINDOW };
  return runTransaction(
    STORES.META,
    'readonly',
    async (transaction) => {
      const map = normalizeMap(await readMetaValue(transaction, HOST_THROTTLE_META_KEY));
      const entry = map.get(hostKey);
      if (!entry || entry.nextAllowedAtMs <= nowMs) return { ...DEFAULT_WINDOW };
      return { nextAllowedAtMs: entry.nextAllowedAtMs, lastStatus: entry.lastStatus };
    },
    options,
  );
}

/**
 * Persists the throttle window for a host key in its own readwrite
 * transaction, stamping `updatedAtMs`, pruning expired entries and enforcing
 * the host cap. Does NOT increment `dataRevision` — throttle timing is not
 * snapshot data and must not trigger reader reloads.
 *
 * @param {import('./transaction.js').TransactionOptions} options
 * @param {string} hostKey
 * @param {HostWindow} hostWindow
 * @param {number} nowMs
 * @returns {Promise<void>}
 */
export async function writeHostWindow(options, hostKey, hostWindow, nowMs) {
  if (!hostKey) return;
  await runTransaction(
    STORES.META,
    'readwrite',
    async (transaction) => {
      const map = normalizeMap(await readMetaValue(transaction, HOST_THROTTLE_META_KEY));
      map.set(hostKey, {
        nextAllowedAtMs: toSafeMs(hostWindow?.nextAllowedAtMs),
        lastStatus: toSafeInt(hostWindow?.lastStatus),
        updatedAtMs: toSafeMs(nowMs),
      });
      await writeMetaValue(transaction, HOST_THROTTLE_META_KEY, serializeMap(pruneMap(map, hostKey, nowMs)));
    },
    options,
  );
}

/**
 * @param {Map<string, HostEntry>} map
 * @param {string} keepKey
 * @param {number} nowMs
 * @returns {Map<string, HostEntry>}
 */
function pruneMap(map, keepKey, nowMs) {
  /** @type {Map<string, HostEntry>} */
  const live = new Map();
  for (const [key, entry] of map) {
    if (key === keepKey || entry.nextAllowedAtMs > nowMs) live.set(key, entry);
  }
  if (live.size <= HOST_THROTTLE_MAX_HOSTS) return live;
  const oldestFirst = [...live.entries()]
    .filter(([key]) => key !== keepKey)
    .sort((a, b) => a[1].updatedAtMs - b[1].updatedAtMs);
  let excess = live.size - HOST_THROTTLE_MAX_HOSTS;
  for (const [key] of oldestFirst) {
    if (excess <= 0) break;
    live.delete(key);
    excess -= 1;
  }
  return live;
}

/**
 * @param {unknown} value
 * @returns {Map<string, HostEntry>}
 */
function normalizeMap(value) {
  /** @type {Map<string, HostEntry>} */
  const map = new Map();
  if (!value || typeof value !== 'object') return map;
  for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (!key || !entry || typeof entry !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (entry);
    map.set(key, {
      nextAllowedAtMs: toSafeMs(record.nextAllowedAtMs),
      lastStatus: toSafeInt(record.lastStatus),
      updatedAtMs: toSafeMs(record.updatedAtMs),
    });
  }
  return map;
}

/**
 * @param {Map<string, HostEntry>} map
 * @returns {Record<string, HostEntry>}
 */
function serializeMap(map) {
  /** @type {Record<string, HostEntry>} */
  const output = {};
  for (const [key, entry] of map) output[key] = entry;
  return output;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toSafeMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
