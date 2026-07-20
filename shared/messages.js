// @ts-check

export { MESSAGE_TYPES, isKnownMessageType } from '../domain/message-types.js';

/**
 * Static background-to-app event type catalog.
 * @readonly
 * @enum {string}
 */
export const CHANGE_EVENT_TYPES = Object.freeze({
  DATA_CHANGED: 'data.changed',
  DATABASE_BLOCKED: 'database.blocked',
  DATABASE_RELOAD_REQUIRED: 'database.reloadRequired',
});

export const DATA_CHANGE_ARTICLE_ID_LIMITS = Object.freeze({
  maxCodeUnits: 128,
  maxItems: 1,
});

export const DATA_CHANGE_ARTICLE_ID_REASONS = Object.freeze(['article-read-state', 'article-starred-state']);

/**
 * @param {unknown[]} articleIds
 * @param {string} reason
 */
export function isValidDataChangeArticleIds(articleIds, reason) {
  if (articleIds.length === 0) return true;
  return (
    DATA_CHANGE_ARTICLE_ID_REASONS.includes(reason) &&
    articleIds.length <= DATA_CHANGE_ARTICLE_ID_LIMITS.maxItems &&
    articleIds.every(
      (articleId) =>
        typeof articleId === 'string' &&
        articleId.length > 0 &&
        articleId.length <= DATA_CHANGE_ARTICLE_ID_LIMITS.maxCodeUnits,
    )
  );
}
