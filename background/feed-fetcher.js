// @ts-check

import { AppError, createAppError, ERROR_CODES, ERROR_CODE_VALUES, toSafeError } from '../domain/errors.js';
import { normalizeFeedUrl, originPatternForUrl } from '../domain/urls.js';
import { MAX_FEED_BYTES } from './feed-parser-utils.js';

export { MAX_FEED_BYTES };

export const FEED_ACCEPT_HEADER =
  'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 120_000;

/**
 * @typedef {object} FetchFeedInput
 * @property {string} url
 * @property {string} [etag]
 * @property {string} [lastModified]
 * @property {string} [subscriptionOrigin]
 * @property {number} [timeoutMs]
 *
 * @typedef {object} FeedResponseLike
 * @property {{getReader: () => unknown} | null} body
 * @property {Headers} headers
 * @property {boolean} ok
 * @property {number} status
 * @property {string} url
 *
 * @typedef {object} FetchDependencies
 * @property {(input: string, init: RequestInit) => Promise<FeedResponseLike>} [fetchImpl]
 * @property {{resolveRedirectTarget?: (subscriptionOrigin: string, finalUrl: string) => Promise<{finalOrigin: string, redirectOriginPending?: string, status?: string}>}} [permissionController]
 *
 * @typedef {object} FetchFailureResult
 * @property {'failure'} status
 * @property {import('../domain/errors.js').SafeError} error
 * @property {number} httpStatus
 * @property {number} retryAfterMs
 * @property {number} [rateLimitRemaining]
 * @property {number} [rateLimitResetMs]
 *
 * @typedef {object} FetchRedirectPermissionRequiredResult
 * @property {'redirect-permission-required'} status
 * @property {import('../domain/errors.js').SafeError} error
 * @property {string} finalOrigin
 * @property {string} finalUrl
 * @property {number} httpStatus
 * @property {number} retryAfterMs
 *
 * @typedef {object} FetchFetchedResult
 * @property {'fetched'} status
 * @property {Uint8Array} bytes
 * @property {string} contentType
 * @property {string} etag
 * @property {string} finalOrigin
 * @property {string} finalUrl
 * @property {number} httpStatus
 * @property {string} lastModified
 * @property {number} [rateLimitRemaining]
 * @property {number} [rateLimitResetMs]
 *
 * @typedef {object} FetchNotModifiedResult
 * @property {'not-modified'} status
 * @property {string} finalOrigin
 * @property {string} finalUrl
 * @property {number} httpStatus
 * @property {number} retryAfterMs
 *
 * @typedef {FetchFailureResult | FetchFetchedResult | FetchNotModifiedResult | FetchRedirectPermissionRequiredResult} FetchResult
 */

/**
 * @param {FetchFeedInput} input
 * @param {FetchDependencies} [dependencies]
 * @returns {Promise<FetchResult>}
 */
