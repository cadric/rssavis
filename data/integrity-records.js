// @ts-check

import { STORES } from './constants.js';
import { feedStatsId } from './feed-repository.js';
import { META_KEYS, readMetaValue, writeMetaValue } from './meta-repository.js';
import { requestToPromise } from './transaction.js';

export const PHASES = Object.freeze([
  'orphanIdentities',
  'orphanBodies',
  'articlesWithoutFeed',
  'feedsWithoutCategory',
  'missingStats',
  'defaultCategoryMissing',
]);

export const FIRST_PHASE = /** @type {IntegrityPhase} */ (PHASES[0]);

/**
 * @typedef {'orphanIdentities' | 'orphanBodies' | 'articlesWithoutFeed' | 'feedsWithoutCategory' | 'missingStats' | 'defaultCategoryMissing'} IntegrityPhase
 * @typedef {object} IntegrityFindings
 * @property {{key: string, articleId: string, feedId: string}[]} orphanIdentities
 * @property {{articleId: string}[]} orphanBodies
 * @property {{articleId: string, feedId: string}[]} articlesWithoutFeed
 * @property {{feedId: string, categoryId: string}[]} feedsWithoutCategory
 * @property {{feedId: string}[]} missingStats
 * @property {{key: string}[]} defaultCategoryMissing
 *
 * @typedef {object} IntegrityRepairs
 * @property {string[]} deletedIdentityKeys
 * @property {string[]} deletedBodyArticleIds
 * @property {string[]} deletedArticleIds
 * @property {string[]} movedFeedIds
 * @property {string[]} movedCategoryIds
 * @property {boolean} statsRebuildRequired
 *
 * @typedef {{completed: boolean, cursor: IDBValidKey | null, findings: IntegrityFindings, processed: number, repairs: IntegrityRepairs}} IntegrityChunk
 */

/**
 * @param {IDBTransaction} transaction
 * @param {IntegrityPhase} phase
 * @param {IDBValidKey | null} cursor
 * @param {number} batchSize
 * @param {boolean} repair
 * @returns {Promise<IntegrityChunk>}
 */
export async function processPhase(transaction, phase, cursor, batchSize, repair) {
  if (phase === 'defaultCategoryMissing') return processDefaultCategory(transaction);
  const findings = emptyFindings();
  const repairs = emptyRepairs();
  const chunk = await scanStore(transaction.objectStore(storeForPhase(phase)), cursor, batchSize, async (item) => {
    await inspectRecord(transaction, phase, item.value, findings, repairs, repair);
  });
  return { ...chunk, findings, repairs };
}

/**
 * @param {IDBTransaction} transaction
 * @returns {Promise<IntegrityChunk>}
 */
async function processDefaultCategory(transaction) {
  const findings = emptyFindings();
  const key = await readMetaValue(transaction, META_KEYS.DEFAULT_CATEGORY_ID);
  const category =
    typeof key === 'string' ? await requestToPromise(transaction.objectStore(STORES.CATEGORIES).get(key)) : null;
  if (!category) findings.defaultCategoryMissing.push({ key: META_KEYS.DEFAULT_CATEGORY_ID });
  return { completed: true, cursor: null, findings, processed: 1, repairs: emptyRepairs() };
}

/**
 * @param {IDBTransaction} transaction
 * @param {IntegrityPhase} phase
 * @param {Record<string, unknown>} value
 * @param {IntegrityFindings} findings
 * @param {IntegrityRepairs} repairs
 * @param {boolean} repair
 */
async function inspectRecord(transaction, phase, value, findings, repairs, repair) {
  if (phase === 'orphanIdentities') await inspectIdentity(transaction, value, findings, repairs, repair);
  else if (phase === 'orphanBodies') await inspectBody(transaction, value, findings, repairs, repair);
  else if (phase === 'articlesWithoutFeed') await inspectArticle(transaction, value, findings, repairs, repair);
  else if (phase === 'feedsWithoutCategory') await inspectFeedCategory(transaction, value, findings, repairs, repair);
  else if (phase === 'missingStats') await inspectFeedStats(transaction, value, findings, repairs, repair);
}

/**
 * @param {IDBTransaction} transaction
 * @param {Record<string, unknown>} identity
 * @param {IntegrityFindings} findings
 * @param {IntegrityRepairs} repairs
 * @param {boolean} repair
 */
async function inspectIdentity(transaction, identity, findings, repairs, repair) {
  const article = await requestToPromise(transaction.objectStore(STORES.ARTICLES).get(String(identity.articleId)));
  if (article?.feedId === identity.feedId) return;
  const finding = { key: String(identity.key), articleId: String(identity.articleId), feedId: String(identity.feedId) };
  findings.orphanIdentities.push(finding);
  if (repair) {
    await requestToPromise(transaction.objectStore(STORES.ARTICLE_IDENTITIES).delete(finding.key));
    repairs.deletedIdentityKeys.push(finding.key);
  }
}

/**
 * @param {IDBTransaction} transaction
 * @param {Record<string, unknown>} body
 * @param {IntegrityFindings} findings
 * @param {IntegrityRepairs} repairs
 * @param {boolean} repair
 */
