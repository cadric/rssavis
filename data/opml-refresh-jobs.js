// @ts-check

import { DELETION_STATE, STORES } from './constants.js';
import {
  OPML_REFRESH_JOB_BATCH_SIZE,
  OPML_REFRESH_JOB_KEY_PREFIX,
  OPML_REFRESH_JOB_KIND,
  OPML_REFRESH_JOB_LEASE_MS,
  OPML_REFRESH_JOB_VERSION,
  OPML_REFRESH_QUEUE_KEY,
  normalizeCount,
  normalizeOpmlRefreshJobRecord,
  normalizePositiveInteger,
  requireNonNegativeInteger,
  requireString,
  requireStringArray,
  requireUuid,
} from './opml-refresh-job-model.js';
import { requestToPromise, runTransaction } from './transaction.js';

export {
  OPML_REFRESH_JOB_BATCH_SIZE,
  OPML_REFRESH_JOB_KEY_PREFIX,
  OPML_REFRESH_JOB_KIND,
  OPML_REFRESH_JOB_LEASE_MS,
  OPML_REFRESH_JOB_VERSION,
  OPML_REFRESH_QUEUE_KEY,
  normalizeOpmlRefreshJobRecord,
} from './opml-refresh-job-model.js';

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 *
 * @typedef {object} OpmlRefreshJobRecord
 * @property {string} key
 * @property {'opmlRefresh'} kind
 * @property {1} version
 * @property {string} jobId
 * @property {'queued' | 'running' | 'completed'} state
 * @property {string[]} feedIds
 * @property {number} cursor
 * @property {number} successCount
 * @property {number} failureCount
 * @property {number} skippedCount
 * @property {number} createdAtMs
 * @property {number} updatedAtMs
 * @property {string | null} leaseOwner
 * @property {number | null} leaseExpiresAtMs
 * @property {string | null} lastErrorCode
 */

/**
 * @param {RepositoryOptions} [options]
 */
export function createOpmlRefreshJobRepository(options = {}) {
  return {
    /** @param {{nowMs: number, leaseOwner: string, batchSize?: number, leaseMs?: number}} input */
    claimNext: (input) => claimNextOpmlRefreshJob(input, options),
    /** @param {string[]} feedIds */
    classifyFeedIds: (feedIds) => classifyFeedIds(feedIds, options),
    /** @param {{jobId: string, leaseOwner: string, processedCount: number, successCount?: number, failureCount?: number, skippedCount?: number, nowMs: number, leaseMs?: number, continueRunning?: boolean, lastErrorCode?: string | null}} input */
    checkpointChunk: (input) => checkpointOpmlRefreshJobChunk(input, options),
    /** @param {{jobId: string, leaseOwner: string, processedCount: number, successCount?: number, failureCount?: number, skippedCount?: number, nowMs: number, lastErrorCode?: string | null}} input */
    completeChunk: (input) => completeOpmlRefreshJobChunk(input, options),
  };
}

/**
 * @param {IDBTransaction} transaction
 * @param {string[]} feedIds
 * @param {number} nowMs
 * @returns {Promise<{refreshJobId: string | null, queuedFeedCount: number}>}
 */
export async function enqueueOpmlRefreshJob(transaction, feedIds, nowMs) {
  const uniqueFeedIds = [...new Set(feedIds.filter((feedId) => typeof feedId === 'string' && feedId.length > 0))];
  if (uniqueFeedIds.length === 0) return { refreshJobId: null, queuedFeedCount: 0 };
  const jobId = crypto.randomUUID();
  const job = normalizeOpmlRefreshJobRecord({
    key: OPML_REFRESH_JOB_KEY_PREFIX + jobId,
    kind: OPML_REFRESH_JOB_KIND,
    version: OPML_REFRESH_JOB_VERSION,
    jobId,
    state: 'queued',
    feedIds: uniqueFeedIds,
    cursor: 0,
    successCount: 0,
    failureCount: 0,
    skippedCount: 0,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    leaseOwner: null,
    leaseExpiresAtMs: null,
    lastErrorCode: null,
  });
  const meta = transaction.objectStore(STORES.META);
  const queue = await readQueue(meta);
  await requestToPromise(meta.put(job));
  await writeQueue(meta, [...queue, job.jobId]);
  return { refreshJobId: job.jobId, queuedFeedCount: job.feedIds.length };
}

