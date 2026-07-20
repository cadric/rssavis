// @ts-check

/**
 * @typedef {object} ScopeCountSnapshot
 * @property {Array<Record<string, unknown>>} categories
 * @property {Array<Record<string, unknown>>} feeds
 * @property {{all?: Record<string, unknown>, main?: Record<string, unknown>}} systemStats
 *
 * @typedef {object} ScopeCountDescriptor
 * @property {number} count
 * @property {string} phraseKey
 * @property {string} shortKey
 */

/**
 * Resolves the visible and accessible count semantics for a reader scope.
 *
 * @param {import('../domain/scopes.js').Scope} scope
 * @param {ScopeCountSnapshot} snapshot
 * @returns {ScopeCountDescriptor}
 */
export function scopeCountDescriptor(scope, snapshot) {
  if (scope.type === 'system') return systemScopeCountDescriptor(scope.id, snapshot);
  const collection = scope.type === 'category' ? snapshot.categories : snapshot.feeds;
  const match = collection.find((item) => item.id === scope.id);
  return unreadDescriptor(numberValue(recordValue(match?.stats, 'unreadCount')));
}

/**
 * @param {string} id
 * @param {ScopeCountSnapshot} snapshot
 * @returns {ScopeCountDescriptor}
 */
function systemScopeCountDescriptor(id, snapshot) {
  if (id === 'main') return unreadDescriptor(numberValue(snapshot.systemStats.main?.unreadCount));
  if (id === 'unread') return unreadDescriptor(numberValue(snapshot.systemStats.all?.unreadCount));
  if (id === 'starred') {
    return {
      count: numberValue(snapshot.systemStats.all?.starredCount),
      phraseKey: 'starredCountPhrase',
      shortKey: 'starredCountShort',
    };
  }
  return {
    count: numberValue(snapshot.systemStats.all?.articleCount),
    phraseKey: 'articleCountPhrase',
    shortKey: 'articleCountShort',
  };
}

/**
 * @param {number} count
 * @returns {ScopeCountDescriptor}
 */
function unreadDescriptor(count) {
  return { count, phraseKey: 'unreadCountPhrase', shortKey: 'unreadCountShort' };
}

/** @param {unknown} value */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {unknown} value
 * @param {string} key
 */
function recordValue(value, key) {
  return typeof value === 'object' && value !== null && key in value
    ? /** @type {Record<string, unknown>} */ (value)[key]
    : undefined;
}
