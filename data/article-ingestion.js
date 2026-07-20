// @ts-check

import { MAX_ALIASES_PER_ARTICLE, sortAliasesForStorage } from '../domain/dedupe.js';
import { createAppError, ERROR_CODES } from '../domain/errors.js';
import { DELETION_STATE, STORES } from './constants.js';
import { feedStatsId, requireFeed } from './feed-repository.js';
import { normalizeArticleBodyRecord, normalizeArticleIdentityRecord, normalizeArticleRecord } from './models.js';
import { articleStatsDelta, applyStatsDeltas } from './article-stats.js';
import { requestToPromise, runMutation, runTransaction } from './transaction.js';

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 * @typedef {import('../background/refresh-service.js').PreparedArticle} PreparedArticle
 * @typedef {{chunkSize?: number, maxChunks?: number, afterChunk?: (aggregate: IngestAggregate) => Promise<void> | void}} IngestOptions
 * @typedef {object} IngestAggregate
 * @property {boolean} changed
 * @property {boolean} completed
 * @property {number} chunksProcessed
 * @property {number} insertedCount
 * @property {number} updatedCount
 * @property {number} aliasesAddedCount
 * @property {number} skippedCount
 * @property {string[]} insertedArticleIds
 * @property {string[]} updatedArticleIds
 * @property {Array<{code: string, feedId: string, sourceOrder: number}>} skipped
 * @property {number} dataRevision
 * @property {(import('./transaction.js').ChangeInput & {revisionReset?: boolean}) | null} change
 */

/**
 * @param {string} feedId
 * @param {PreparedArticle[]} preparedArticles
 * @param {IngestOptions} input
 * @param {RepositoryOptions} options
 */
export async function ingestPreparedArticles(feedId, preparedArticles, input, options) {
  const chunkSize = normalizeChunkSize(input.chunkSize, 200);
  const maxChunks = normalizeMaxChunks(input.maxChunks);
  const chunks = chunkPrepared(preparedArticles, chunkSize);
  const aggregate = createAggregate(chunks.length === 0);
  if (chunks.length === 0) return readNoopResult(options, aggregate);
  for (const chunk of chunks.slice(0, maxChunks)) {
    mergeAggregate(aggregate, await ingestChunk(feedId, chunk, options));
    if (input.afterChunk) await input.afterChunk(aggregate);
  }
  aggregate.completed = aggregate.chunksProcessed === chunks.length;
  return aggregate;
}

/**
 * @param {string} feedId
 * @param {PreparedArticle[]} chunk
 * @param {RepositoryOptions} options
 */
async function ingestChunk(feedId, chunk, options) {
  return runMutation(
    [STORES.FEEDS, STORES.ARTICLES, STORES.ARTICLE_IDENTITIES, STORES.ARTICLE_BODIES, STORES.STATS],
    async (context) => {
      const stores = ingestionStores(context.transaction);
      const feed = await requireFeed(stores.feeds, feedId);
      if (feed.deletionState !== DELETION_STATE.ACTIVE) throw validationError('feedId', 'feed is not active');
      const result = createAggregate(false);
      /** @type {Record<string, import('./article-stats.js').StatsDelta>} */
      const deltas = {};
      for (const prepared of chunk) await ingestOne(prepared, stores, deltas, result, context.now());
      if (Object.keys(deltas).length > 0) await applyStatsDeltas(stores.stats, deltas, context.now());
      if (result.insertedCount > 0 || result.updatedCount > 0 || result.aliasesAddedCount > 0) {
        await context.markChanged({
          entities: ['articles', 'articleIdentities', 'articleBodies', 'stats'],
          feedIds: [feedId],
          scopes: ['system:all', 'system:unread', `feed:${feedId}`],
          reason: 'feed-ingest',
        });
      }
      return result;
    },
    { ...options, durability: 'relaxed' },
  );
}

/**
 * @param {PreparedArticle} prepared
 * @param {ReturnType<typeof ingestionStores>} stores
 * @param {Record<string, import('./article-stats.js').StatsDelta>} deltas
 * @param {ReturnType<typeof createAggregate>} result
 * @param {number} now
 */
