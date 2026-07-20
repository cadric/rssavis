// @ts-check

import { STORES } from './constants.js';
import { normalizeArticleIdentityRecord } from './models.js';
import { requestToPromise } from './transaction.js';

/**
 * @param {{feedId: string, aliases?: Array<{kind: 'guid' | 'url' | 'fallback', valueHash: string}>}} preparedArticle
 */
export function makeAliasKeys(preparedArticle) {
  return (preparedArticle.aliases ?? []).map((alias) => `${preparedArticle.feedId}\u001f${alias.kind}\u001f${alias.valueHash}`);
}

/**
 * @param {string[]} aliasKeys
 * @param {IDBTransaction} transaction
 * @returns {Promise<string[]>}
 */
export async function findArticleIds(aliasKeys, transaction) {
  const store = transaction.objectStore(STORES.ARTICLE_IDENTITIES);
  const articleIds = new Set();
  for (const key of aliasKeys) {
    const identity = await requestToPromise(store.get(key));
    if (identity) articleIds.add(identity.articleId);
  }
  return [...articleIds];
}

/**
 * @param {string} articleId
 * @param {Array<Omit<import('./models.js').ArticleIdentityRecord, 'articleId'>>} aliases
 * @param {IDBTransaction} transaction
 */
export async function addMissingAliases(articleId, aliases, transaction) {
  const store = transaction.objectStore(STORES.ARTICLE_IDENTITIES);
  for (const alias of aliases) {
    const record = normalizeArticleIdentityRecord({ ...alias, articleId });
    if (!(await requestToPromise(store.get(record.key)))) await requestToPromise(store.put(record));
  }
}

/**
 * @param {string} articleId
 * @param {IDBTransaction} transaction
 */
export async function deleteByArticle(articleId, transaction) {
  const store = transaction.objectStore(STORES.ARTICLE_IDENTITIES);
  const identities = await requestToPromise(store.index('byArticle').getAll([articleId]));
  for (const identity of identities) await requestToPromise(store.delete(identity.key));
  return identities.length;
}

/**
 * @param {string} feedId
 * @param {IDBTransaction} transaction
 */
export async function deleteByFeed(feedId, transaction) {
  const store = transaction.objectStore(STORES.ARTICLE_IDENTITIES);
  const identities = await requestToPromise(store.index('byFeed').getAll([feedId]));
  for (const identity of identities) await requestToPromise(store.delete(identity.key));
  return identities.length;
}
