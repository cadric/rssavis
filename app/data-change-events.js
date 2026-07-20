// @ts-check

import { ERROR_CODES, createAppError } from '../domain/errors.js';
import { scopeToStorageKey } from '../domain/scopes.js';
import { CHANGE_EVENT_TYPES, isValidDataChangeArticleIds } from '../shared/messages.js';

const DATA_CHANGED_KEYS = new Set(['type', 'dataRevision', 'change']);
const CHANGE_KEYS = new Set(['articleIds', 'entities', 'feedIds', 'categoryIds', 'scopes', 'reason', 'revisionReset']);
const NO_RELOAD_REASONS = new Set([
  'feed-refresh-claim',
  'feed-refresh-replan',
  'feed-lease-expired',
  'stats-rebuild-request',
]);
const SNAPSHOT_REASONS = new Set([
  'feed-refresh-complete',
  'feed-icon',
  'feed-update',
  'feed-move',
  'feed-move-category',
  'feed-permission-state',
  'feed-permission-grant',
  'feed-redirect-permission-grant',
  'feed-add',
  'opml-import',
  'category-create',
  'category-rename',
  'category-reorder',
  'stats-delta',
  'stats-rebuild',
]);
const PRESERVE_REASONS = new Set(['feed-ingest', 'article-read-state', 'article-starred-state']);

/**
 * @typedef {{articleIds: string[], entities: string[], feedIds: string[], categoryIds: string[], scopes: string[], reason: string, revisionReset: boolean}} DataChange
 * @typedef {{dataRevision: number, change: DataChange}} DataChangedEvent
 */

/**
 * @param {unknown} value
 * @returns {DataChangedEvent}
 */
export function parseDataChangedEvent(value) {
  const record = requireRecord(value, 'data.changed');
  requireOnlyKeys(record, DATA_CHANGED_KEYS, 'data.changed');
  if (record.type !== CHANGE_EVENT_TYPES.DATA_CHANGED) throw invalidEvent('type must be data.changed');
  const dataRevision = requireNonNegativeInteger(record.dataRevision, 'dataRevision');
  const change = requireRecord(record.change, 'data.changed.change');
  requireOnlyKeys(change, CHANGE_KEYS, 'data.changed.change');
  const reason = typeof change.reason === 'string' ? change.reason : '';
  const articleIds = optionalStringArray(change.articleIds, 'articleIds');
  if (!isValidDataChangeArticleIds(articleIds, reason)) {
    throw invalidEvent('articleIds must be the bounded identity of one article flag mutation');
  }
  return {
    change: {
      articleIds,
      categoryIds: optionalStringArray(change.categoryIds, 'categoryIds'),
      entities: requireStringArray(change.entities, 'entities'),
      feedIds: optionalStringArray(change.feedIds, 'feedIds'),
      reason,
      revisionReset: change.revisionReset === true,
      scopes: optionalStringArray(change.scopes, 'scopes'),
    },
    dataRevision,
  };
}

/**
 * @param {import('../domain/scopes.js').Scope | null} activeScope
 * @param {DataChange} change
 * @param {{snapshot?: {feeds?: Array<{categoryId?: string, id?: string, mainStreamState?: number}>}, filteredReadMembership?: boolean}} [context]
 */
export function isDataChangeRelevant(activeScope, change, context = {}) {
  if (!activeScope) return true;
  if (change.revisionReset) return true;
  if (change.reason === 'feed-ingest') return isFeedMembershipRelevant(activeScope, change, context.snapshot);
  if (change.reason === 'article-read-state' && context.filteredReadMembership === true) {
    if (change.scopes.includes(scopeToStorageKey(activeScope))) return true;
    if (activeScope.type === 'system' && (activeScope.id === 'all' || activeScope.id === 'starred')) return true;
    if (activeScope.type === 'category' || (activeScope.type === 'system' && activeScope.id === 'main')) {
      return changedFeedsForScope(activeScope, change.feedIds, context.snapshot);
    }
  }
  if (change.entities.includes('feeds') || change.entities.includes('categories')) return true;
  if (change.scopes.length === 0) return true;
  return change.scopes.includes(scopeToStorageKey(activeScope));
}

/**
 * @param {import('../domain/scopes.js').Scope} activeScope
 * @param {DataChange} change
 * @param {{feeds?: Array<{categoryId?: string, id?: string, mainStreamState?: number}>} | undefined} snapshot
 */
function isFeedMembershipRelevant(activeScope, change, snapshot) {
  if (change.scopes.includes(scopeToStorageKey(activeScope))) return true;
  if (activeScope.type === 'category' || (activeScope.type === 'system' && activeScope.id === 'main')) {
    return changedFeedsForScope(activeScope, change.feedIds, snapshot);
  }
  return false;
}

/**
 * @param {import('../domain/scopes.js').Scope} activeScope
 * @param {string[]} feedIds
 * @param {{feeds?: Array<{categoryId?: string, id?: string, mainStreamState?: number}>} | undefined} snapshot
 */
function changedFeedsForScope(activeScope, feedIds, snapshot) {
  const changed = new Set(feedIds);
  return (snapshot?.feeds ?? []).some((feed) => {
    if (!feed.id || !changed.has(feed.id)) return false;
    if (activeScope.type === 'category') return feed.categoryId === activeScope.id;
    return activeScope.type === 'system' && activeScope.id === 'main' && feed.mainStreamState === 1;
  });
}

/**
 * @param {DataChange} change
 * @returns {'none' | 'snapshot' | 'preserve' | 'replace'}
 */
export function classifyDataChangeReload(change) {
  if (change.revisionReset) return 'replace';
  if (NO_RELOAD_REASONS.has(change.reason)) return 'none';
  if (SNAPSHOT_REASONS.has(change.reason)) return 'snapshot';
  if (PRESERVE_REASONS.has(change.reason)) return 'preserve';
  return 'replace';
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireRecord(value, label) {
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  throw invalidEvent(`${label} must be an object`);
}

/**
 * @param {Record<string, unknown>} record
 * @param {ReadonlySet<string>} allowed
 * @param {string} label
 */
function requireOnlyKeys(record, allowed, label) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalidEvent(`${label} has unknown field: ${key}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function requireNonNegativeInteger(value, field) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw invalidEvent(`${field} must be a non-negative integer`);
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function requireStringArray(value, field) {
  const items = optionalStringArray(value, field);
  if (!Array.isArray(value)) throw invalidEvent(`${field} must be an array`);
  return items;
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function optionalStringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw invalidEvent(`${field} must be an array of strings`);
  }
  return [...value];
}

/**
 * @param {string} reason
 */
function invalidEvent(reason) {
  return createAppError(ERROR_CODES.INVALID_MESSAGE, { details: { reason } });
}
