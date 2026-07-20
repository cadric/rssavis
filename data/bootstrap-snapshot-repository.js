// @ts-check

import { STORES } from './constants.js';
import { readDataRevision, readDefaultCategoryId } from './meta-repository.js';
import { feedStatsId } from './feed-repository.js';
import { requestToPromise, runTransaction } from './transaction.js';

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 */

/** @param {RepositoryOptions} [options] */
export function createBootstrapSnapshotRepository(options = {}) {
  return { read: () => read(options) };
}

/** @param {RepositoryOptions} options */
async function read(options) {
  return runTransaction(
    [STORES.CATEGORIES, STORES.FEEDS, STORES.STATS, STORES.META],
    'readonly',
    async (transaction) => {
      const categories = await requestToPromise(transaction.objectStore(STORES.CATEGORIES).index('byOrder').getAll());
      const feeds = await requestToPromise(transaction.objectStore(STORES.FEEDS).index('byCategoryOrder').getAll());
      const stats = await requestToPromise(transaction.objectStore(STORES.STATS).getAll());
      const byId = new Map(stats.map((value) => [value.id, value]));
      return {
        categories,
        dataRevision: await readDataRevision(transaction),
        defaultCategoryId: await readDefaultCategoryId(transaction),
        feedEntries: feeds.map((feed) => ({ feed, stats: byId.get(feedStatsId(feed.id)) ?? null })),
        globalStats: byId.get('global') ?? null,
      };
    },
    options,
  );
}