async function inspectBody(transaction, body, findings, repairs, repair) {
  const articleId = String(body.articleId);
  const article = await requestToPromise(transaction.objectStore(STORES.ARTICLES).get(articleId));
  const feed = article ? await requestToPromise(transaction.objectStore(STORES.FEEDS).get(article.feedId)) : null;
  if (article && feed) return;
  findings.orphanBodies.push({ articleId });
  if (repair) {
    await requestToPromise(transaction.objectStore(STORES.ARTICLE_BODIES).delete(articleId));
    repairs.deletedBodyArticleIds.push(articleId);
  }
}

/**
 * @param {IDBTransaction} transaction
 * @param {Record<string, unknown>} article
 * @param {IntegrityFindings} findings
 * @param {IntegrityRepairs} repairs
 * @param {boolean} repair
 */
async function inspectArticle(transaction, article, findings, repairs, repair) {
  const feed = await requestToPromise(transaction.objectStore(STORES.FEEDS).get(String(article.feedId)));
  if (feed) return;
  const articleId = String(article.id);
  findings.articlesWithoutFeed.push({ articleId, feedId: String(article.feedId) });
  if (repair) {
    await deleteArticleDependents(transaction, articleId, repairs);
    await requestToPromise(transaction.objectStore(STORES.ARTICLES).delete(articleId));
    repairs.deletedArticleIds.push(articleId);
    await markStatsRebuildRequired(transaction, repairs);
  }
}

/**
 * @param {IDBTransaction} transaction
 * @param {Record<string, unknown>} feed
 * @param {IntegrityFindings} findings
 * @param {IntegrityRepairs} repairs
 * @param {boolean} repair
 */
async function inspectFeedCategory(transaction, feed, findings, repairs, repair) {
  const category = await requestToPromise(transaction.objectStore(STORES.CATEGORIES).get(String(feed.categoryId)));
  if (category) return;
  const finding = { feedId: String(feed.id), categoryId: String(feed.categoryId) };
  findings.feedsWithoutCategory.push(finding);
  if (repair) {
    const defaultCategoryId = String(await readMetaValue(transaction, META_KEYS.DEFAULT_CATEGORY_ID));
    await requestToPromise(transaction.objectStore(STORES.FEEDS).put({ ...feed, categoryId: defaultCategoryId }));
    repairs.movedFeedIds.push(finding.feedId);
    repairs.movedCategoryIds.push(defaultCategoryId);
    await markStatsRebuildRequired(transaction, repairs);
  }
}

/**
 * @param {IDBTransaction} transaction
 * @param {Record<string, unknown>} feed
 * @param {IntegrityFindings} findings
 * @param {IntegrityRepairs} repairs
 * @param {boolean} repair
 */
async function inspectFeedStats(transaction, feed, findings, repairs, repair) {
  const statsId = feedStatsId(String(feed.id));
  const stats = await requestToPromise(transaction.objectStore(STORES.STATS).get(statsId));
  if (stats) return;
  findings.missingStats.push({ feedId: String(feed.id) });
  if (repair) await markStatsRebuildRequired(transaction, repairs);
}

/**
 * @param {IDBTransaction} transaction
 * @param {string} articleId
 * @param {IntegrityRepairs} repairs
 */
async function deleteArticleDependents(transaction, articleId, repairs) {
  const bodies = transaction.objectStore(STORES.ARTICLE_BODIES);
  if (await requestToPromise(bodies.get(articleId))) {
    await requestToPromise(bodies.delete(articleId));
    repairs.deletedBodyArticleIds.push(articleId);
  }
  const identities = transaction.objectStore(STORES.ARTICLE_IDENTITIES);
  const range = keyRange([articleId], [articleId, '\uffff']);
  const request = identities.index('byArticle').openCursor(range);
  let cursor = await requestToPromise(request);
  while (cursor) {
    repairs.deletedIdentityKeys.push(String(cursor.value.key));
    await requestToPromise(cursor.delete());
    cursor.continue();
    cursor = await requestToPromise(request);
  }
}

/**
 * @param {IDBTransaction} transaction
 * @param {IntegrityRepairs} repairs
 */
async function markStatsRebuildRequired(transaction, repairs) {
  await writeMetaValue(transaction, META_KEYS.STATS_REBUILD_REQUIRED, true);
  repairs.statsRebuildRequired = true;
}

/**
 * @param {IDBObjectStore} store
 * @param {IDBValidKey | null} cursorKey
 * @param {number} batchSize
 * @param {(item: {key: IDBValidKey, value: Record<string, unknown>}) => Promise<void>} visit
 */
async function scanStore(store, cursorKey, batchSize, visit) {
  const request = store.openCursor(cursorKey === null ? null : keyRangeAfter(cursorKey));
  let cursor = await requestToPromise(request);
  let processed = 0;
  /** @type {IDBValidKey | null} */
  let lastKey = cursorKey;
  while (cursor && processed < batchSize) {
    await visit({ key: cursor.key, value: cursor.value });
    lastKey = cursor.key;
    processed += 1;
    if (processed < batchSize) {
      cursor.continue();
      cursor = await requestToPromise(request);
    }
  }
  if (cursor && processed >= batchSize) {
    cursor.continue();
    cursor = await requestToPromise(request);
  }
  return { completed: cursor === null, cursor: cursor === null ? null : lastKey, processed };
}

