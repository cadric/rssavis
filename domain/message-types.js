// @ts-check

/**
 * Static runtime message type catalog.
 * @readonly
 * @enum {string}
 */
export const MESSAGE_TYPES = Object.freeze({
  APP_BOOTSTRAP: 'app.bootstrap',
  APP_OPEN_TRUSTED_RESOURCE: 'app.openTrustedResource',
  SETTINGS_GET: 'settings.get',
  SETTINGS_UPDATE: 'settings.update',
  SETTINGS_RESET: 'settings.reset',
  CATEGORIES_LIST: 'categories.list',
  CATEGORIES_CREATE: 'categories.create',
  CATEGORIES_RENAME: 'categories.rename',
  CATEGORIES_MOVE: 'categories.move',
  CATEGORIES_DELETE: 'categories.delete',
  FEEDS_LIST: 'feeds.list',
  FEEDS_ADD: 'feeds.add',
  FEEDS_UPDATE: 'feeds.update',
  FEEDS_MOVE: 'feeds.move',
  FEEDS_MOVE_CATEGORY: 'feeds.moveCategory',
  FEEDS_DELETE: 'feeds.delete',
  FEEDS_REFRESH_ONE: 'feeds.refreshOne',
  FEEDS_REFRESH_ALL: 'feeds.refreshAll',
  FEEDS_GRANT_PERMISSION: 'feeds.grantPermission',
  FEEDS_GRANT_REDIRECT: 'feeds.grantRedirect',
  ARTICLES_QUERY: 'articles.query',
  ARTICLES_GET_DETAIL: 'articles.getDetail',
  ARTICLES_OPEN_ORIGINAL: 'articles.openOriginal',
  ARTICLES_OPEN_CONTENT_LINK: 'articles.openContentLink',
  ARTICLES_SET_READ: 'articles.setRead',
  ARTICLES_SET_STARRED: 'articles.setStarred',
  ARTICLES_COUNT_UNREAD: 'articles.countUnread',
  ARTICLES_MARK_SCOPE_READ: 'articles.markScopeRead',
  ARTICLES_SEARCH: 'articles.search',
  OPML_PREVIEW_IMPORT: 'opml.previewImport',
  OPML_COMMIT_IMPORT: 'opml.commitImport',
  OPML_EXPORT: 'opml.export',
  STORAGE_GET_USAGE: 'storage.getUsage',
  STORAGE_PURGE: 'storage.purge',
  STORAGE_REBUILD_STATS: 'storage.rebuildStats',
  STORAGE_DIAGNOSE_INTEGRITY: 'storage.diagnoseIntegrity',
  STORAGE_REPAIR_INTEGRITY: 'storage.repairIntegrity',
  STORAGE_RESET_DATA: 'storage.resetData',
  READER_CONTEXT_ACTIVE: 'reader.contextActive',
  READER_OPEN_OR_FOCUS: 'reader.openOrFocus',
});

/** @type {Set<string>} */
const MESSAGE_TYPE_SET = new Set(Object.values(MESSAGE_TYPES));

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isKnownMessageType(value) {
  return typeof value === 'string' && MESSAGE_TYPE_SET.has(value);
}
