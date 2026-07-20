// @ts-check

import { OPML_REFRESH_JOB_BATCH_SIZE, OPML_REFRESH_JOB_LEASE_MS } from '../data/opml-refresh-jobs.js';
import { refreshFeedList } from './refresh-queue.js';

/**
 * @typedef {object} OpmlRefreshJobRepository
 * @property {(input: {nowMs: number, leaseOwner: string, batchSize?: number, leaseMs?: number}) => Promise<Record<string, unknown>>} claimNext
 * @property {(feedIds: string[]) => Promise<{refreshFeedIds: string[], refreshFeeds: {id: string, resolvedUrl?: string, url?: string}[], skippedFeedIds: string[]}>} classifyFeedIds
 * @property {(input: {jobId: string, leaseOwner: string, processedCount: number, successCount?: number, failureCount?: number, skippedCount?: number, nowMs: number, leaseMs?: number, continueRunning?: boolean, lastErrorCode?: string | null}) => Promise<Record<string, unknown>>} checkpointChunk
 * @property {(input: {jobId: string, leaseOwner: string, processedCount: number, successCount?: number, failureCount?: number, skippedCount?: number, nowMs: number, lastErrorCode?: string | null}) => Promise<Record<string, unknown>>} completeChunk
 *
 * @typedef {object} OpmlRefreshService
 * @property {(input?: {maxChunks?: number}) => Promise<Record<string, unknown>>} processOpmlRefreshJobs
 *
 * @typedef {object} OpmlRefreshProcessorInput
 * @property {OpmlRefreshJobRepository} jobs
 * @property {(feedId: string) => Promise<Record<string, unknown>>} refreshOne
 * @property {() => number} now
 * @property {number} [batchSize]
 * @property {number} [concurrency]
 * @property {number} [maxChunks]
 * @property {() => string} [leaseOwnerFactory]
 */

/**
 * @param {unknown} refreshService
 * @param {{refreshJobId?: string | null, queuedFeedCount?: number}} importResult
 */
export async function startOpmlPostCommitWork(refreshService, importResult) {
  if (!importResult.refreshJobId || !isOpmlRefreshService(refreshService)) return { status: 'queued' };
  const result = await refreshService.processOpmlRefreshJobs({ maxChunks: 1 });
  return { status: result.status === 'idle' || result.status === 'locked' ? 'queued' : 'started' };
}

/**
 * @param {OpmlRefreshProcessorInput} input
 */
export async function processOpmlRefreshJobs(input) {
  const maxChunks = normalizePositiveInteger(input.maxChunks, 1);
  const batchSize = Math.min(normalizePositiveInteger(input.batchSize, OPML_REFRESH_JOB_BATCH_SIZE), 20);
  const concurrency = Math.min(normalizePositiveInteger(input.concurrency, 4), 4);
  const totals = createTotals();

  while (totals.chunks < maxChunks) {
    const leaseOwner = input.leaseOwnerFactory ? input.leaseOwnerFactory() : `opml-refresh-${crypto.randomUUID()}`;
    const claim = await input.jobs.claimNext({
      batchSize,
      leaseMs: OPML_REFRESH_JOB_LEASE_MS,
      leaseOwner,
      nowMs: input.now(),
    });
    if (claim.status !== 'claimed') return finishTotals(totals, String(claim.status));
    const feedIds = Array.isArray(claim.feedIds) ? claim.feedIds.map(String) : [];
    totals.chunks += 1;
    const completed = await processClaimedFeedIds(input, {
      concurrency,
      feedIds,
      jobId: String(claim.jobId),
      leaseOwner,
      totals,
    });
    if (completed.status === 'stale') return finishTotals(totals, 'stale');
    totals.completedJobs += completed.completed === true ? 1 : 0;
  }
  return finishTotals(totals, 'partial');
}