/**
 * @param {{nowMs: number, leaseOwner: string, batchSize?: number, leaseMs?: number}} input
 * @param {RepositoryOptions} options
 */
async function claimNextOpmlRefreshJob(input, options) {
  return runTransaction(
    STORES.META,
    'readwrite',
    async (transaction) => {
      const meta = transaction.objectStore(STORES.META);
      const queue = await readQueue(meta);
      while (queue.length > 0) {
        const job = await readJob(meta, queue[0]);
        if (!job || job.state === 'completed') {
          queue.shift();
          await writeQueue(meta, queue);
          continue;
        }
        if (job.state === 'running' && (job.leaseExpiresAtMs ?? 0) > input.nowMs) {
          return { jobId: job.jobId, status: 'locked' };
        }
        const batchSize = Math.min(normalizePositiveInteger(input.batchSize, OPML_REFRESH_JOB_BATCH_SIZE), 20);
        const feedIds = job.feedIds.slice(job.cursor, job.cursor + batchSize);
        if (feedIds.length === 0) {
          const completed = normalizeOpmlRefreshJobRecord({ ...job, state: 'completed', updatedAtMs: input.nowMs });
          await requestToPromise(meta.put(completed));
          queue.shift();
          await writeQueue(meta, queue);
          continue;
        }
        const next = normalizeOpmlRefreshJobRecord({
          ...job,
          state: 'running',
          leaseOwner: requireString(input.leaseOwner, 'leaseOwner', 128),
          leaseExpiresAtMs: input.nowMs + normalizePositiveInteger(input.leaseMs, OPML_REFRESH_JOB_LEASE_MS),
          updatedAtMs: input.nowMs,
        });
        await requestToPromise(meta.put(next));
        return { cursor: job.cursor, feedIds, jobId: job.jobId, status: 'claimed' };
      }
      return { status: 'idle' };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {string[]} feedIds
 * @param {RepositoryOptions} options
 */
async function classifyFeedIds(feedIds, options) {
  return runTransaction(
    STORES.FEEDS,
    'readonly',
    async (transaction) => {
      const feeds = transaction.objectStore(STORES.FEEDS);
      /** @type {string[]} */
      const refreshFeedIds = [];
      /** @type {{id: string, resolvedUrl: string, url: string}[]} */
      const refreshFeeds = [];
      /** @type {string[]} */
      const skippedFeedIds = [];
      for (const feedId of feedIds) {
        const feed = await requestToPromise(feeds.get(feedId));
        if (!feed || feed.deletionState !== DELETION_STATE.ACTIVE) skippedFeedIds.push(feedId);
        else {
          refreshFeedIds.push(feedId);
          refreshFeeds.push({ id: feedId, resolvedUrl: feed.resolvedUrl ?? '', url: feed.url ?? '' });
        }
      }
      return { refreshFeedIds, refreshFeeds, skippedFeedIds };
    },
    options,
  );
}

/**
 * @param {{jobId: string, leaseOwner: string, processedCount: number, successCount?: number, failureCount?: number, skippedCount?: number, nowMs: number, lastErrorCode?: string | null}} input
 * @param {RepositoryOptions} options
 */
async function completeOpmlRefreshJobChunk(input, options) {
  return runTransaction(
    STORES.META,
    'readwrite',
    async (transaction) => {
      const meta = transaction.objectStore(STORES.META);
      const queue = await readQueue(meta);
      const job = await readJob(meta, input.jobId);
      if (!job || job.state !== 'running' || job.leaseOwner !== input.leaseOwner) return { status: 'stale' };
      const cursor = Math.min(
        job.cursor + requireNonNegativeInteger(input.processedCount, 'processedCount'),
        job.feedIds.length,
      );
      const completed = cursor >= job.feedIds.length;
      const next = normalizeOpmlRefreshJobRecord({
        ...job,
        cursor,
        successCount: job.successCount + normalizeCount(input.successCount),
        failureCount: job.failureCount + normalizeCount(input.failureCount),
        skippedCount: job.skippedCount + normalizeCount(input.skippedCount),
        state: completed ? 'completed' : 'queued',
        updatedAtMs: input.nowMs,
        leaseOwner: null,
        leaseExpiresAtMs: null,
        lastErrorCode: input.lastErrorCode ?? job.lastErrorCode,
      });
      await requestToPromise(meta.put(next));
      if (completed)
        await writeQueue(
          meta,
          queue.filter((jobId) => jobId !== job.jobId),
        );
      return { completed, job: next, status: 'updated' };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {{jobId: string, leaseOwner: string, processedCount: number, successCount?: number, failureCount?: number, skippedCount?: number, nowMs: number, leaseMs?: number, continueRunning?: boolean, lastErrorCode?: string | null}} input
 * @param {RepositoryOptions} options
 */
async function checkpointOpmlRefreshJobChunk(input, options) {
  return runTransaction(
    STORES.META,
    'readwrite',
    async (transaction) => {
      const meta = transaction.objectStore(STORES.META);
      const queue = await readQueue(meta);
      const job = await readJob(meta, input.jobId);
      if (!job || job.state !== 'running' || job.leaseOwner !== input.leaseOwner) return { status: 'stale' };
      const cursor = Math.min(
        job.cursor + requireNonNegativeInteger(input.processedCount, 'processedCount'),
        job.feedIds.length,
      );
      const completed = cursor >= job.feedIds.length;
      const keepLease = !completed && input.continueRunning === true;
      const next = normalizeOpmlRefreshJobRecord({
        ...job,
        cursor,
        successCount: job.successCount + normalizeCount(input.successCount),
        failureCount: job.failureCount + normalizeCount(input.failureCount),
        skippedCount: job.skippedCount + normalizeCount(input.skippedCount),
        state: completed ? 'completed' : keepLease ? 'running' : 'queued',
        updatedAtMs: input.nowMs,
        leaseOwner: keepLease ? input.leaseOwner : null,
        leaseExpiresAtMs: keepLease ? input.nowMs + normalizePositiveInteger(input.leaseMs, OPML_REFRESH_JOB_LEASE_MS) : null,
        lastErrorCode: input.lastErrorCode ?? job.lastErrorCode,
      });
      await requestToPromise(meta.put(next));
      if (completed)
        await writeQueue(
          meta,
          queue.filter((jobId) => jobId !== job.jobId),
        );
      return { completed, job: next, status: 'updated' };
    },
    { ...options, durability: 'strict' },
  );
}

/**
 * @param {IDBObjectStore} meta
 */
async function readQueue(meta) {
  const record = await requestToPromise(meta.get(OPML_REFRESH_QUEUE_KEY));
  if (!record) return [];
  const value = typeof record === 'object' && record !== null ? record.value : undefined;
  return requireStringArray(value, 'opmlRefreshQueue.value', 5000).map((jobId) => requireUuid(jobId, 'jobId'));
}

/**
 * @param {IDBObjectStore} meta
 * @param {string[]} queue
 */
async function writeQueue(meta, queue) {
  await requestToPromise(meta.put({ key: OPML_REFRESH_QUEUE_KEY, value: [...new Set(queue)] }));
}

/**
 * @param {IDBObjectStore} meta
 * @param {string} jobId
 */
async function readJob(meta, jobId) {
  const record = await requestToPromise(meta.get(OPML_REFRESH_JOB_KEY_PREFIX + requireUuid(jobId, 'jobId')));
  return record ? normalizeOpmlRefreshJobRecord(record) : null;
}
