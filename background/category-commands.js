// @ts-check

import { createCategoryRepository } from '../data/category-repository.js';
import { ERROR_CODES, createAppError } from '../domain/errors.js';
import { MESSAGE_TYPES } from '../domain/message-types.js';
import { createCommittedChangePublisher } from './change-events.js';

/**
 * @typedef {import('../data/transaction.js').TransactionOptions} RepositoryOptions
 * @typedef {import('./change-events.js').BrowserRuntimeLike} CategoryBrowserLike
 */

/**
 * @param {RepositoryOptions} options
 * @param {CategoryBrowserLike} [browserApi]
 * @param {import('./change-events.js').ChangePublisher} [changePublisher]
 * @returns {Record<string, import('./command-router.js').CommandHandler>}
 */
export function createCategoryCommandHandlers(options = {}, browserApi = undefined, changePublisher = undefined) {
  const categories = createCategoryRepository(options);
  return {
    [MESSAGE_TYPES.CATEGORIES_LIST]: () => categories.listOrdered(),
    [MESSAGE_TYPES.CATEGORIES_CREATE]: (payload) =>
      runMutationCommand(
        () => categories.create({ title: requireString(payload, 'title') }),
        browserApi,
        changePublisher,
      ),
    [MESSAGE_TYPES.CATEGORIES_RENAME]: (payload) =>
      runMutationCommand(
        () => categories.rename(requireString(payload, 'id'), requireString(payload, 'title')),
        browserApi,
        changePublisher,
      ),
    [MESSAGE_TYPES.CATEGORIES_MOVE]: (payload) =>
      runMutationCommand(
        () => categories.moveRelative(requireString(payload, 'id'), requireDirection(payload)),
        browserApi,
        changePublisher,
      ),
    [MESSAGE_TYPES.CATEGORIES_DELETE]: (payload) =>
      runMutationCommand(
        () => categories.deleteAndMoveFeeds(requireString(payload, 'id')),
        browserApi,
        changePublisher,
      ),
  };
}

/**
 * @param {() => Promise<import('./change-events.js').RepositoryMutationResult>} operation
 * @param {CategoryBrowserLike | undefined} browserApi
 * @param {import('./change-events.js').ChangePublisher | undefined} changePublisher
 */
async function runMutationCommand(operation, browserApi, changePublisher = undefined) {
  const result = await operation();
  const publisher = changePublisher ?? (browserApi ? createCommittedChangePublisher(browserApi) : null);
  if (publisher) await publisher(result);
  return result;
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} key
 */
function requireString(payload, key) {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
      details: { field: key, reason: 'must be a non-empty string' },
    });
  }
  return value;
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {'up' | 'down'}
 */
function requireDirection(payload) {
  const direction = payload.direction;
  if (direction === 'up' || direction === 'down') return direction;
  throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
    details: { field: 'direction', reason: 'must be up or down' },
  });
}