/**
 * @param {IntegrityPhase} phase
 * @param {boolean} includeMeta
 * @returns {string[]}
 */
export function storesForPhase(phase, includeMeta) {
  /** @type {Set<string>} */
  const stores = new Set(includeMeta ? [STORES.META] : []);
  stores.add(storeForPhase(phase));
  if (phase === 'orphanIdentities') stores.add(STORES.ARTICLES);
  if (phase === 'orphanBodies' || phase === 'articlesWithoutFeed') {
    stores.add(STORES.ARTICLES);
    stores.add(STORES.FEEDS);
  }
  if (phase === 'feedsWithoutCategory' || phase === 'defaultCategoryMissing') stores.add(STORES.CATEGORIES);
  if (phase === 'missingStats') stores.add(STORES.STATS);
  if (phase === 'articlesWithoutFeed') {
    stores.add(STORES.ARTICLE_IDENTITIES);
    stores.add(STORES.ARTICLE_BODIES);
  }
  return [...stores];
}

/**
 * @param {IntegrityPhase} phase
 */
function storeForPhase(phase) {
  if (phase === 'orphanIdentities') return STORES.ARTICLE_IDENTITIES;
  if (phase === 'orphanBodies') return STORES.ARTICLE_BODIES;
  if (phase === 'articlesWithoutFeed') return STORES.ARTICLES;
  if (phase === 'feedsWithoutCategory' || phase === 'missingStats') return STORES.FEEDS;
  return STORES.META;
}

/**
 * @returns {IntegrityFindings}
 */
export function emptyFindings() {
  return {
    orphanIdentities: [],
    orphanBodies: [],
    articlesWithoutFeed: [],
    feedsWithoutCategory: [],
    missingStats: [],
    defaultCategoryMissing: [],
  };
}

/**
 * @returns {IntegrityRepairs}
 */
export function emptyRepairs() {
  return {
    deletedIdentityKeys: [],
    deletedBodyArticleIds: [],
    deletedArticleIds: [],
    movedFeedIds: [],
    movedCategoryIds: [],
    statsRebuildRequired: false,
  };
}

/**
 * @param {IntegrityFindings} target
 * @param {IntegrityFindings} source
 */
export function mergeFindings(target, source) {
  target.orphanIdentities.push(...source.orphanIdentities);
  target.orphanBodies.push(...source.orphanBodies);
  target.articlesWithoutFeed.push(...source.articlesWithoutFeed);
  target.feedsWithoutCategory.push(...source.feedsWithoutCategory);
  target.missingStats.push(...source.missingStats);
  target.defaultCategoryMissing.push(...source.defaultCategoryMissing);
}

/**
 * @param {IntegrityRepairs} target
 * @param {IntegrityRepairs} source
 */
export function mergeRepairs(target, source) {
  target.deletedIdentityKeys.push(...source.deletedIdentityKeys);
  target.deletedBodyArticleIds.push(...source.deletedBodyArticleIds);
  target.deletedArticleIds.push(...source.deletedArticleIds);
  target.movedFeedIds.push(...source.movedFeedIds);
  target.movedCategoryIds.push(...source.movedCategoryIds);
  target.statsRebuildRequired = target.statsRebuildRequired || source.statsRebuildRequired;
}

/**
 * @param {IntegrityRepairs} repairs
 */
export function hasRepairs(repairs) {
  return (
    repairs.deletedIdentityKeys.length > 0 ||
    repairs.deletedBodyArticleIds.length > 0 ||
    repairs.deletedArticleIds.length > 0 ||
    repairs.movedFeedIds.length > 0 ||
    repairs.statsRebuildRequired
  );
}

/**
 * @param {IntegrityPhase} phase
 * @returns {IntegrityPhase | null}
 */
export function nextPhaseAfter(phase) {
  const candidate = PHASES[PHASES.indexOf(phase) + 1];
  return isPhase(candidate) ? candidate : null;
}

/**
 * @param {unknown} value
 * @returns {value is IntegrityPhase}
 */
export function isPhase(value) {
  return typeof value === 'string' && PHASES.includes(/** @type {IntegrityPhase} */ (value));
}

/**
 * @param {unknown} value
 * @returns {IDBValidKey | null}
 */
export function normalizeCursor(value) {
  return typeof value === 'string' || typeof value === 'number' || Array.isArray(value) ? value : null;
}

/**
 * @param {IDBValidKey} lower
 * @param {IDBValidKey} upper
 */
function keyRange(lower, upper) {
  return 'IDBKeyRange' in globalThis ? IDBKeyRange.bound(lower, upper) : null;
}

/**
 * @param {IDBValidKey} key
 */
function keyRangeAfter(key) {
  return 'IDBKeyRange' in globalThis ? IDBKeyRange.lowerBound(key, true) : null;
}
