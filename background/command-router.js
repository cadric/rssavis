// @ts-check

import { isKnownMessageType } from '../domain/message-types.js';
import { requestIdFrom, validateMessageEnvelope } from '../shared/contracts.js';
import { createAppError, createErrorResponse, createSuccessResponse } from '../shared/result.js';

/**
 * @typedef {(payload: Record<string, unknown>, context: CommandContext) => Promise<unknown> | unknown} CommandHandler
 */

/**
 * @typedef {object} CommandContext
 * @property {string} requestId
 * @property {unknown} sender
 * @property {string} type
 */

/**
 * @param {Record<string, CommandHandler>} handlers
 * @returns {(message: unknown, sender: unknown) => Promise<import('../shared/result.js').SuccessResult | import('../shared/result.js').ErrorResult>}
 */
export function createCommandRouter(handlers = {}) {
  return async function routeCommand(message, sender) {
    const requestId = requestIdFrom(message);
    const validation = validateMessageEnvelope(message);
    if (!validation.ok || validation.error !== null) return createErrorResponse(requestId, validation.error);
    if (validation.message === null) {
      return createErrorResponse(requestId, createAppError('INVALID_MESSAGE', 'errorInvalidMessage'));
    }

    const envelope = validation.message;
    const handler = handlers[envelope.type];
    if (!handler) {
      return createErrorResponse(requestId, createAppError('NOT_IMPLEMENTED', 'errorNotImplemented'));
    }

    try {
      const data = await handler(envelope.payload, { requestId, sender, type: envelope.type });
      return createSuccessResponse(requestId, data ?? {}, extractDataRevision(data));
    } catch (error) {
      const response = createErrorResponse(requestId, error);
      return response;
    }
  };
}

/**
 * @param {(message: unknown, sender: unknown) => Promise<unknown>} router
 * @returns {(message: unknown, sender: unknown) => Promise<unknown> | false}
 */
export function createMessageDispatcher(router) {
  return function dispatchMessage(message, sender) {
    if (!isDispatchable(message)) return false;
    return router(message, sender);
  };
}

/**
 * @param {unknown} message
 * @returns {boolean}
 */
function isDispatchable(message) {
  return (
    typeof message === 'object' &&
    message !== null &&
    isKnownMessageType(/** @type {{type?: unknown}} */ (message).type)
  );
}

/**
 * @param {unknown} data
 */
function extractDataRevision(data) {
  if (typeof data === 'object' && data !== null && 'dataRevision' in data) {
    const revision = /** @type {{dataRevision?: unknown}} */ (data).dataRevision;
    if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) return revision;
  }
  return 0;
}
