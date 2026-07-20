// @ts-check

// Article-shape key allow-lists for `app/api-validation.js`, extracted to keep that module under the
// production line budget. These are the only permitted keys on each validated article surface.

export const ARTICLE_PAGE_KEYS = new Set(['dataRevision', 'hasMore', 'items', 'nextCursor', 'planner']);
export const ARTICLE_BODY_KEYS = new Set(['contentLength', 'contentText', 'updatedAtMs', 'contentBlocks']);
export const ARTICLE_ITEM_KEYS = new Set([
  'author',
  'canonicalUrl',
  'changedAtMs',
  'createdAtMs',
  'feedIconColor',
  'feedIconSource',
  'feedIconUrl',
  'feedId',
  'feedSiteUrl',
  'feedTitle',
  'feedUrl',
  'fetchedAtMs',
  'guid',
  'hasBodyState',
  'id',
  'imageUrl',
  'primaryIdentityKey',
  'publishedAtMs',
  'readState',
  'searchText',
  'sortAtMs',
  'sourceRevisionHash',
  'sourceUpdatedAtMs',
  'starredState',
  'summaryText',
  'title',
]);
export const ARTICLE_DETAIL_KEYS = new Set([...ARTICLE_ITEM_KEYS, 'body']);