function createTotals() {
  return {
    chunks: 0,
    completedJobs: 0,
    failureCount: 0,
    processedFeedIds: /** @type {string[]} */ ([]),
    skippedCount: 0,
    successCount: 0,
  };
}

/**
 * @param {OpmlRefreshProcessorInput} input
 * @param {{concurrency: number, feedIds: string[], jobId: string, leaseOwner: string, totals: ReturnType<typeof createTotals>}} context
 */
async function processClaimedFeedIds(input, context) {
  let completed = /** @type {Record<string, unknown>} */ ({ completed: false, status: 'updated' });
  for (let index = 0; index < context.feedIds.length; index += context.concurrency) {
    const subBatch = context.feedIds.slice(index, index + context.concurrency);
    const continueRunning = index + context.concurrency < context.feedIds.length;
    const classified = await input.jobs.classifyFeedIds(subBatch);
    // Pass the resolved fetch host per feed so refreshFeedList can group a
    // same-host bulk import and space it politely instead of hammering the host.
    const refreshed = await refreshFeedList(classified.refreshFeeds, input.refreshOne, context.concurrency);
    const counted = countRefreshResults(refreshed.results, classified.skippedFeedIds.length);
    completed = await input.jobs.checkpointChunk({
      failureCount: counted.failureCount,
      jobId: context.jobId,
      lastErrorCode: counted.lastErrorCode,
      leaseMs: OPML_REFRESH_JOB_LEASE_MS,
      leaseOwner: context.leaseOwner,
      continueRunning,
      nowMs: input.now(),
      processedCount: subBatch.length,
      skippedCount: counted.skippedCount,
      successCount: counted.successCount,
    });
    accumulateTotals(context.totals, classified.refreshFeedIds, counted);
    if (completed.status === 'stale') return completed;
  }
  return completed;
}

/**
 * @param {ReturnType<typeof createTotals>} totals
 * @param {string[]} refreshFeedIds
 * @param {{successCount: number, failureCount: number, skippedCount: number, lastErrorCode: string | null}} counted
 */
function accumulateTotals(totals, refreshFeedIds, counted) {
  totals.failureCount += counted.failureCount;
  totals.skippedCount += counted.skippedCount;
  totals.successCount += counted.successCount;
  totals.processedFeedIds.push(...refreshFeedIds);
}

/**
 * @param {ReturnType<typeof createTotals>} totals
 * @param {string} status
 */
function finishTotals(totals, status) {
  const finalStatus =
    status === 'idle' && totals.chunks > 0
      ? 'completed'
      : status === 'partial' && totals.completedJobs > 0
        ? 'completed'
        : status === 'partial' || totals.chunks > 0
          ? 'partial'
          : status;
  return {
    completedJobs: totals.completedJobs,
    failureCount: totals.failureCount,
    processedFeedIds: totals.processedFeedIds,
    skippedCount: totals.skippedCount,
    status: finalStatus,
    successCount: totals.successCount,
  };
}

/**
 * @param {Record<string, unknown>[]} results
 * @param {number} preSkippedCount
 */
function countRefreshResults(results, preSkippedCount) {
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = preSkippedCount;
  let lastErrorCode = null;
  for (const result of results) {
    const status = String(result.status ?? '');
    if (status === 'refreshed' || status === 'not-modified') successCount += 1;
    else if (
      status === 'not-refreshable' ||
      status === 'redirect-permission-required' ||
      status === 'already-running'
    ) {
      skippedCount += 1;
    } else {
      failureCount += 1;
      if (!lastErrorCode && isRecord(result.error) && typeof result.error.code === 'string')
        lastErrorCode = result.error.code;
    }
  }
  return { failureCount, lastErrorCode, skippedCount, successCount };
}

/**
 * @param {unknown} value
 * @returns {value is OpmlRefreshService}
 */
function isOpmlRefreshService(value) {
  return isRecord(value) && typeof value.processOpmlRefreshJobs === 'function';
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * @param {number | undefined} value
 * @param {number} fallback
 */
function normalizePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
