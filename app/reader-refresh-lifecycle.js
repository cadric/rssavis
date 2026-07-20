// @ts-check

import { effectiveArticleFilter, hasReadFilteredMembership } from './article-filter.js';
import { applyAuthoritativeArticleFlags, loadAuthoritativeArticleFlags } from './reader-authoritative-article-flags.js';
import { classifyDataChangeReload, isDataChangeRelevant, parseDataChangedEvent } from './data-change-events.js';
import { loadBootstrapSnapshot, rememberReaderScrollState } from './reader-bootstrap.js';
import { raiseNewArticlesAvailability } from './new-articles-availability.js';
import { invalidateArticleLoad } from './reader-load-generation.js';
import { reloadReaderForDataChange, shouldKeepFilteredReadRow } from './reader-data-change-reload.js';
import { raiseReaderPageRevisionFloor } from './reader-revision-floor.js';
import { createReaderRefreshCoordinator } from './reader-refresh-coordinator.js';
import {
  currentReaderRefreshIntent,
  isMembershipNeutralArticleFlagChange,
  isReaderRefreshIntentCovered,
  refreshKindForDataChange,
  reloadKindForReaderIntent,
  updateReaderCachedPages,
} from './reader-refresh-intents.js';
import { readerQueryKey } from './reader-refresh-plan.js';

/**
 * @typedef {import('./reader-controller.js').ReaderControllerInput} ReaderControllerInput
 * @typedef {import('./reader-controller.js').ReaderRuntime} ReaderRuntime
 * @typedef {{articleFlagEventRevisions: Map<string, number>, bootstrapAttemptGeneration: number, dataEventGeneration: number, input: ReaderControllerInput, lastDataEventRevision: number, observedDataRevision: number, recoveryStatusPending: boolean, revisionResetObserved: boolean, runtime: ReaderRuntime}} RefreshContext
 */

/** @param {ReaderControllerInput} input @param {ReaderRuntime} runtime */
export function createReaderRefreshLifecycle(input, runtime) {
  const context = {
    articleFlagEventRevisions: new Map(),
    bootstrapAttemptGeneration: 0,
    dataEventGeneration: 0,
    input,
    lastDataEventRevision: 0,
    observedDataRevision: 0,
    recoveryStatusPending: false,
    revisionResetObserved: false,
    runtime,
  };
  const markRecoveryStatusPending = () => markRecoveryPending(context);
  runtime.refreshCoordinator = createReaderRefreshCoordinator({
    execute: (intent) => executeScheduledIntent(context, intent),
  });
  return {
    handleDataChangedEvent: (/** @type {unknown} */ event) => handleDataChangedEvent(context, event),
    markRecoveryStatusPending,
    reloadReaderAfterVisibility: () => reloadReaderAfterVisibility(context),
    resumeDeferredWork: () => runtime.refreshCoordinator.resume(),
    shouldAnnounceReadyStatus() {
      const shouldAnnounce = !context.recoveryStatusPending;
      context.recoveryStatusPending = false;
      return shouldAnnounce;
    },
  };
}

/** @param {RefreshContext} context @param {import('./reader-refresh-plan.js').ReaderRefreshIntent} intent */
async function executeScheduledIntent(context, intent) {
  const { input, runtime } = context;
  if (isReaderRefreshIntentCovered(input, runtime, intent)) return 'ignored';
  const readerAvailable = input.getState()?.mode === 'reader' && input.options.documentRef.hidden !== true;
  if (!readerAvailable && (intent.kind === 'reconcile' || intent.kind === 'hard-reset')) {
    const outcome = await executeRefreshIntent(context, intent, 'snapshot');
    runtime.refreshCoordinator.defer(
      outcome === 'snapshot-only' ? { ...intent, bootstrapRevision: input.getSnapshot().dataRevision } : intent,
    );
    return 'deferred';
  }
  if (context.revisionResetObserved && !intent.revisionReset) {
    let appliedRevision = intent.bootstrapRevision ?? input.getSnapshot().dataRevision;
    if (appliedRevision < intent.targetRevision) {
      const snapshotResult = await loadBootstrapSnapshot(input, runtime, () => markRecoveryPending(context), {
        preserveResolvedOnError: true,
      });
      if (!snapshotResult.loaded) return 'ignored';
      appliedRevision = input.getSnapshot().dataRevision;
    }
    if (appliedRevision < intent.targetRevision) return 'ignored';
    context.observedDataRevision = appliedRevision;
    context.revisionResetObserved = false;
    context.lastDataEventRevision = appliedRevision;
    return executeRefreshIntentAfterBootstrap(context, intent);
  }
  const appliedRevision =
    intent.bootstrapRevision ?? (intent.revisionReset ? undefined : input.getSnapshot().dataRevision);
  return appliedRevision !== undefined && appliedRevision >= intent.targetRevision
    ? executeRefreshIntentAfterBootstrap(context, intent)
    : executeRefreshIntent(context, intent, reloadKindForReaderIntent(intent.kind));
}

