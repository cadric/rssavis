// @ts-check

import { DB_NAME, DB_VERSION, INDEXES, STORES } from './constants.js';

export { DB_NAME, DB_VERSION };

/**
 * @typedef {object} IndexSchema
 * @property {string | readonly string[]} keyPath
 * @property {boolean} unique
 * @property {boolean} multiEntry
 *
 * @typedef {object} StoreSchema
 * @property {string} keyPath
 * @property {Readonly<Record<string, IndexSchema>>} indexes
 */

/** @type {Readonly<Record<string, StoreSchema>>} */
export const STORE_SCHEMAS = Object.freeze({
  [STORES.META]: Object.freeze({
    keyPath: 'key',
    indexes: Object.freeze({}),
  }),
  [STORES.CATEGORIES]: Object.freeze({
    keyPath: 'id',
    indexes: freezeIndexes({
      [INDEXES.CATEGORIES.BY_ORDER.name]: indexSchema(INDEXES.CATEGORIES.BY_ORDER.keyPath),
      [INDEXES.CATEGORIES.BY_NORMALIZED_TITLE.name]: indexSchema(INDEXES.CATEGORIES.BY_NORMALIZED_TITLE.keyPath),
    }),
  }),
  [STORES.FEEDS]: Object.freeze({
    keyPath: 'id',
    indexes: freezeIndexes({
      [INDEXES.FEEDS.BY_NORMALIZED_URL.name]: indexSchema(
        INDEXES.FEEDS.BY_NORMALIZED_URL.keyPath,
        INDEXES.FEEDS.BY_NORMALIZED_URL.unique,
      ),
      [INDEXES.FEEDS.BY_CATEGORY_ORDER.name]: indexSchema(INDEXES.FEEDS.BY_CATEGORY_ORDER.keyPath),
      [INDEXES.FEEDS.BY_MAIN_ORDER.name]: indexSchema(INDEXES.FEEDS.BY_MAIN_ORDER.keyPath),
      [INDEXES.FEEDS.BY_SCHEDULE.name]: indexSchema(INDEXES.FEEDS.BY_SCHEDULE.keyPath),
      [INDEXES.FEEDS.BY_LEASE_EXPIRY.name]: indexSchema(INDEXES.FEEDS.BY_LEASE_EXPIRY.keyPath),
      [INDEXES.FEEDS.BY_DELETION.name]: indexSchema(INDEXES.FEEDS.BY_DELETION.keyPath),
    }),
  }),
  [STORES.ARTICLES]: Object.freeze({
    keyPath: 'id',
    indexes: freezeIndexes({
      [INDEXES.ARTICLES.BY_SORT.name]: indexSchema(INDEXES.ARTICLES.BY_SORT.keyPath),
      [INDEXES.ARTICLES.BY_READ_SORT.name]: indexSchema(INDEXES.ARTICLES.BY_READ_SORT.keyPath),
      [INDEXES.ARTICLES.BY_STAR_SORT.name]: indexSchema(INDEXES.ARTICLES.BY_STAR_SORT.keyPath),
      [INDEXES.ARTICLES.BY_FEED_SORT.name]: indexSchema(INDEXES.ARTICLES.BY_FEED_SORT.keyPath),
      [INDEXES.ARTICLES.BY_FEED_READ_SORT.name]: indexSchema(INDEXES.ARTICLES.BY_FEED_READ_SORT.keyPath),
      [INDEXES.ARTICLES.BY_FEED_STAR_SORT.name]: indexSchema(INDEXES.ARTICLES.BY_FEED_STAR_SORT.keyPath),
      [INDEXES.ARTICLES.BY_FETCHED_AT.name]: indexSchema(INDEXES.ARTICLES.BY_FETCHED_AT.keyPath),
    }),
  }),
  [STORES.ARTICLE_IDENTITIES]: Object.freeze({
    keyPath: 'key',
    indexes: freezeIndexes({
      [INDEXES.ARTICLE_IDENTITIES.BY_ARTICLE.name]: indexSchema(INDEXES.ARTICLE_IDENTITIES.BY_ARTICLE.keyPath),
      [INDEXES.ARTICLE_IDENTITIES.BY_FEED.name]: indexSchema(INDEXES.ARTICLE_IDENTITIES.BY_FEED.keyPath),
    }),
  }),
  [STORES.ARTICLE_BODIES]: Object.freeze({
    keyPath: 'articleId',
    indexes: Object.freeze({}),
  }),
  [STORES.STATS]: Object.freeze({
    keyPath: 'id',
    indexes: Object.freeze({}),
  }),
});

/**
 * @param {IDBDatabase} database
 * @param {IDBTransaction | null} transaction
 * @param {number} oldVersion
 * @param {number | null} newVersion
 */
export function upgradeSchema(database, transaction, oldVersion, newVersion) {
  void transaction;
  void newVersion;
  if (oldVersion >= 1) return;

  for (const [storeName, schema] of Object.entries(STORE_SCHEMAS)) {
    const store = database.createObjectStore(storeName, { keyPath: schema.keyPath });
    for (const [indexName, index] of Object.entries(schema.indexes)) {
      store.createIndex(indexName, toIndexKeyPath(index.keyPath), {
        unique: index.unique,
        multiEntry: index.multiEntry,
      });
    }
  }
}

/**
 * @param {string | readonly string[]} keyPath
 * @param {boolean} [unique]
 * @returns {IndexSchema}
 */
function indexSchema(keyPath, unique = false) {
  return Object.freeze({
    keyPath: Array.isArray(keyPath) ? [...keyPath] : keyPath,
    unique,
    multiEntry: false,
  });
}

/**
 * @param {string | readonly string[]} keyPath
 * @returns {string | string[]}
 */
function toIndexKeyPath(keyPath) {
  return typeof keyPath === 'string' ? keyPath : [...keyPath];
}

/**
 * @param {Record<string, IndexSchema>} indexes
 * @returns {Readonly<Record<string, IndexSchema>>}
 */
function freezeIndexes(indexes) {
  return Object.freeze(indexes);
}
