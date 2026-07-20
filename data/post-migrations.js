// @ts-check

import { STORES } from './constants.js';
import { buildSearchText } from '../domain/text.js';
import { normalizeArticleBodyRecord, normalizeArticleRecord, normalizeFeedRecord } from './models.js';
import { requestToPromise } from './transaction.js';

export const SEARCH_TEXT_POST_MIGRATION_ID = 'v2-backfill-search-text';
export const SEARCH_TEXT_UNPREFIX_POST_MIGRATION_ID = 'v3-unprefix-search-text';
export const FEED_IDENTITY_POST_MIGRATION_ID = 'v4-feed-identity';
export const ARTICLE_BODY_BLOCKS_POST_MIGRATION_ID = 'v5-article-body-blocks';
export const FEED_ICON_COLOR_POST_MIGRATION_ID = 'v6-feed-icon-color';

/** @type {readonly import('./migrations.js').PostMigrationDefinition[]} */
export const DEFAULT_POST_MIGRATIONS = Object.freeze([
  Object.freeze({
    id: SEARCH_TEXT_POST_MIGRATION_ID,
    stores: Object.freeze([STORES.ARTICLES]),
    run: runSearchTextPostMigration,
  }),
  Object.freeze({
    id: SEARCH_TEXT_UNPREFIX_POST_MIGRATION_ID,
    stores: Object.freeze([STORES.ARTICLES]),
    run: runSearchTextPostMigration,
  }),
  Object.freeze({
    id: FEED_IDENTITY_POST_MIGRATION_ID,
    stores: Object.freeze([STORES.FEEDS]),
    run: runFeedIdentityBackfill,
  }),
  Object.freeze({
    id: ARTICLE_BODY_BLOCKS_POST_MIGRATION_ID,
    stores: Object.freeze([STORES.ARTICLE_BODIES]),
    run: runArticleBodyBlocksBackfill,
  }),
  Object.freeze({
    id: FEED_ICON_COLOR_POST_MIGRATION_ID,
    stores: Object.freeze([STORES.FEEDS]),
    run: runFeedIconColorCleanup,
  }),
]);

/**
 * @param {{transaction: IDBTransaction, state: import('./migrations.js').PostMigrationState, batchSize: number}} input
 * @returns {Promise<import('./migrations.js').PostMigrationStepResult>}
 */
async function runSearchTextPostMigration(input) {
  const articles = input.transaction.objectStore(STORES.ARTICLES);
  const resumeAfter = typeof input.state.cursor === 'string' ? input.state.cursor : null;
  const range = resumeAfter && 'IDBKeyRange' in globalThis ? IDBKeyRange.lowerBound(input.state.cursor, true) : null;
  const request = articles.openCursor(range);
  let cursor = await requestToPromise(request);
  let processed = 0;
  let lastKey = resumeAfter;

  while (cursor && processed < input.batchSize) {
    if (!range && resumeAfter && String(cursor.primaryKey) <= resumeAfter) {
      cursor.continue();
      cursor = await requestToPromise(request);
      continue;
    }
    const article = /** @type {import('./models.js').ArticleRecord} */ (cursor.value);
    const next = normalizeArticleRecord({ ...article, searchText: buildSearchText(article) });
    if (next.searchText !== article.searchText) await requestToPromise(articles.put(next));
    lastKey = String(cursor.primaryKey);
    processed += 1;
    cursor.continue();
    cursor = await requestToPromise(request);
  }

  return {
    completed: !cursor,
    cursor: cursor ? lastKey : null,
    processed,
  };
}

/**
 * Stamps the B32 feed-identity defaults on every pre-existing feed and seeds `customTitle` from the
 * remote `title` only when the feed has never refreshed (`lastSuccessAtMs === 0`) — a feed that has
 * already refreshed has had any user title clobbered by the remote title, so there is nothing to
 * preserve. Feeds that already carry `customTitle` are skipped, keeping the backfill idempotent.
 * @param {{transaction: IDBTransaction, state: import('./migrations.js').PostMigrationState, batchSize: number}} input
 * @returns {Promise<import('./migrations.js').PostMigrationStepResult>}
 */
