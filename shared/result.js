// @ts-check

import { toSafeError as serializeSafeError } from '../domain/errors.js';

export { AppError, createAppError, toSafeError } from '../domain/errors.js';

/** @typedef {import('../domain/errors.js').SafeError} SafeError */

/**
 * @typedef {object} SuccessResult
 * @property {true} ok
 * @property {string} requestId
 * @property {unknown} data
 * @property {number} dataRevision
 */

/**
 * @typedef {object} ErrorResult
 * @property {false} ok
 * @property {string} requestId
 * @property {SafeError} error
 */

/**
 * @param {string} requestId
 * @param {unknown} data
 * @param {number} [dataRevision]
 * @returns {SuccessResult}
 */
export function createSuccessResponse(requestId, data, dataRevision = 0) {
  return { ok: true, requestId, data, dataRevision };
}

/**
 * @param {string} requestId
 * @param {unknown} error
 * @returns {ErrorResult}
 */
export function createErrorResponse(requestId, error) {
  return { ok: false, requestId, error: serializeSafeError(error) };
}