/** @param {RefreshContext} context */
async function reloadReaderAfterVisibility(context) {
  const { input, runtime } = context;
  if (runtime.refreshCoordinator.hasDeferred()) {
    const bootstrapAttemptGeneration = context.bootstrapAttemptGeneration;
    await runtime.refreshCoordinator.resume();
    if (context.bootstrapAttemptGeneration !== bootstrapAttemptGeneration) return;
  }
  const knownRevision = context.revisionResetObserved
    ? context.observedDataRevision
    : Math.max(input.getSnapshot().dataRevision, context.observedDataRevision);
  const dataEventGenerationAtStart = context.dataEventGeneration;
  await rememberReaderScrollState(input);
  context.bootstrapAttemptGeneration += 1;
  const snapshotResult = await loadBootstrapSnapshot(input, runtime, () => markRecoveryPending(context), {
    preserveResolvedOnError: true,
  });
  if (!snapshotResult.loaded) return;
  const currentRevision = input.getSnapshot().dataRevision;
  restoreCachedAvailability(input, runtime, currentRevision);
  const eventOwnsCurrentRevision =
    !context.revisionResetObserved &&
    context.dataEventGeneration !== dataEventGenerationAtStart &&
    context.observedDataRevision >= currentRevision;
  if (eventOwnsCurrentRevision) return;
  const revisionReset = currentRevision < knownRevision;
  if (revisionReset) runtime.pageCache.clear();
  const currentState = input.getState();
  const currentArticles = input.getArticleState();
  const currentQueryKey = currentState ? readerQueryKey(currentState, currentArticles) : '';
  const currentCachedPage = currentArticles.searchActive ? null : runtime.pageCache.peek(currentQueryKey);
  const currentRowsRevision = currentArticles.searchActive
    ? currentArticles.dataRevision
    : currentCachedPage !== null && !currentCachedPage.stale
      ? currentCachedPage.dataRevision
      : -1;
  const pendingRevisionFloor = runtime.pageRevisionFloors.get(currentQueryKey) ?? 0;
  const reloadRequired =
    snapshotResult.scopeChanged ||
    revisionReset ||
    currentRevision > knownRevision ||
    pendingRevisionFloor > currentRowsRevision;
  if (reloadRequired && currentState) {
    const articleState = currentArticles;
    const queryKey = currentQueryKey;
    const targetRevision = Math.max(currentRevision, pendingRevisionFloor);
    const availabilityAlreadyOwnsRows =
      !snapshotResult.scopeChanged && !revisionReset && articleState.newArticlesAvailable?.queryKey === queryKey;
    if (availabilityAlreadyOwnsRows) {
      runtime.pageCache.raiseAvailability(queryKey, currentRevision);
      input.setArticleState(raiseNewArticlesAvailability(articleState, queryKey, currentRevision));
    } else {
      const activeCachedPage = articleState.searchActive ? null : runtime.pageCache.peek(queryKey);
      const activeRowsCoverRevision = articleState.searchActive
        ? articleState.dataRevision >= targetRevision
        : activeCachedPage !== null && !activeCachedPage.stale && activeCachedPage.dataRevision >= targetRevision;
      runtime.pageCache.markOlderThan(currentRevision);
      if (activeRowsCoverRevision) {
        context.observedDataRevision = Math.max(context.observedDataRevision, currentRevision);
        return;
      }
      raiseReaderPageRevisionFloor(runtime, queryKey, targetRevision);
      const intent = {
        ...currentReaderRefreshIntent(
          runtime,
          currentState,
          articleState,
          targetRevision,
          snapshotResult.scopeChanged || revisionReset,
          currentRevision,
          revisionReset,
          snapshotResult.scopeChanged,
        ),
        membershipReconcile: runtime.membershipReconcileQueryKeys.has(queryKey),
      };
      if (currentState.mode === 'reader' && input.options.documentRef.hidden !== true) {
        await runtime.refreshCoordinator.schedule(intent);
      } else {
        runtime.refreshCoordinator.defer(intent);
      }
    }
  }
  context.observedDataRevision = Math.max(context.observedDataRevision, currentRevision);
}