async function ingestOne(prepared, stores, deltas, result, now) {
  const matches = await findMatchedArticleIds(
    prepared.aliases.map((alias) => alias.key),
    stores.identities,
  );
  if (matches.length > 1) {
    result.skipped.push({
      code: ERROR_CODES.DEDUPE_AMBIGUOUS,
      feedId: prepared.article.feedId,
      sourceOrder: prepared.sourceOrder,
    });
    result.skippedCount += 1;
    return;
  }
  if (matches.length === 0) {
    await insertPrepared(prepared, stores, deltas, result, now);
    return;
  }
  await updatePrepared(matches[0], prepared, stores, result, now);
}

/**
 * @param {PreparedArticle} prepared
 * @param {ReturnType<typeof ingestionStores>} stores
 * @param {Record<string, import('./article-stats.js').StatsDelta>} deltas
 * @param {ReturnType<typeof createAggregate>} result
 * @param {number} now
 */
async function insertPrepared(prepared, stores, deltas, result, now) {
  const article = normalizeArticleRecord(prepared.article);
  await requestToPromise(stores.articles.add(article));
  for (const alias of sortAliasesForStorage(prepared.aliases).slice(0, MAX_ALIASES_PER_ARTICLE)) {
    await addIdentity(stores.identities, article.id, alias, now);
  }
  if (prepared.body) await requestToPromise(stores.bodies.put(normalizeArticleBodyRecord(prepared.body)));
  addDelta(deltas, article.feedId, articleStatsDelta(article, 1));
  result.insertedCount += 1;
  result.insertedArticleIds.push(article.id);
}

/**
 * @param {string} articleId
 * @param {PreparedArticle} prepared
 * @param {ReturnType<typeof ingestionStores>} stores
 * @param {ReturnType<typeof createAggregate>} result
 * @param {number} now
 */
async function updatePrepared(articleId, prepared, stores, result, now) {
  const existing = await requestToPromise(stores.articles.get(articleId));
  if (!existing) throw createAppError(ERROR_CODES.ARTICLE_NOT_FOUND, { details: { articleId } });
  const aliasesAdded = await addMissingAliasesBounded(articleId, prepared.aliases, stores.identities, now);
  if (existing.sourceRevisionHash !== prepared.article.sourceRevisionHash) {
    const next = normalizeArticleRecord({
      ...prepared.article,
      id: existing.id,
      feedId: existing.feedId,
      primaryIdentityKey: existing.primaryIdentityKey,
      readState: existing.readState,
      starredState: existing.starredState,
      createdAtMs: existing.createdAtMs,
      changedAtMs: now,
    });
    await requestToPromise(stores.articles.put(next));
    if (prepared.body) {
      await requestToPromise(
        stores.bodies.put(normalizeArticleBodyRecord({ ...prepared.body, articleId: existing.id, updatedAtMs: now })),
      );
    } else {
      await requestToPromise(stores.bodies.delete(existing.id));
    }
    result.updatedCount += 1;
    result.updatedArticleIds.push(existing.id);
  }
  result.aliasesAddedCount += aliasesAdded;
}

/**
 * @param {string[]} aliasKeys
 * @param {IDBObjectStore} identities
 */
async function findMatchedArticleIds(aliasKeys, identities) {
  const articleIds = new Set();
  for (const key of aliasKeys) {
    const identity = await requestToPromise(identities.get(key));
    if (identity) articleIds.add(identity.articleId);
  }
  return [...articleIds].sort();
}

/**
 * @param {string} articleId
 * @param {PreparedArticle['aliases']} aliases
 * @param {IDBObjectStore} identities
 * @param {number} now
 */
async function addMissingAliasesBounded(articleId, aliases, identities, now) {
  const existing = await readIdentitiesByArticle(identities, articleId);
  const existingKeys = new Set(existing.map((identity) => identity.key));
  let added = 0;
  for (const alias of sortAliasesForStorage(aliases)) {
    if (existingKeys.has(alias.key)) continue;
    if (existing.length + added >= MAX_ALIASES_PER_ARTICLE) break;
    await addIdentity(identities, articleId, alias, now);
    added += 1;
  }
  return added;
}

/**
 * @param {IDBObjectStore} identities
 * @param {string} articleId
 * @param {PreparedArticle['aliases'][number]} alias
 * @param {number} now
 */
async function addIdentity(identities, articleId, alias, now) {
  await requestToPromise(
    identities.add(
      normalizeArticleIdentityRecord({
        key: alias.key,
        feedId: alias.key.split('\u001f')[0],
        articleId,
        kind: alias.kind,
        valueHash: alias.valueHash,
        createdAtMs: now,
      }),
    ),
  );
}

