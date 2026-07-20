// @ts-check

/**
 * @typedef {object} SafeError
 * @property {string} code
 * @property {string} messageKey
 * @property {boolean} retryable
 * @property {Record<string, unknown> | null} details
 */

/**
 * @typedef {object} AppErrorOptions
 * @property {string} [messageKey]
 * @property {boolean} [retryable]
 * @property {Record<string, unknown> | null} [details]
 * @property {string} [message]
 */

const SAFE_DETAIL_KEYS = new Set([
  'field',
  'reason',
  'code',
  'operation',
  'feedId',
  'articleId',
  'categoryId',
  'oldVersion',
  'newVersion',
]);
/** @type {Readonly<Record<string, string>>} */
const SPECIAL_MESSAGE_KEYS = Object.freeze({
  INTERNAL_ERROR: 'errorInternal',
});
/** @type {Readonly<Record<string, string>>} */
const SPECIAL_CANONICAL_KEYS = Object.freeze({
  INTERNAL_ERROR: 'error.internal',
});

export const ERROR_CODES = Object.freeze({
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNSUPPORTED_URL_SCHEME: 'UNSUPPORTED_URL_SCHEME',
  HOST_PERMISSION_DENIED: 'HOST_PERMISSION_DENIED',
  HOST_PERMISSION_REVOKED: 'HOST_PERMISSION_REVOKED',
  FEED_ALREADY_EXISTS: 'FEED_ALREADY_EXISTS',
  FEED_NOT_FOUND: 'FEED_NOT_FOUND',
  CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',
  ARTICLE_NOT_FOUND: 'ARTICLE_NOT_FOUND',
  FETCH_TIMEOUT: 'FETCH_TIMEOUT',
  FETCH_RESPONSE_TOO_LARGE: 'FETCH_RESPONSE_TOO_LARGE',
  HTTP_ERROR: 'HTTP_ERROR',
  AUTH_OR_ACCESS_DENIED: 'AUTH_OR_ACCESS_DENIED',
  FEED_PARSE_ERROR: 'FEED_PARSE_ERROR',
  UNSUPPORTED_FEED_FORMAT: 'UNSUPPORTED_FEED_FORMAT',
  OPML_PARSE_ERROR: 'OPML_PARSE_ERROR',
  OPML_TOO_LARGE: 'OPML_TOO_LARGE',
  DB_OPEN_FAILED: 'DB_OPEN_FAILED',
  DB_SCHEMA_MISMATCH: 'DB_SCHEMA_MISMATCH',
  DB_VERSION_ERROR: 'DB_VERSION_ERROR',
  DB_TRANSACTION_ABORTED: 'DB_TRANSACTION_ABORTED',
  DB_TRANSACTION_INACTIVE: 'DB_TRANSACTION_INACTIVE',
  DB_CONSTRAINT: 'DB_CONSTRAINT',
  DB_QUOTA_EXCEEDED: 'DB_QUOTA_EXCEEDED',
  DB_INVALID_STATE: 'DB_INVALID_STATE',
  DB_UNKNOWN: 'DB_UNKNOWN',
  DEDUPE_COLLISION: 'DEDUPE_COLLISION',
  DEDUPE_AMBIGUOUS: 'DEDUPE_AMBIGUOUS',
  REDIRECT_PERMISSION_REQUIRED: 'REDIRECT_PERMISSION_REQUIRED',
  DB_UPGRADE_BLOCKED: 'DB_UPGRADE_BLOCKED',
  INVALID_CURSOR: 'INVALID_CURSOR',
  CURSOR_STALE: 'CURSOR_STALE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
});

/** @type {readonly string[]} */
export const ERROR_CODE_VALUES = Object.freeze(Object.values(ERROR_CODES));

/** @type {Readonly<Record<string, string>>} */
export const ERROR_MESSAGE_KEYS = Object.freeze(
  Object.fromEntries(ERROR_CODE_VALUES.map((code) => [code, errorCodeToMessageKey(code)])),
);

/** @type {Readonly<Record<string, string>>} */
export const ERROR_CANONICAL_KEYS = Object.freeze(
  Object.fromEntries(ERROR_CODE_VALUES.map((code) => [code, errorCodeToCanonicalKey(code)])),
);

/** @type {Readonly<Record<string, string>>} */
const DOM_EXCEPTION_CODES = Object.freeze({
  QuotaExceededError: ERROR_CODES.DB_QUOTA_EXCEEDED,
  ConstraintError: ERROR_CODES.DB_CONSTRAINT,
  TransactionInactiveError: ERROR_CODES.DB_TRANSACTION_INACTIVE,
  AbortError: ERROR_CODES.DB_TRANSACTION_ABORTED,
  VersionError: ERROR_CODES.DB_VERSION_ERROR,
  InvalidStateError: ERROR_CODES.DB_INVALID_STATE,
  NotFoundError: ERROR_CODES.DB_SCHEMA_MISMATCH,
});

export class AppError extends Error {
  /**
   * @param {string} code
   * @param {AppErrorOptions} [options]
   */
  constructor(code, options = {}) {
    super(options.message ? `${code}: ${options.message}` : code);
    this.name = 'AppError';
    this.code = code;
    this.messageKey = options.messageKey ?? errorCodeToMessageKey(code);
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? null;
  }
}

/**
 * @param {string} code
 * @param {string | AppErrorOptions} [messageKeyOrOptions]
 * @param {AppErrorOptions} [options]
 * @returns {AppError}
 */
export function createAppError(code, messageKeyOrOptions = {}, options = {}) {
  if (typeof messageKeyOrOptions === 'string') {
    return new AppError(code, { ...options, messageKey: messageKeyOrOptions });
  }
  return new AppError(code, messageKeyOrOptions);
}

/**
 * @param {string} code
 * @returns {string}
 */
export function errorCodeToMessageKey(code) {
  if (Object.hasOwn(SPECIAL_MESSAGE_KEYS, code)) {
    return SPECIAL_MESSAGE_KEYS[code];
  }
  const words = code.toLowerCase().split('_');
  return `error${words.map(capitalize).join('')}`;
}

/**
 * @param {string} code
 * @returns {string}
 */
export function errorCodeToCanonicalKey(code) {
  if (Object.hasOwn(SPECIAL_CANONICAL_KEYS, code)) {
    return SPECIAL_CANONICAL_KEYS[code];
  }
  return `error.${code.toLowerCase().replaceAll('_', '')}`;
}

/**
 * @param {DOMException} error
 * @returns {AppError}
 */
export function mapDomException(error) {
  const code = DOM_EXCEPTION_CODES[error.name] ?? ERROR_CODES.DB_UNKNOWN;
  return createAppError(code, { details: { code: error.name } });
}

/**
 * @param {unknown} error
 * @returns {SafeError}
 */
export function toSafeError(error) {
  const appError = error instanceof AppError ? error : error instanceof DOMException ? mapDomException(error) : null;
  if (appError) {
    return {
      code: appError.code,
      messageKey: appError.messageKey,
      retryable: appError.retryable,
      details: sanitizeDetails(appError.details),
    };
  }
  return {
    code: ERROR_CODES.INTERNAL_ERROR,
    messageKey: ERROR_MESSAGE_KEYS[ERROR_CODES.INTERNAL_ERROR],
    retryable: false,
    details: null,
  };
}

/**
 * @param {Record<string, unknown> | null} details
 * @returns {Record<string, unknown> | null}
 */
function sanitizeDetails(details) {
  if (!details) return null;
  /** @type {Record<string, unknown>} */
  const safe = {};
  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

/**
 * @param {string} value
 * @returns {string}
 */
function capitalize(value) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