/** @param {RefreshContext} context @param {unknown} event */
async function handleDataChangedEvent(context, event) {
  const { input, runtime } = context;
  const parsed = parseDataChangedEvent(event);
  context.dataEventGeneration += 1;
  if (!parsed.change.revisionReset && parsed.dataRevision <= context.lastDataEventRevision) return;
  const relevant = isDataChangeRelevant(input.getState()?.activeScope ?? null, parsed.change, {
    filteredReadMembership: hasReadFilteredMembership(input.getState(), input.getArticleState()),
    snapshot: input.getSnapshot(),
  });
  recordObservedRevision(context, parsed.dataRevision, parsed.change.revisionReset);
  const authoritativeArticles = isArticleFlagChange(parsed.change)
    ? await loadAuthoritativeArticleFlags(context, parsed)
    : null;
  updateReaderCachedPages(
    runtime.pageCache,
    parsed.change,
    parsed.dataRevision,
    input.getSnapshot(),
    input.getArticleState(),
    authoritativeArticles,
  );
  applyAuthoritativeArticleFlags(input, parsed.change.reason, authoritativeArticles);
  if (relevant && parsed.change.reason === 'feed-ingest') {
    runtime.feedIngestGeneration += 1;
    raiseCurrentAvailabilityRevision(input, parsed.dataRevision);
  }
  let kind = classifyDataChangeReload(parsed.change);
  if (kind === 'none') return;
  const currentState = input.getState();
  if (relevant && shouldRaisePageRevisionFloor(currentState, input.getArticleState(), parsed.change.reason, kind)) {
    raiseReaderPageRevisionFloor(
      runtime,
      currentState ? readerQueryKey(currentState, input.getArticleState()) : '',
      parsed.dataRevision,
      kind === 'replace',
    );
  }
  if (!relevant) kind = 'snapshot';
  if (kind === 'replace' && input.getArticleState().newArticlesAvailable) {
    input.setArticleState({ ...input.getArticleState(), freezeReadyRows: false, newArticlesAvailable: null });
  }
  if (shouldKeepFilteredReadRow(input, parsed.change, kind)) {
    runtime.filterMembershipGeneration += 1;
    if (currentState) {
      runtime.stickyMembershipQueryKeys.add(readerQueryKey(currentState, input.getArticleState()));
    }
    kind = 'snapshot';
  } else if (isMembershipNeutralArticleFlagChange(input, parsed.change)) kind = 'snapshot';
  await runtime.refreshCoordinator.schedule({
    feedSnapshotBefore: input.getSnapshot(),
    includesFeedIngest: relevant && parsed.change.reason === 'feed-ingest',
    kind: refreshKindForDataChange(kind, parsed.change.reason, parsed.change.revisionReset),
    membershipReconcile:
      relevant &&
      parsed.change.reason !== 'article-read-state' &&
      parsed.change.reason !== 'article-starred-state' &&
      parsed.change.reason !== 'feed-ingest',
    queryKey: currentState ? readerQueryKey(currentState, input.getArticleState()) : '',
    readerEpoch: runtime.refreshCoordinator.readerEpoch(),
    revisionReset: parsed.change.revisionReset,
    scopeSequence: runtime.scopeSequence,
    targetRevision: parsed.dataRevision,
  });
}

/** @param {RefreshContext} context @param {number} dataRevision @param {boolean} revisionReset */
function recordObservedRevision(context, dataRevision, revisionReset) {
  if (revisionReset) {
    context.lastDataEventRevision = dataRevision;
    invalidateArticleLoad(context.input, context.runtime);
    context.revisionResetObserved = true;
    context.observedDataRevision = dataRevision;
    context.runtime.pageCache.clear();
    context.runtime.pageRevisionFloors.clear();
    context.runtime.membershipReconcileQueryKeys.clear();
    context.runtime.snapshotRevisionFloor = 0;
    const articleState = context.input.getArticleState();
    if (articleState.newArticlesAvailable) {
      context.input.setArticleState({ ...articleState, freezeReadyRows: false, newArticlesAvailable: null });
    }
  } else {
    if (!context.revisionResetObserved) context.lastDataEventRevision = dataRevision;
    context.observedDataRevision = Math.max(context.observedDataRevision, dataRevision);
    if (!context.revisionResetObserved) {
      context.runtime.snapshotRevisionFloor = Math.max(context.runtime.snapshotRevisionFloor, dataRevision);
    }
  }
}

/** @param {import('./data-change-events.js').DataChange} change */
function isArticleFlagChange(change) {
  return change.reason === 'article-read-state' || change.reason === 'article-starred-state';
}

