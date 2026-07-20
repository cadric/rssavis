// @ts-check

import { normalizeSearchText } from '../domain/text.js';
import { SEARCH_MIN_CODE_POINTS } from './reader-search-identity.js';

/**
 * @typedef {{categoryId?: string, id?: string, mainStreamState?: number, title?: string}} FeedSnapshot
 * @typedef {{feeds?: FeedSnapshot[]}} SnapshotLike
 * @typedef {{activeScope: import('../domain/scopes.js').Scope, mode?: string}} ReaderStateLike
 * @typedef {{searchActive: boolean, searchQuery: string}} ArticleStateLike
 */

/**
 * @param {SnapshotLike} before
 * @param {SnapshotLike} after
 * @param {ReaderStateLike | null | undefined} state
 * @param {ArticleStateLike} articleState
 */
export function readerQueryAffectedByFeedSnapshot(before, after, state, articleState) {
  if (!state) return false;
  const changes = changedExistingFeeds(before, after);
  const membershipChanged = scopeMembershipChanged(changes, state.activeScope);
  if (articleState.searchActive) {
    const query = normalizeSearchText(articleState.searchQuery);
    return (
      [...query].length >= SEARCH_MIN_CODE_POINTS &&
      (membershipChanged ||
        changes.some(({ previous, next }) => titleMatch(previous, query) !== titleMatch(next, query)))
    );
  }
  return membershipChanged;
}

/** @param {Array<{previous: FeedSnapshot, next: FeedSnapshot}>} changes @param {import('../domain/scopes.js').Scope} scope */
function scopeMembershipChanged(changes, scope) {
  if (scope.type === 'category') {
    return changes.some(
      ({ previous, next }) =>
        previous.categoryId !== next.categoryId && (previous.categoryId === scope.id || next.categoryId === scope.id),
    );
  }
  return (
    scope.type === 'system' &&
    scope.id === 'main' &&
    changes.some(({ previous, next }) => previous.mainStreamState !== next.mainStreamState)
  );
}

/**
 * @param {{markStale(queryKey: string): void, values(): Array<{queryKey: string, scope: import('../domain/scopes.js').Scope}>}} pageCache
 * @param {SnapshotLike} before
 * @param {SnapshotLike} after
 */
export function markFeedMembershipCacheStale(pageCache, before, after) {
  const changes = changedExistingFeeds(before, after);
  if (changes.length === 0) return;
  for (const entry of pageCache.values()) {
    const affected =
      entry.scope.type === 'category'
        ? changes.some(
            ({ previous, next }) =>
              previous.categoryId !== next.categoryId &&
              (previous.categoryId === entry.scope.id || next.categoryId === entry.scope.id),
          )
        : entry.scope.type === 'system' &&
          entry.scope.id === 'main' &&
          changes.some(({ previous, next }) => previous.mainStreamState !== next.mainStreamState);
    if (affected) pageCache.markStale(entry.queryKey);
  }
}

/** @param {SnapshotLike} before @param {SnapshotLike} after */
function changedExistingFeeds(before, after) {
  const previousById = new Map((before.feeds ?? []).map((feed) => [feed.id ?? '', feed]));
  const changes = [];
  for (const next of after.feeds ?? []) {
    const previous = previousById.get(next.id ?? '');
    if (previous && !sameRelevantFields(previous, next)) changes.push({ previous, next });
  }
  return changes;
}

/** @param {FeedSnapshot} left @param {FeedSnapshot} right */
function sameRelevantFields(left, right) {
  return (
    left.categoryId === right.categoryId && left.mainStreamState === right.mainStreamState && left.title === right.title
  );
}

/** @param {FeedSnapshot} feed @param {string} query */
function titleMatch(feed, query) {
  return normalizeSearchText(feed.title ?? '').includes(query);
}
