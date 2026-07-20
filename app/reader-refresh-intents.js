// @ts-check

import { hasReadFilteredMembership } from './article-filter.js';
import { classifyDataChangeReload, isDataChangeRelevant } from './data-change-events.js';
import { readerQueryKey } from './reader-refresh-plan.js';

/**
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {NonNullable<ReturnType<import('./reader-controller.js').ReaderControllerInput['getState']>>} state
 * @param {import('./reader-state.js').ArticleState} articleState
 * @param {number} targetRevision
 * @param {boolean} hardReset
 * @param {number} [bootstrapRevision]
 * @param {boolean} [revisionReset]
 * @param {boolean} [scopeChanged]
 * @returns {import('./reader-refresh-plan.js').ReaderRefreshIntent}
 */
export function currentReaderRefreshIntent(
  runtime,
  state,
  articleState,
  targetRevision,
  hardReset,
  bootstrapRevision,
  revisionReset = hardReset,
  scopeChanged = false,
) {
  return {
    ...(bootstrapRevision === undefined ? {} : { bootstrapRevision }),
    includesFeedIngest: false,
    kind: hardReset ? 'hard-reset' : 'reconcile',
    membershipReconcile: hardReset || scopeChanged,
    queryKey: readerQueryKey(state, articleState),
    readerEpoch: runtime.refreshCoordinator.readerEpoch(),
    revisionReset,
    scopeChanged,
    scopeSequence: runtime.scopeSequence,
    targetRevision,
  };
}

/**
 * @param {'none' | 'snapshot' | 'preserve' | 'replace'} kind
 * @param {string} reason
 * @param {boolean} revisionReset
 * @returns {import('./reader-refresh-plan.js').ReaderRefreshKind}
 */
export function refreshKindForDataChange(kind, reason, revisionReset) {
  if (revisionReset) return 'hard-reset';
  if (kind === 'snapshot' || kind === 'none') return 'snapshot';
  if (reason === 'feed-ingest') return 'availability';
  return 'reconcile';
}