/** @param {ReturnType<ReaderControllerInput['getState']>} state @param {import('./reader-state.js').ArticleState} articleState @param {string} reason @param {'none' | 'snapshot' | 'preserve' | 'replace'} kind */
function shouldRaisePageRevisionFloor(state, articleState, reason, kind) {
  if (!state || articleState.searchActive || (kind !== 'preserve' && kind !== 'replace')) return false;
  if (reason === 'feed-ingest' || reason === 'article-read-state' || reason === 'article-starred-state') {
    return false;
  }
  return effectiveArticleFilter(state, articleState) !== 'read' || kind === 'replace';
}

/** @param {RefreshContext} context @param {import('./reader-refresh-plan.js').ReaderRefreshIntent} intent @param {'snapshot' | 'preserve' | 'replace'} kind */
function executeRefreshIntent(context, intent, kind) {
  const { input, runtime } = context;
  return reloadReaderForDataChange(
    input,
    runtime,
    {
      dataRevision: intent.targetRevision,
      feedSnapshotBefore: intent.feedSnapshotBefore,
      includesFeedIngest: intent.includesFeedIngest,
      kind,
      membershipReconcile: intent.membershipReconcile === true,
      revisionReset: intent.revisionReset,
    },
    intent.scopeSequence,
    {
      intentCovered: () => isReaderRefreshIntentCovered(input, runtime, intent),
      loadBootstrapSnapshot: () => loadBootstrapSnapshotForIntent(context, intent),
    },
  );
}

/** @param {RefreshContext} context @param {import('./reader-refresh-plan.js').ReaderRefreshIntent} intent */
async function loadBootstrapSnapshotForIntent(context, intent) {
  const { input, runtime } = context;
  context.bootstrapAttemptGeneration += 1;
  const first = await loadBootstrapSnapshot(input, runtime, () => markRecoveryPending(context), {
    preserveResolvedOnError: true,
  });
  if (!first.loaded || intent.revisionReset || input.getSnapshot().dataRevision >= intent.targetRevision) return first;
  context.bootstrapAttemptGeneration += 1;
  const current = await loadBootstrapSnapshot(input, runtime, () => markRecoveryPending(context), {
    preserveResolvedOnError: true,
  });
  return { loaded: current.loaded, scopeChanged: first.scopeChanged || current.scopeChanged };
}

/** @param {RefreshContext} context @param {import('./reader-refresh-plan.js').ReaderRefreshIntent} intent */
function executeRefreshIntentAfterBootstrap(context, intent) {
  const { input, runtime } = context;
  return reloadReaderForDataChange(
    input,
    runtime,
    {
      dataRevision: intent.targetRevision,
      feedSnapshotBefore: intent.feedSnapshotBefore,
      includesFeedIngest: intent.includesFeedIngest,
      kind: reloadKindForReaderIntent(intent.kind),
      membershipReconcile: intent.membershipReconcile === true,
      revisionReset: intent.revisionReset,
    },
    intent.scopeSequence,
    {
      intentCovered: () => isReaderRefreshIntentCovered(input, runtime, intent),
      loadBootstrapSnapshot: async () => ({ loaded: true, scopeChanged: intent.scopeChanged === true }),
    },
  ).catch((error) => {
    markRecoveryPending(context);
    throw error;
  });
}

/** @param {RefreshContext} context */
function markRecoveryPending(context) {
  context.recoveryStatusPending = true;
}

/** @param {ReaderControllerInput} input @param {number} dataRevision */
function raiseCurrentAvailabilityRevision(input, dataRevision) {
  const state = input.getState();
  const articleState = input.getArticleState();
  if (!state || !articleState.newArticlesAvailable) return;
  const queryKey = readerQueryKey(state, articleState);
  if (articleState.newArticlesAvailable.queryKey !== queryKey) return;
  input.setArticleState(raiseNewArticlesAvailability(articleState, queryKey, dataRevision));
}

/**
 * A known ingest may have updated the page cache before its bootstrap failed.
 * Once a later visibility probe reaches that revision, materialize the cached
 * availability without querying or replacing the resolved list.
 * @param {ReaderControllerInput} input
 * @param {ReaderRuntime} runtime
 * @param {number} snapshotRevision
 */
function restoreCachedAvailability(input, runtime, snapshotRevision) {
  const state = input.getState();
  const articleState = input.getArticleState();
  if (!state || state.mode !== 'reader' || articleState.searchActive) return;
  const queryKey = readerQueryKey(state, articleState);
  const cached = runtime.pageCache.peek(queryKey);
  if (!cached || cached.availabilityRevision <= 0 || cached.availabilityRevision > snapshotRevision) return;
  const currentRevision =
    articleState.newArticlesAvailable?.queryKey === queryKey ? articleState.newArticlesAvailable.dataRevision : 0;
  if (currentRevision >= cached.availabilityRevision) return;
  input.setArticleState(raiseNewArticlesAvailability(articleState, queryKey, cached.availabilityRevision));
}
