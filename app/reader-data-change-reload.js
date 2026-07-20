// @ts-check

import { hasReadFilteredMembership } from './article-filter.js';
import {
  newArticlesQueryKey,
  raiseNewArticlesAvailability,
  shouldFreezeFeedIngest,
  shouldHoldFeedIngestRows,
} from './new-articles-availability.js';
import { loadArticles, prepareScopeArticleReset } from './reader-article-loader.js';
import { readerQueryAffectedByFeedSnapshot } from './reader-feed-snapshot-impact.js';
import { raiseReaderPageRevisionFloor } from './reader-revision-floor.js';
import { rememberReaderScroll } from './reader-scroll-state.js';
import { announceStatus } from './toasts.js';

/**
 * @typedef {object} DataChangeReloadActions
 * @property {() => Promise<{loaded: boolean, scopeChanged: boolean}>} loadBootstrapSnapshot
 * @property {() => boolean} [intentCovered]
 */

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./data-change-events.js').DataChange} change
 * @param {'none' | 'snapshot' | 'preserve' | 'replace'} kind
 */
export function shouldKeepFilteredReadRow(input, change, kind) {
  const state = input.getState();
  return (
    kind === 'preserve' &&
    change.reason === 'article-read-state' &&
    !change.revisionReset &&
    (input.getArticleState().status === 'ready' || input.getArticleState().status === 'empty') &&
    hasReadFilteredMembership(state, input.getArticleState())
  );
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {{dataRevision: number, feedSnapshotBefore?: import('./api-validation.js').BootstrapSnapshot, includesFeedIngest: boolean, kind: 'snapshot' | 'preserve' | 'replace', membershipReconcile: boolean, revisionReset: boolean}} plan
 * @param {number} scopeSequence
 * @param {DataChangeReloadActions} actions
 * @returns {Promise<import('./reader-refresh-plan.js').ReaderRefreshOutcome>}
 */
export async function reloadReaderForDataChange(input, runtime, plan, scopeSequence, actions) {
  const stateAtStart = input.getState();
  const articleStateAtStart = input.getArticleState();
  const snapshotAtStart = plan.feedSnapshotBefore ?? input.getSnapshot();
  const scopeAtStart = scopeSignature(stateAtStart?.activeScope);
  const queryKeyAtStart = stateAtStart ? newArticlesQueryKey(stateAtStart, articleStateAtStart) : '';
  const scopeCurrent = articleStateAtStart.newArticlesAvailable?.busy
    ? scopeSequence === runtime.scopeSequence
    : await rememberReaderScrollForDataChange(input, runtime, scopeSequence);
  const freezePrepared = shouldPrepareReadyRowsFreeze(input, plan, scopeCurrent);
  if (freezePrepared) setReadyRowsFreeze(input, true);
  const snapshotResult = await actions.loadBootstrapSnapshot();
  if (!snapshotResult.loaded) {
    if (freezePrepared) setReadyRowsFreeze(input, false);
    return 'ignored';
  }
  if (!scopeCurrent || scopeSequence !== runtime.scopeSequence) {
    if (freezePrepared) setReadyRowsFreeze(input, false);
    return 'ignored';
  }
  const scopeAfterSnapshot = scopeSignature(input.getState()?.activeScope);
  if (!snapshotResult.scopeChanged && scopeAtStart !== scopeAfterSnapshot) {
    if (freezePrepared) setReadyRowsFreeze(input, false);
    return 'ignored';
  }
  if (!snapshotResult.scopeChanged && actions.intentCovered?.()) {
    if (freezePrepared) setReadyRowsFreeze(input, false);
    return 'ignored';
  }
  const feedQueryAffected = readerQueryAffectedByFeedSnapshot(
    snapshotAtStart,
    input.getSnapshot(),
    input.getState(),
    input.getArticleState(),
  );
  const effectiveKind = feedQueryAffected ? 'preserve' : plan.kind;
  if (effectiveKind === 'replace' && input.getState()?.mode === 'reader') {
    prepareScopeArticleReset(input, runtime, { deferLoadingStatus: true });
  }
  const scopeChanged = snapshotResult.scopeChanged;
  const stateAfterSnapshot = input.getState();
  const articleStateAfterSnapshot = input.getArticleState();
  const queryKeyAfterSnapshot = stateAfterSnapshot
    ? newArticlesQueryKey(stateAfterSnapshot, articleStateAfterSnapshot)
    : '';
  if (!scopeChanged && queryKeyAtStart !== queryKeyAfterSnapshot) {
    if (freezePrepared) setReadyRowsFreeze(input, false);
    return 'ignored';
  }
  if (effectiveKind !== 'snapshot' && plan.membershipReconcile) {
    raiseReaderPageRevisionFloor(runtime, queryKeyAfterSnapshot, plan.dataRevision, true);
  }
  if (
    effectiveKind !== 'snapshot' &&
    (feedQueryAffected || plan.membershipReconcile || plan.revisionReset) &&
    (stateAfterSnapshot?.mode !== 'reader' || input.options.documentRef.hidden === true)
  ) {
    if (stateAfterSnapshot) {
      runtime.refreshCoordinator.defer({
        bootstrapRevision: input.getSnapshot().dataRevision,
        feedSnapshotBefore: snapshotAtStart,
        includesFeedIngest: false,
        kind: plan.revisionReset ? 'hard-reset' : 'reconcile',
        membershipReconcile: plan.membershipReconcile || feedQueryAffected || scopeChanged,
        queryKey: queryKeyAfterSnapshot,
        readerEpoch: runtime.refreshCoordinator.readerEpoch(),
        revisionReset: plan.revisionReset,
        scopeSequence,
        targetRevision: plan.dataRevision,
      });
    }
    if (freezePrepared) setReadyRowsFreeze(input, false);
    return 'deferred';
  }
  if (stateAfterSnapshot) {
    const feedIngestContext = {
      articleState: articleStateAfterSnapshot,
      includesFeedIngest: plan.includesFeedIngest && effectiveKind === 'preserve' && !feedQueryAffected,
      queryKeyAfter: queryKeyAfterSnapshot,
      queryKeyBefore: queryKeyAtStart,
      revisionReset: plan.revisionReset,
      scopeChanged,
      state: stateAfterSnapshot,
    };
    if (shouldHoldFeedIngestRows(feedIngestContext)) {
      const cachedPage = runtime.pageCache.peek(queryKeyAfterSnapshot);
      const firstPageCoversRevision =
        !articleStateAfterSnapshot.searchActive &&
        cachedPage !== null &&
        !cachedPage.stale &&
        cachedPage.dataRevision >= plan.dataRevision &&
        cachedPage.availabilityRevision === 0;
      const availabilityRaised = shouldFreezeFeedIngest(feedIngestContext) && !firstPageCoversRevision;
      if (availabilityRaised) {
        input.setArticleState(
          raiseNewArticlesAvailability(articleStateAfterSnapshot, queryKeyAfterSnapshot, plan.dataRevision),
        );
      } else if (freezePrepared) {
        setReadyRowsFreeze(input, false);
      }
      return availabilityRaised ? 'availability-raised' : 'snapshot-only';
    }
  }
  if (freezePrepared) setReadyRowsFreeze(input, false);
  let rowsReloaded = false;
  if (effectiveKind !== 'snapshot' || scopeChanged) {
    if (input.getState()?.mode === 'reader') {
      if (input.options.documentRef.hidden !== true) {
        rowsReloaded = await loadArticles(input, runtime, 'reset', {
          deferLoadingStatus: effectiveKind === 'replace' || scopeChanged,
          membershipReconcile: plan.membershipReconcile || scopeChanged,
          preserveResolvedOnError: effectiveKind === 'preserve' && !scopeChanged,
          preserveRows: effectiveKind === 'preserve' && !scopeChanged,
          revisionReset: plan.revisionReset,
        });
      }
    }
  }
  if (rowsReloaded) {
    if (plan.revisionReset) return 'hard-reset';
    if (input.getState()?.mode === 'reader' && input.options.documentRef.hidden !== true) {
      announceStatus(input.options.documentRef, input.options.browserApi.i18n.getMessage('articlesRefreshed'));
    }
    return 'rows-reloaded';
  }
  return 'snapshot-only';
}

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {{dataRevision: number, feedSnapshotBefore?: import('./api-validation.js').BootstrapSnapshot, includesFeedIngest: boolean, kind: 'snapshot' | 'preserve' | 'replace', membershipReconcile: boolean, revisionReset: boolean}} plan
 * @param {boolean} scopeCurrent
 */
function shouldPrepareReadyRowsFreeze(input, plan, scopeCurrent) {
  const state = input.getState();
  return (
    scopeCurrent &&
    plan.includesFeedIngest &&
    plan.kind === 'preserve' &&
    state?.mode === 'reader' &&
    input.options.documentRef.hidden !== true &&
    input.getArticleState().status === 'ready'
  );
}

/** @param {import('./reader-controller.js').ReaderControllerInput} input @param {boolean} frozen */
function setReadyRowsFreeze(input, frozen) {
  const current = input.getArticleState();
  if (current.freezeReadyRows === frozen) return;
  input.setArticleState({ ...current, freezeReadyRows: frozen });
}

/** @param {import('./reader-controller.js').ReaderControllerInput} input @param {import('./reader-controller.js').ReaderRuntime} runtime @param {number} scopeSequence */
async function rememberReaderScrollForDataChange(input, runtime, scopeSequence) {
  await rememberReaderScroll(input.options.documentRef, input);
  if (scopeSequence === runtime.scopeSequence) return true;
  return false;
}

/** @param {import('../domain/scopes.js').Scope | null | undefined} scope */
const scopeSignature = (scope) => (scope ? `${scope.type}:${scope.id}` : '');
