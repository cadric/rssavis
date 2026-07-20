// @ts-check

import { ERROR_CODES, createAppError } from '../domain/errors.js';
import { sha256Hex } from '../domain/ids.js';

const CURSOR_VERSION = 1;
const MAX_CURSOR_BYTES = 2048;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const INDEX_NAMES = new Set(['bySort', 'byReadSort', 'byStarSort', 'byFeedSort', 'byFeedReadSort', 'byFeedStarSort']);
const STRATEGIES = new Set(['empty', 'globalIndex', 'singleFeed', 'multiFeedMerge', 'globalFilter']);

/**
 * @typedef {object} CursorPayload
 * @property {1} v
 * @property {string} queryHash
 * @property {number} dataRevision
 * @property {string} index
 * @property {'prev'} direction
 * @property {unknown[] | null} [lastKey]
 * @property {Record<string, unknown[]>} [feedCursors]
 * @property {'empty' | 'globalIndex' | 'singleFeed' | 'multiFeedMerge' | 'globalFilter'} strategy
 */

/**
 * @param {CursorPayload} payload
 */
export function encodeCursor(payload) {
  const normalized = normalizeCursorPayload(payload);
  const json = JSON.stringify(normalized);
  if (new TextEncoder().encode(json).byteLength > MAX_CURSOR_BYTES) throw cursorError('cursor too large');
  const token = encodeBase64Url(json);
  if (token.length > MAX_CURSOR_BYTES) throw cursorError('cursor too large');
  return token;
}

/**
 * @param {unknown} token
 * @param {{queryHash: string, dataRevision: number}} expected
 * @returns {CursorPayload}
 */
export function decodeCursor(token, expected) {
  if (token === null || token === undefined || token === '') throw cursorError('cursor missing');
  if (typeof token !== 'string' || !CURSOR_PATTERN.test(token) || token.length > MAX_CURSOR_BYTES) {
    throw cursorError('invalid cursor token');
  }
  const json = decodeBase64Url(token);
  if (new TextEncoder().encode(json).byteLength > MAX_CURSOR_BYTES) throw cursorError('cursor too large');
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw cursorError('cursor payload must be JSON');
  }
  const payload = normalizeCursorPayload(parsed);
  if (payload.queryHash !== expected.queryHash) throw cursorError('cursor query mismatch');
  if (payload.dataRevision !== expected.dataRevision) {
    throw createAppError(ERROR_CODES.CURSOR_STALE, { details: { reason: 'data revision changed' } });
  }
  return payload;
}

/**
 * @param {unknown} descriptor
 */
export async function queryHashFor(descriptor) {
  return sha256Hex(stableJson(descriptor));
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 */
export function normalizePageSize(value, fallback = 50, max = 100) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
      details: { field: 'pageSize', reason: `must be an integer from 1 to ${max}` },
    });
  }
  return value;
}

/**
 * @param {unknown} input
 * @returns {CursorPayload}
 */
function normalizeCursorPayload(input) {
  if (!isRecord(input)) throw cursorError('cursor payload must be an object');
  if (input.v !== CURSOR_VERSION) throw cursorError('unsupported cursor version');
  if (typeof input.queryHash !== 'string' || !HASH_PATTERN.test(input.queryHash))
    throw cursorError('invalid query hash');
  if (typeof input.dataRevision !== 'number' || !Number.isSafeInteger(input.dataRevision) || input.dataRevision < 0) {
    throw cursorError('invalid data revision');
  }
  if (typeof input.index !== 'string' || !INDEX_NAMES.has(input.index)) throw cursorError('invalid index');
  if (input.direction !== 'prev') throw cursorError('invalid direction');
  if (typeof input.strategy !== 'string' || !STRATEGIES.has(input.strategy)) throw cursorError('invalid strategy');
  const lastKey = 'lastKey' in input && input.lastKey !== null ? normalizeKey(input.lastKey) : null;
  const feedCursors = normalizeFeedCursors(input.feedCursors);
  return {
    v: CURSOR_VERSION,
    queryHash: input.queryHash,
    dataRevision: input.dataRevision,
    index: input.index,
    direction: 'prev',
    ...(lastKey ? { lastKey } : {}),
    ...(feedCursors ? { feedCursors } : {}),
    strategy: /** @type {CursorPayload['strategy']} */ (input.strategy),
  };
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function normalizeKey(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) throw cursorError('invalid cursor key');
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0) return part;
    throw cursorError('invalid cursor key part');
  });
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown[]> | null}
 */
function normalizeFeedCursors(value) {
  if (value === undefined) return null;
  if (!isRecord(value)) throw cursorError('invalid feed cursors');
  /** @type {Record<string, unknown[]>} */
  const cursors = {};
  for (const [feedId, key] of Object.entries(value)) cursors[feedId] = normalizeKey(key);
  return cursors;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        /**
         * @param {string} key
         */
        (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * @param {string} value
 */
function encodeBase64Url(value) {
  if ('btoa' in globalThis) {
    return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  }
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * @param {string} value
 */
function decodeBase64Url(value) {
  try {
    if ('atob' in globalThis) {
      const padded = value
        .padEnd(Math.ceil(value.length / 4) * 4, '=')
        .replaceAll('-', '+')
        .replaceAll('_', '/');
      return atob(padded);
    }
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch (error) {
    if (!isExpectedBase64UrlDecodeError(error)) throw error;
    throw cursorError('cursor is not base64url');
  }
}

/**
 * @param {unknown} error
 */
function isExpectedBase64UrlDecodeError(error) {
  return (
    error instanceof DOMException ||
    error instanceof TypeError ||
    (error instanceof Error && error.name === 'InvalidCharacterError')
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * @param {string} reason
 */
function cursorError(reason) {
  return createAppError(ERROR_CODES.INVALID_CURSOR, { details: { reason } });
}
