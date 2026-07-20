// @ts-check

export const DB_NAME = 'rssavis';
export const DB_VERSION = 1;

export const STORES = Object.freeze({
  META: 'meta',
  CATEGORIES: 'categories',
  FEEDS: 'feeds',
  ARTICLES: 'articles',
  ARTICLE_IDENTITIES: 'articleIdentities',
  ARTICLE_BODIES: 'articleBodies',
  STATS: 'stats',
});

export const STATE = Object.freeze({ OFF: 0, ON: 1 });
export const SCHEDULE_STATE = Object.freeze({ DISABLED: 0, ENABLED: 1 });
export const PERMISSION_STATE = Object.freeze({ MISSING: 0, GRANTED: 1 });
export const LEASE_STATE = Object.freeze({ FREE: 0, HELD: 1 });
export const DELETION_STATE = Object.freeze({ ACTIVE: 0, PENDING: 1 });

export const INDEXES = Object.freeze({
  CATEGORIES: Object.freeze({
    BY_ORDER: Object.freeze({ name: 'byOrder', keyPath: Object.freeze(['order', 'id']), unique: false }),
    BY_NORMALIZED_TITLE: Object.freeze({ name: 'byNormalizedTitle', keyPath: 'normalizedTitle', unique: false }),
  }),
  FEEDS: Object.freeze({
    BY_NORMALIZED_URL: Object.freeze({ name: 'byNormalizedUrl', keyPath: 'normalizedUrl', unique: true }),
    BY_CATEGORY_ORDER: Object.freeze({
      name: 'byCategoryOrder',
      keyPath: Object.freeze(['categoryId', 'order', 'id']),
      unique: false,
    }),
    BY_MAIN_ORDER: Object.freeze({
      name: 'byMainOrder',
      keyPath: Object.freeze(['mainStreamState', 'order', 'id']),
      unique: false,
    }),
    BY_SCHEDULE: Object.freeze({
      name: 'bySchedule',
      keyPath: Object.freeze(['scheduleState', 'nextFetchAtMs', 'id']),
      unique: false,
    }),
    BY_LEASE_EXPIRY: Object.freeze({
      name: 'byLeaseExpiry',
      keyPath: Object.freeze(['leaseState', 'leaseExpiresAtMs', 'id']),
      unique: false,
    }),
    BY_DELETION: Object.freeze({
      name: 'byDeletion',
      keyPath: Object.freeze(['deletionState', 'updatedAtMs', 'id']),
      unique: false,
    }),
  }),
  ARTICLES: Object.freeze({
    BY_SORT: Object.freeze({ name: 'bySort', keyPath: Object.freeze(['sortAtMs', 'id']), unique: false }),
    BY_READ_SORT: Object.freeze({
      name: 'byReadSort',
      keyPath: Object.freeze(['readState', 'sortAtMs', 'id']),
      unique: false,
    }),
    BY_STAR_SORT: Object.freeze({
      name: 'byStarSort',
      keyPath: Object.freeze(['starredState', 'sortAtMs', 'id']),
      unique: false,
    }),
    BY_FEED_SORT: Object.freeze({
      name: 'byFeedSort',
      keyPath: Object.freeze(['feedId', 'sortAtMs', 'id']),
      unique: false,
    }),
    BY_FEED_READ_SORT: Object.freeze({
      name: 'byFeedReadSort',
      keyPath: Object.freeze(['feedId', 'readState', 'sortAtMs', 'id']),
      unique: false,
    }),
    BY_FEED_STAR_SORT: Object.freeze({
      name: 'byFeedStarSort',
      keyPath: Object.freeze(['feedId', 'starredState', 'sortAtMs', 'id']),
      unique: false,
    }),
    BY_FETCHED_AT: Object.freeze({
      name: 'byFetchedAt',
      keyPath: Object.freeze(['fetchedAtMs', 'id']),
      unique: false,
    }),
  }),
  ARTICLE_IDENTITIES: Object.freeze({
    BY_ARTICLE: Object.freeze({ name: 'byArticle', keyPath: Object.freeze(['articleId', 'key']), unique: false }),
    BY_FEED: Object.freeze({ name: 'byFeed', keyPath: Object.freeze(['feedId', 'key']), unique: false }),
  }),
});
