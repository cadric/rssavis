// @ts-check

import { ERROR_CODES, toSafeError } from '../domain/errors.js';
import { getArticleDetail } from './api-client.js';
import { articleFlagIntentGeneration } from './article-read-intent.js';

/**
 * @typedef {{articleFlagEventRevisions: Map<string, number>, input: import('./reader-controller.js').ReaderControllerInput}} ArticleFlagContext
 */

/**
 * A cross-tab flag event contains bounded article identities, not field values.
 * Resolve those values from the background-owned article record. A newer local
 * intent or newer event for the same field wins while the detail is in flight.
 * @param {ArticleFlagContext} context
 * @param {import('./data-change-events.js').DataChangedEvent} event
 * @returns {Promise<Map<string, Record<string, unknown>> | null>}
 */
export async function loadAuthoritativeArticleFlags(context, event) {
  const field = flagFieldForReason(event.change.reason);
  if (!field || event.change.articleIds.length === 0) return null;
  const requests = event.change.articleIds.map(async (articleId) => {
    const key = `${field}\n${articleId}`;
    const localGeneration = articleFlagIntentGeneration(context.input, articleId, field);
    context.articleFlagEventRevisions.set(
      key,
      Math.max(context.articleFlagEventRevisions.get(key) ?? 0, event.dataRevision),
    );
    try {
      const article = await getArticleDetail(articleId, context.input.options.browserApi);
      if (context.articleFlagEventRevisions.get(key) !== event.dataRevision) return null;
      if (articleFlagIntentGeneration(context.input, articleId, field) !== localGeneration) return null;
      return /** @type {const} */ ([articleId, /** @type {Record<string, unknown>} */ (article)]);
    } catch (error) {
      if (!isExpectedArticleDetailRaceError(error)) throw error;
      return null;
    }
  });
  const resolved = await Promise.all(requests);
  return new Map(resolved.filter((entry) => entry !== null));
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {string} reason
 * @param {Map<string, Record<string, unknown>> | null} authoritativeArticles
 */
export function applyAuthoritativeArticleFlags(input, reason, authoritativeArticles) {
  const field = flagFieldForReason(reason);
  if (!field || !authoritativeArticles || authoritativeArticles.size === 0) return;
  const current = input.getArticleState();
  let changed = false;
  let previewByArticleId = current.previewByArticleId;
  const items = current.items.map((article) => {
    const authoritative = authoritativeArticles.get(String(article.id));
    if (!authoritative) return article;
    const nextValue = numberValue(authoritative[field]);
    if (numberValue(article[field]) === nextValue) return article;
    changed = true;
    const preview = previewByArticleId[String(article.id)];
    if (preview?.detail) {
      previewByArticleId = {
        ...previewByArticleId,
        [String(article.id)]: { ...preview, detail: { ...preview.detail, [field]: nextValue } },
      };
    }
    return { ...article, [field]: nextValue };
  });
  if (changed) input.setArticleState({ ...current, items, previewByArticleId });
}

/** @param {unknown} error */
function isExpectedArticleDetailRaceError(error) {
  return toSafeError(error).code === ERROR_CODES.ARTICLE_NOT_FOUND;
}

/** @param {string} reason */
function flagFieldForReason(reason) {
  if (reason === 'article-read-state') return /** @type {const} */ ('readState');
  if (reason === 'article-starred-state') return /** @type {const} */ ('starredState');
  return null;
}

/** @param {unknown} value */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
