// @ts-check

import { normalizeArticleRecord, normalizeArticleBodyRecord } from '../data/models.js';
import { STATE } from '../data/constants.js';
import { buildArticleId, buildIdentityAliases, dedupePreparedArticles } from '../domain/dedupe.js';
import { sha256Hex, stableJson } from '../domain/hashing.js';

/**
 * @typedef {object} ParserNeutralArticleInput
 * @property {string} [guid]
 * @property {string} canonicalUrl
 * @property {string} title
 * @property {string} [author]
 * @property {number} [publishedAtMs]
 * @property {number} [sourceUpdatedAtMs]
 * @property {string} [summaryText]
 * @property {string} [contentText]
 * @property {import('../domain/article-content-blocks.js').Block[]} [contentBlocks]
 * @property {string} [imageUrl]
 *
 * @typedef {object} PreparedArticle
 * @property {number} sourceOrder
 * @property {Array<import('../domain/dedupe.js').IdentityAlias>} aliases
 * @property {import('../data/models.js').ArticleRecord} article
 * @property {import('../data/models.js').ArticleBodyRecord | null} body
 */

/**
 * @param {{feed: import('../data/models.js').FeedRecord, entries: ParserNeutralArticleInput[], fetchedAtMs: number}} input
 * @returns {Promise<PreparedArticle[]>}
 */
export async function prepareArticlesForIngestion(input) {
  const entries = input.entries.slice(0, 500);
  /** @type {PreparedArticle[]} */
  const prepared = [];
  for (const [sourceOrder, entry] of entries.entries()) {
    const article = await prepareArticle(input.feed, entry, input.fetchedAtMs, sourceOrder);
    if (article) prepared.push(article);
  }
  return dedupePreparedArticles(prepared);
}

/**
 * @param {import('../data/models.js').FeedRecord} feed
 * @param {ParserNeutralArticleInput} entry
 * @param {number} fetchedAtMs
 * @param {number} sourceOrder
 * @returns {Promise<PreparedArticle | null>}
 */
async function prepareArticle(feed, entry, fetchedAtMs, sourceOrder) {
  const aliases = await buildIdentityAliases({
    canonicalUrl: entry.canonicalUrl,
    feedId: feed.id,
    guid: entry.guid,
    publishedAtMs: entry.publishedAtMs,
    summaryText: entry.summaryText,
    title: entry.title,
  });
  if (aliases.length === 0) {
    console.warn({
      atMs: fetchedAtMs,
      code: 'ARTICLE_IDENTITY_MISSING',
      feedId: feed.id,
      level: 'warn',
      operation: 'article-preparation',
      sourceOrder,
    });
    return null;
  }
  const primaryIdentityKey = aliases[0].key;
  const id = await buildArticleId(feed.id, primaryIdentityKey);
  const sourceRevisionHash = await sha256Hex(stableJson(revisionSource(entry)));
  const hasBody = Boolean(entry.contentText) || (entry.contentBlocks?.length ?? 0) > 0;
  const article = normalizeArticleRecord({
    author: entry.author ?? '',
    canonicalUrl: entry.canonicalUrl,
    changedAtMs: fetchedAtMs,
    createdAtMs: fetchedAtMs,
    feedId: feed.id,
    fetchedAtMs,
    guid: entry.guid ?? '',
    hasBodyState: hasBody ? STATE.ON : STATE.OFF,
    id,
    imageUrl: entry.imageUrl ?? '',
    primaryIdentityKey,
    publishedAtMs: entry.publishedAtMs ?? 0,
    readState: STATE.OFF,
    sourceRevisionHash,
    sourceUpdatedAtMs: entry.sourceUpdatedAtMs ?? 0,
    starredState: STATE.OFF,
    summaryText: entry.summaryText ?? '',
    title: entry.title,
  });
  const body = hasBody
    ? normalizeArticleBodyRecord({
        articleId: article.id,
        contentBlocks: entry.contentBlocks ?? [],
        contentText: entry.contentText ?? '',
        updatedAtMs: fetchedAtMs,
      })
    : null;
  return { aliases, article, body, sourceOrder };
}

/**
 * @param {ParserNeutralArticleInput} entry
 */
function revisionSource(entry) {
  return {
    author: entry.author ?? '',
    canonicalUrl: entry.canonicalUrl,
    contentBlocks: entry.contentBlocks ?? [],
    contentText: entry.contentText ?? '',
    guid: entry.guid ?? '',
    imageUrl: entry.imageUrl ?? '',
    publishedAtMs: entry.publishedAtMs ?? 0,
    sourceUpdatedAtMs: entry.sourceUpdatedAtMs ?? 0,
    summaryText: entry.summaryText ?? '',
    title: entry.title,
  };
}