export async function fetchFeed(input, dependencies = {}) {
  let requestUrl;
  try {
    requestUrl = normalizeFeedUrl(input.url);
  } catch (error) {
    if (!isExpectedUrlValidationError(error)) throw error;
    return fetchFailureFromError(error);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, normalizeTimeoutMs(input.timeoutMs));

  try {
    const response = await (dependencies.fetchImpl ?? fetch)(requestUrl, {
      cache: 'no-store',
      credentials: 'omit',
      headers: buildHeaders(input),
      method: 'GET',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    return await handleResponse(response, input, requestUrl, controller, dependencies);
  } catch (error) {
    if (timedOut || isAbortError(error)) {
      return fetchFailure(ERROR_CODES.FETCH_TIMEOUT, { retryable: true });
    }
    return fetchFailureFromError(error);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * @param {FeedResponseLike} response
 * @param {FetchFeedInput} input
 * @param {string} requestUrl
 * @param {AbortController} controller
 * @param {FetchDependencies} dependencies
 * @returns {Promise<FetchResult>}
 */
async function handleResponse(response, input, requestUrl, controller, dependencies) {
  const finalUrl = normalizeFeedUrl(response.url || requestUrl);
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
  const rateLimit = parseRateLimit(response.headers, Date.now());
  const redirect = await resolveFinalOrigin(finalUrl, input, dependencies);
  if (redirect.status === 'permission-required') {
    return redirectPermissionRequired(redirect.finalOrigin, finalUrl, response.status, retryAfterMs);
  }
  const finalOrigin = redirect.finalOrigin;
  if (response.status === 304) {
    return { finalOrigin, finalUrl, httpStatus: 304, retryAfterMs, status: 'not-modified' };
  }
  if (!response.ok) {
    return httpFailure(response.status, retryAfterMs, rateLimit);
  }

  const contentLength = parseContentLength(response.headers.get('content-length'));
  if (contentLength > MAX_FEED_BYTES) {
    return fetchFailure(ERROR_CODES.FETCH_RESPONSE_TOO_LARGE, { httpStatus: response.status });
  }
  const bytesResult = await readBoundedBytes(response, controller);
  if (bytesResult.status === 'failure') {
    return { ...bytesResult, httpStatus: response.status, retryAfterMs: 0 };
  }
  return {
    bytes: bytesResult.bytes,
    contentType: response.headers.get('content-type') ?? '',
    etag: response.headers.get('etag') ?? '',
    finalOrigin,
    finalUrl,
    httpStatus: response.status,
    lastModified: response.headers.get('last-modified') ?? '',
    ...rateLimit,
    status: 'fetched',
  };
}

/**
 * @param {FetchFeedInput} input
 * @returns {Record<string, string>}
 */
function buildHeaders(input) {
  /** @type {Record<string, string>} */
  const headers = { Accept: FEED_ACCEPT_HEADER };
  if (input.etag?.trim()) headers['If-None-Match'] = input.etag.trim();
  if (input.lastModified?.trim()) headers['If-Modified-Since'] = input.lastModified.trim();
  return headers;
}

/**
 * @param {string} finalUrl
 * @param {FetchFeedInput} input
 * @param {FetchDependencies} dependencies
 */
async function resolveFinalOrigin(finalUrl, input, dependencies) {
  const subscriptionOrigin = input.subscriptionOrigin ?? originPatternForUrl(input.url);
  const fallbackOrigin = originPatternForUrl(finalUrl);
  if (!dependencies.permissionController?.resolveRedirectTarget) {
    return { finalOrigin: fallbackOrigin, status: 'same-origin' };
  }
  try {
    const result = await dependencies.permissionController.resolveRedirectTarget(subscriptionOrigin, finalUrl);
    if (result.status === 'permission-required' || result.redirectOriginPending) {
      return { finalOrigin: result.finalOrigin, status: 'permission-required' };
    }
    return { finalOrigin: result.finalOrigin, status: result.status ?? 'granted-redirect' };
  } catch (error) {
    const safe = toSafeError(error);
    if (safe.code === ERROR_CODES.REDIRECT_PERMISSION_REQUIRED) {
      return { finalOrigin: fallbackOrigin, status: 'permission-required' };
    }
    throw error;
  }
}

/**
 * @param {FeedResponseLike} response
 * @param {AbortController} controller
 * @returns {Promise<{status: 'bytes', bytes: Uint8Array} | {status: 'failure', error: import('../domain/errors.js').SafeError}>}
 */
async function readBoundedBytes(response, controller) {
  if (!response.body) return { bytes: new Uint8Array(), status: 'bytes' };
  const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (response.body.getReader());
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { bytes: concatenateChunks(chunks, total), status: 'bytes' };
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > MAX_FEED_BYTES) {
        controller.abort();
        await reader.cancel();
        return fetchByteFailure(ERROR_CODES.FETCH_RESPONSE_TOO_LARGE);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * @param {Uint8Array[]} chunks
 * @param {number} total
 */
function concatenateChunks(chunks, total) {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * @param {string | null | undefined} value
 * @param {number} [nowMs]
 * @returns {number}
 */
export function parseRetryAfterMs(value, nowMs = Date.now()) {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return 0;
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) && dateMs > nowMs ? dateMs - nowMs : 0;
}

/**
 * @param {number} status
 * @param {number} retryAfterMs
 * @param {{rateLimitRemaining?: number, rateLimitResetMs?: number}} [rateLimit]
 * @returns {FetchFailureResult}
 */
function httpFailure(status, retryAfterMs, rateLimit = {}) {
  if (status === 401 || status === 403) {
    return fetchFailure(ERROR_CODES.AUTH_OR_ACCESS_DENIED, { httpStatus: status });
  }
  if (status === 404 || status === 410) return fetchFailure(ERROR_CODES.FEED_NOT_FOUND, { httpStatus: status });
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  return { ...fetchFailure(ERROR_CODES.HTTP_ERROR, { httpStatus: status, retryAfterMs, retryable }), ...rateLimit };
}

/**
 * Parses defensive x-ratelimit hints. Absent or malformed headers yield no
 * fields (never an error). `x-ratelimit-reset` is read as delta-seconds
 * (Reddit semantics) and only when it is a plausible short delta.
 *
 * @param {Headers} headers
 * @param {number} nowMs
 * @returns {{rateLimitRemaining?: number, rateLimitResetMs?: number}}
 */
function parseRateLimit(headers, nowMs) {
  /** @type {{rateLimitRemaining?: number, rateLimitResetMs?: number}} */
  const hints = {};
  const remainingRaw = trimmedHeader(headers.get('x-ratelimit-remaining'));
  const remaining = Number(remainingRaw);
  if (remainingRaw && Number.isFinite(remaining) && remaining >= 0) hints.rateLimitRemaining = Math.floor(remaining);
  const seconds = Number(trimmedHeader(headers.get('x-ratelimit-reset')));
  if (Number.isFinite(seconds) && seconds > 0 && seconds <= 86_400) hints.rateLimitResetMs = nowMs + seconds * 1000;
  return hints;
}

/**
 * @param {string | null} value
 * @returns {string}
 */
function trimmedHeader(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

/**
 * @param {string | null} value
 */
function parseContentLength(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * @param {unknown} value
 */
function isAbortError(value) {
  return value instanceof DOMException && value.name === 'AbortError';
}

/**
 * @param {unknown} error
 */
function isExpectedUrlValidationError(error) {
  return (
    error instanceof AppError &&
    (error.code === ERROR_CODES.VALIDATION_ERROR || error.code === ERROR_CODES.UNSUPPORTED_URL_SCHEME)
  );
}

/**
 * @param {number | undefined} value
 */
function normalizeTimeoutMs(value) {
  const candidate = Number.isFinite(value) ? Number(value) : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, candidate));
}

/**
 * @param {string} code
 * @param {{retryable?: boolean, httpStatus?: number, retryAfterMs?: number}} [options]
 * @returns {FetchFailureResult}
 */
function fetchFailure(code, options = {}) {
  return {
    error: toSafeError(createAppError(code, { retryable: options.retryable ?? false })),
    httpStatus: options.httpStatus ?? 0,
    retryAfterMs: options.retryAfterMs ?? 0,
    status: 'failure',
  };
}

/**
 * @param {string} finalOrigin
 * @param {string} finalUrl
 * @param {number} httpStatus
 * @param {number} retryAfterMs
 * @returns {FetchRedirectPermissionRequiredResult}
 */
function redirectPermissionRequired(finalOrigin, finalUrl, httpStatus, retryAfterMs) {
  return {
    error: toSafeError(
      createAppError(ERROR_CODES.REDIRECT_PERMISSION_REQUIRED, {
        details: { operation: 'redirect.permission' },
        retryable: false,
      }),
    ),
    finalOrigin,
    finalUrl,
    httpStatus,
    retryAfterMs,
    status: 'redirect-permission-required',
  };
}

/**
 * @param {string} code
 * @returns {{status: 'failure', error: import('../domain/errors.js').SafeError}}
 */
function fetchByteFailure(code) {
  return { error: toSafeError(createAppError(code)), status: 'failure' };
}

/**
 * @param {unknown} error
 * @returns {FetchFailureResult}
 */
function fetchFailureFromError(error) {
  if (error instanceof AppError)
    return { error: toSafeError(error), httpStatus: 0, retryAfterMs: 0, status: 'failure' };
  const rawCode =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ERROR_CODES.HTTP_ERROR;
  const code = ERROR_CODE_VALUES.includes(rawCode) ? rawCode : ERROR_CODES.HTTP_ERROR;
  return fetchFailure(code, { retryable: code === ERROR_CODES.HTTP_ERROR });
}
