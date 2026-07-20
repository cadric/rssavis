// @ts-check

import { scopeToStorageKey } from '../domain/scopes.js';
import { effectiveArticleFilter } from './article-filter.js';
import { normalizeSearchInput } from './reader-search-identity.js';

const INTENT_PRIORITY = Object.freeze({ snapshot: 0, availability: 1, reconcile: 2, 'hard-reset': 3 });

/**
 * @typedef {'snapshot' | 'availability' | 'reconcile' | 'hard-reset'} ReaderRefreshKind
 * @typedef {'ignored' | 'snapshot-only' | 'deferred' | 'availability-raised' | 'rows-reloaded' | 'hard-reset'} ReaderRefreshOutcome
 * @typedef {object} ReaderRefreshIntent
 * @property {number} [bootstrapRevision]
 * @property {import('./api-validation.js').BootstrapSnapshot} [feedSnapshotBefore]
 * @property {boolean} includesFeedIngest
 * @property {ReaderRefreshKind} kind
 * @property {boolean} [membershipReconcile]
 * @property {string} queryKey
 * @property {number} readerEpoch
 * @property {boolean} revisionReset
 * @property {boolean} [scopeChanged]
 * @property {number} scopeSequence
 * @property {number} targetRevision
 */

/**
 * @param {{activeScope: import('../domain/scopes.js').Scope, articleFilter?: unknown, mode?: string} & Record<string, unknown>} state
 * @param {{searchActive: boolean, searchQuery: string, settings?: {articlesPerPage?: number}}} articleState
 * @param {number} [pageSize]
 */
export function readerQueryKey(state, articleState, pageSize = articleState.settings?.articlesPerPage ?? 100) {
  const searchQuery = articleState.searchActive ? normalizeSearchInput(articleState.searchQuery) : '';
  const effectiveFilter = effectiveArticleFilter({ ...state, mode: 'reader' }, articleState);
  return [scopeToStorageKey(state.activeScope), searchQuery, effectiveFilter, pageSize].join('\n');
}

/**
 * @param {ReaderRefreshIntent | null} current
 * @param {ReaderRefreshIntent} next
 * @returns {ReaderRefreshIntent}
 */
export function mergeReaderRefreshIntents(current, next) {
  if (!current) return { ...next };
  if (current.revisionReset || next.revisionReset) {
    return { ...(next.revisionReset ? next : current) };
  }
  if (
    current.readerEpoch !== next.readerEpoch ||
    current.scopeSequence !== next.scopeSequence ||
    current.queryKey !== next.queryKey
  ) {
    return { ...next };
  }
  const latest = next.targetRevision >= current.targetRevision ? next : current;
  const strongest = INTENT_PRIORITY[next.kind] >= INTENT_PRIORITY[current.kind] ? next.kind : current.kind;
  const bootstrapRevisions = [current.bootstrapRevision, next.bootstrapRevision].filter(
    (revision) => revision !== undefined,
  );
  return {
    ...latest,
    ...(bootstrapRevisions.length > 0 ? { bootstrapRevision: Math.max(...bootstrapRevisions) } : {}),
    includesFeedIngest: current.includesFeedIngest || next.includesFeedIngest,
    feedSnapshotBefore: current.feedSnapshotBefore ?? next.feedSnapshotBefore,
    kind: strongest,
    membershipReconcile: current.membershipReconcile === true || next.membershipReconcile === true,
    revisionReset: current.revisionReset || next.revisionReset,
    scopeChanged: current.scopeChanged === true || next.scopeChanged === true,
    targetRevision: Math.max(current.targetRevision, next.targetRevision),
  };
}