/**
 * @param {IDBObjectStore} identities
 * @param {string} articleId
 */
async function readIdentitiesByArticle(identities, articleId) {
  const range = 'IDBKeyRange' in globalThis ? IDBKeyRange.bound([articleId], [articleId, '\uffff']) : null;
  const request = identities.index('byArticle').openCursor(range);
  const records = [];
  let cursor = await requestToPromise(request);
  while (cursor) {
    if (range || cursor.value.articleId === articleId) records.push(cursor.value);
    cursor.continue();
    cursor = await requestToPromise(request);
  }
  return records;
}

/**
 * @param {IDBTransaction} transaction
 */
function ingestionStores(transaction) {
  return {
    feeds: transaction.objectStore(STORES.FEEDS),
    articles: transaction.objectStore(STORES.ARTICLES),
    identities: transaction.objectStore(STORES.ARTICLE_IDENTITIES),
    bodies: transaction.objectStore(STORES.ARTICLE_BODIES),
    stats: transaction.objectStore(STORES.STATS),
  };
}

/**
 * @param {Record<string, import('./article-stats.js').StatsDelta>} deltas
 * @param {string} feedId
 * @param {import('./article-stats.js').StatsDelta} delta
 */
function addDelta(deltas, feedId, delta) {
  const current = deltas[feedId] ?? {};
  deltas[feedId] = {
    articleCount: (current.articleCount ?? 0) + (delta.articleCount ?? 0),
    unreadCount: (current.unreadCount ?? 0) + (delta.unreadCount ?? 0),
    starredCount: (current.starredCount ?? 0) + (delta.starredCount ?? 0),
    lastArticleAtMs: Math.max(current.lastArticleAtMs ?? 0, delta.lastArticleAtMs ?? 0),
  };
}

/**
 * @param {PreparedArticle[]} prepared
 * @param {number} size
 */
function chunkPrepared(prepared, size) {
  const chunks = [];
  for (let index = 0; index < prepared.length; index += size) chunks.push(prepared.slice(index, index + size));
  return chunks;
}

/**
 * @param {number | undefined} value
 * @param {number} max
 */
function normalizeChunkSize(value, max) {
  if (value === undefined) return max;
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw validationError('chunkSize', `must be an integer from 1 to ${max}`);
  return value;
}

/**
 * @param {number | undefined} value
 */
function normalizeMaxChunks(value) {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(value) || value < 1) throw validationError('maxChunks', 'must be a positive integer');
  return value;
}

/**
 * @param {boolean} completed
 * @returns {IngestAggregate}
 */
function createAggregate(completed) {
  return {
    changed: false,
    completed,
    chunksProcessed: 0,
    insertedCount: 0,
    updatedCount: 0,
    aliasesAddedCount: 0,
    skippedCount: 0,
    insertedArticleIds: [],
    updatedArticleIds: [],
    skipped: [],
    dataRevision: 0,
    change: null,
  };
}

/**
 * @param {ReturnType<typeof createAggregate>} aggregate
 * @param {ReturnType<typeof createAggregate> & import('./transaction.js').MutationResultBase} chunk
 */
function mergeAggregate(aggregate, chunk) {
  aggregate.changed ||= chunk.changed;
  aggregate.chunksProcessed += 1;
  aggregate.insertedCount += chunk.insertedCount;
  aggregate.updatedCount += chunk.updatedCount;
  aggregate.aliasesAddedCount += chunk.aliasesAddedCount;
  aggregate.skippedCount += chunk.skippedCount;
  aggregate.insertedArticleIds.push(...chunk.insertedArticleIds);
  aggregate.updatedArticleIds.push(...chunk.updatedArticleIds);
  aggregate.skipped.push(...chunk.skipped);
  aggregate.dataRevision = chunk.dataRevision;
  aggregate.change = chunk.change;
}

/**
 * @param {RepositoryOptions} options
 * @param {ReturnType<typeof createAggregate>} aggregate
 */
async function readNoopResult(options, aggregate) {
  return runTransaction(STORES.META, 'readonly', async () => aggregate, options);
}

/**
 * @param {string} field
 * @param {string} reason
 */
function validationError(field, reason) {
  return createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field, reason } });
}