async function runFeedIdentityBackfill(input) {
  const feeds = input.transaction.objectStore(STORES.FEEDS);
  const resumeAfter = typeof input.state.cursor === 'string' ? input.state.cursor : null;
  const range = resumeAfter && 'IDBKeyRange' in globalThis ? IDBKeyRange.lowerBound(input.state.cursor, true) : null;
  const request = feeds.openCursor(range);
  let cursor = await requestToPromise(request);
  let processed = 0;
  let lastKey = resumeAfter;

  while (cursor && processed < input.batchSize) {
    if (!range && resumeAfter && String(cursor.primaryKey) <= resumeAfter) {
      cursor.continue();
      cursor = await requestToPromise(request);
      continue;
    }
    const feed = /** @type {Record<string, unknown>} */ (cursor.value);
    if (!('customTitle' in feed)) {
      const customTitle = feed.lastSuccessAtMs === 0 ? feed.title : '';
      await requestToPromise(feeds.put(normalizeFeedRecord({ ...feed, customTitle })));
    }
    lastKey = String(cursor.primaryKey);
    processed += 1;
    cursor.continue();
    cursor = await requestToPromise(request);
  }

  return {
    completed: !cursor,
    cursor: cursor ? lastKey : null,
    processed,
  };
}

/**
 * Stamps the B35 `contentBlocks` default (`[]`) on every pre-existing article body that predates the
 * field. Bodies that already carry `contentBlocks` are skipped, keeping the backfill idempotent. This only
 * defaults the field; it never rebuilds the block model — old articles stay flat until re-ingested (RA-5).
 * @param {{transaction: IDBTransaction, state: import('./migrations.js').PostMigrationState, batchSize: number}} input
 * @returns {Promise<import('./migrations.js').PostMigrationStepResult>}
 */
async function runArticleBodyBlocksBackfill(input) {
  const bodies = input.transaction.objectStore(STORES.ARTICLE_BODIES);
  const resumeAfter = typeof input.state.cursor === 'string' ? input.state.cursor : null;
  const range = resumeAfter && 'IDBKeyRange' in globalThis ? IDBKeyRange.lowerBound(input.state.cursor, true) : null;
  const request = bodies.openCursor(range);
  let cursor = await requestToPromise(request);
  let processed = 0;
  let lastKey = resumeAfter;

  while (cursor && processed < input.batchSize) {
    if (!range && resumeAfter && String(cursor.primaryKey) <= resumeAfter) {
      cursor.continue();
      cursor = await requestToPromise(request);
      continue;
    }
    const body = /** @type {Record<string, unknown>} */ (cursor.value);
    if (!('contentBlocks' in body)) {
      await requestToPromise(bodies.put(normalizeArticleBodyRecord({ ...body, contentBlocks: [] })));
    }
    lastKey = String(cursor.primaryKey);
    processed += 1;
    cursor.continue();
    cursor = await requestToPromise(request);
  }

  return {
    completed: !cursor,
    cursor: cursor ? lastKey : null,
    processed,
  };
}

/**
 * Removes the retired B32 `builtinIconKey` property from every stored feed and rewrites a legacy
 * `iconSource: 'builtin'` to `'auto'` in the same put (B36): `normalizeFeedRecord` drops the retired
 * property from its output and normalizes the source, so one rewrite covers both. Records that carry
 * neither legacy shape are skipped, keeping the cleanup idempotent.
 * @param {{transaction: IDBTransaction, state: import('./migrations.js').PostMigrationState, batchSize: number}} input
 * @returns {Promise<import('./migrations.js').PostMigrationStepResult>}
 */
async function runFeedIconColorCleanup(input) {
  const feeds = input.transaction.objectStore(STORES.FEEDS);
  const resumeAfter = typeof input.state.cursor === 'string' ? input.state.cursor : null;
  const range = resumeAfter && 'IDBKeyRange' in globalThis ? IDBKeyRange.lowerBound(input.state.cursor, true) : null;
  const request = feeds.openCursor(range);
  let cursor = await requestToPromise(request);
  let processed = 0;
  let lastKey = resumeAfter;

  while (cursor && processed < input.batchSize) {
    if (!range && resumeAfter && String(cursor.primaryKey) <= resumeAfter) {
      cursor.continue();
      cursor = await requestToPromise(request);
      continue;
    }
    const feed = /** @type {Record<string, unknown>} */ (cursor.value);
    if ('builtinIconKey' in feed || feed.iconSource === 'builtin') {
      await requestToPromise(feeds.put(normalizeFeedRecord(feed)));
    }
    lastKey = String(cursor.primaryKey);
    processed += 1;
    cursor.continue();
    cursor = await requestToPromise(request);
  }

  return {
    completed: !cursor,
    cursor: cursor ? lastKey : null,
    processed,
  };
}