/** @param {import('./reader-refresh-plan.js').ReaderRefreshKind} kind */
export function reloadKindForReaderIntent(kind) {
  if (kind === 'hard-reset') return /** @type {const} */ ('replace');
  if (kind === 'snapshot') return /** @type {const} */ ('snapshot');
  return /** @type {const} */ ('preserve');
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {import('./reader-refresh-plan.js').ReaderRefreshIntent} intent
 */
export function isReaderRefreshIntentCovered(input, runtime, intent) {
  if (intent.revisionReset) return false;
  const state = input.getState();
  if (!state || intent.scopeSequence !== runtime.scopeSequence) return true;
  if (intent.queryKey !== readerQueryKey(state, input.getArticleState())) return true;
  const snapshotRevision = input.getSnapshot().dataRevision;
  if (intent.targetRevision > snapshotRevision) return false;
  if ((runtime.pageRevisionFloors.get(intent.queryKey) ?? 0) >= intent.targetRevision) return false;
  if (intent.kind === 'snapshot' && intent.membershipReconcile !== true) {
    return intent.targetRevision <= snapshotRevision;
  }
  const articleState = input.getArticleState();
  if (articleState.searchActive && articleState.dataRevision >= intent.targetRevision) return true;
  const cached = runtime.pageCache.peek(intent.queryKey);
  if (intent.includesFeedIngest && cached && !cached.stale && cached.availabilityRevision > 0) {
    const available = input.getArticleState().newArticlesAvailable;
    return available?.queryKey === intent.queryKey && available.dataRevision >= cached.availabilityRevision;
  }
  return cached !== null && !cached.stale && intent.targetRevision <= cached.dataRevision;
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./data-change-events.js').DataChange} change
 */
export function isMembershipNeutralArticleFlagChange(input, change) {
  if (change.reason === 'article-read-state') {
    return !hasReadFilteredMembership(input.getState(), input.getArticleState());
  }
  if (change.reason !== 'article-starred-state') return false;
  const scope = input.getState()?.activeScope;
  return scope?.type !== 'system' || scope.id !== 'starred';
}

/**
 * @param {ReturnType<typeof import('./reader-page-cache.js').createReaderPageCache>} pageCache
 * @param {import('./data-change-events.js').DataChange} change
 * @param {number} dataRevision
 * @param {import('./api-validation.js').BootstrapSnapshot} snapshot
 * @param {import('./reader-state.js').ArticleState} articleState
 * @param {Map<string, Record<string, unknown>> | null} [authoritativeArticles]
 */
export function updateReaderCachedPages(
  pageCache,
  change,
  dataRevision,
  snapshot,
  articleState,
  authoritativeArticles = null,
) {
  if (change.revisionReset) return;
  const flagField =
    change.reason === 'article-read-state'
      ? /** @type {const} */ ('readState')
      : change.reason === 'article-starred-state'
        ? /** @type {const} */ ('starredState')
        : null;
  if (flagField && authoritativeArticles) {
    for (const [articleId, article] of authoritativeArticles) {
      pageCache.applyAuthoritativeArticleField(
        articleId,
        flagField,
        numberValue(article[flagField]),
        dataRevision,
        snapshot,
        article,
      );
    }
  }
  for (const entry of pageCache.values()) {
    const relevant = isDataChangeRelevant(entry.scope, change, {
      filteredReadMembership: entry.filter !== 'all' || (entry.scope.type === 'system' && entry.scope.id === 'unread'),
      snapshot,
    });
    if (!relevant) continue;
    if (change.reason === 'feed-ingest') {
      if (entry.filter !== 'read' && entry.dataRevision < dataRevision) {
        pageCache.raiseAvailability(entry.queryKey, dataRevision);
      }
      continue;
    }
    const filteredRead =
      change.reason === 'article-read-state' &&
      (entry.filter !== 'all' || (entry.scope.type === 'system' && entry.scope.id === 'unread'));
    const filteredStar =
      change.reason === 'article-starred-state' && entry.scope.type === 'system' && entry.scope.id === 'starred';
    if (change.reason === 'article-read-state' || change.reason === 'article-starred-state') {
      const field = change.reason === 'article-read-state' ? 'readState' : 'starredState';
      const currentById = new Map(articleState.items.map((item) => [item.id, item]));
      const changedIds = new Set(change.articleIds);
      if (changedIds.size > 0) {
        const entryContainsChange = entry.items.some((item) => changedIds.has(String(item.id)));
        const unresolvedChange = entry.items.some(
          (item) =>
            changedIds.has(String(item.id)) &&
            authoritativeArticles !== null &&
            !authoritativeArticles.has(String(item.id)),
        );
        if (filteredRead || filteredStar || unresolvedChange) {
          pageCache.markArticleFlagPending(entry.queryKey, dataRevision);
          continue;
        }
        if (authoritativeArticles !== null) {
          if (!entryContainsChange) pageCache.updatePage(entry.queryKey, { dataRevision });
          continue;
        }
        if (!entryContainsChange) {
          pageCache.updatePage(entry.queryKey, { dataRevision });
          continue;
        }
        let unresolved = false;
        const items = entry.items.map((item) => {
          if (!changedIds.has(String(item.id))) return item;
          const current = currentById.get(item.id);
          if (!current) {
            unresolved = true;
            return item;
          }
          return current[field] === item[field] ? item : { ...item, [field]: current[field] };
        });
        if (unresolved) pageCache.markStale(entry.queryKey);
        else pageCache.updatePage(entry.queryKey, { dataRevision, items });
        continue;
      }
      if (filteredRead || filteredStar) {
        pageCache.markArticleFlagPending(entry.queryKey, dataRevision);
        continue;
      }
      let matched = false;
      let patched = false;
      const items = entry.items.map((item) => {
        const current = currentById.get(item.id);
        if (!current) return item;
        matched = true;
        if (current[field] === item[field]) return item;
        patched = true;
        return { ...item, [field]: current[field] };
      });
      if (matched) pageCache.updatePage(entry.queryKey, { dataRevision, items: patched ? items : entry.items });
      else pageCache.markStale(entry.queryKey);
      continue;
    }
    if (classifyDataChangeReload(change) === 'replace') pageCache.markStale(entry.queryKey);
  }
}

/** @param {unknown} value */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
