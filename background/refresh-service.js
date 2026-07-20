// @ts-check

import { createArticleRepository } from '../data/article-repository.js';
import { createFeedRepository } from '../data/feed-repository.js';
import { createOpmlRefreshJobRepository } from '../data/opml-refresh-jobs.js';
import { createSettingsRepository, DEFAULT_SETTINGS } from '../data/settings-repository.js';
import { ERROR_CODES, createAppError } from '../domain/errors.js';
import { fetchFeed as defaultFetchFeed } from './feed-fetcher.js';
import { parseFeedBytes as defaultParseFeedBytes } from './feed-parser.js';
import { createMaintenanceService } from './maintenance-service.js';
import { prepareArticlesForIngestion } from './article-preparation.js';
import { refreshFeedList } from './refresh-queue.js';
import { createRefreshThrottle } from './refresh-throttle.js';
import { processOpmlRefreshJobs as processOpmlRefreshJobChunks } from './opml-post-commit.js';
import {
  crashAfterChunk,
  crashIfRequested,
  createRunId,
  fireIconResolution,
  normalizePositiveInteger,
  publishChange,
  resolveChangePublisher,
  safeError,
} from './refresh-runtime.js';

export { prepareArticlesForIngestion } from './article-preparation.js';

/**
 * @typedef {import('./article-preparation.js').ParserNeutralArticleInput} ParserNeutralArticleInput
 * @typedef {import('./article-preparation.js').PreparedArticle} PreparedArticle
 *
 * @typedef {object} RefreshServiceDependencies
 * @property {ReturnType<typeof createFeedRepository>} [feeds]
 * @property {ReturnType<typeof createArticleRepository>} [articles]
 * @property {(input: import('./feed-fetcher.js').FetchFeedInput) => Promise<import('./feed-fetcher.js').FetchResult>} [fetchFeed]
 * @property {(bytes: Uint8Array, context: {contentType?: string, responseUrl: string, nowMs?: number}) => import('./feed-parser-utils.js').ParserResult} [parseFeedBytes]
 * @property {() => number} [now]
 * @property {() => string} [runIdFactory]
 * @property {number} [refreshIntervalMinutes]
 * @property {number} [feedTimeoutSeconds]
 * @property {number} [ingestChunkSize]
 * @property {number} [concurrency]
 * @property {number} [scheduledLimit]
 * @property {number | boolean} [crashAfterClaim]
 * @property {number | boolean} [crashAfterFetch]
 * @property {number | boolean} [crashAfterIngestChunks]
 * @property {number | boolean} [crashBeforeComplete]
 * @property {ReturnType<typeof createMaintenanceService>} [maintenance]
 * @property {import('../data/settings-repository.js').StorageArea} [storageArea]
 * @property {import('./change-events.js').BrowserRuntimeLike} [browserApi]
 * @property {import('./change-events.js').ChangePublisher | null} [changePublisher]
 * @property {{resolveRedirectTarget?: (subscriptionOrigin: string, finalUrl: string) => Promise<{finalOrigin: string, redirectOriginPending?: string, status?: string}>}} [permissionController]
 * @property {(feedId: string) => Promise<unknown>} [resolveIcon]
 */

/**
 * @param {import('../data/transaction.js').TransactionOptions} [options]
 * @param {RefreshServiceDependencies} [dependencies]
 */
export function createRefreshService(options = {}, dependencies = {}) {
  const feeds = dependencies.feeds ?? createFeedRepository(options);
  const articles = dependencies.articles ?? createArticleRepository(options);
  const opmlRefreshJobs = createOpmlRefreshJobRepository(options);
  const changePublisher = resolveChangePublisher(dependencies);
  const maintenance = dependencies.maintenance ?? createMaintenanceService(options, { changePublisher });
  const activeFeeds = new Set();
  const config = normalizeRefreshConfig(dependencies);
  const throttle = createRefreshThrottle(options);
  const service = {
    /**
     * @param {string} feedId
     */
    refreshOne(feedId) {
      if (activeFeeds.has(feedId)) return Promise.resolve({ feedId, status: 'already-running' });
      const operation = refreshOneClaimed(
        feedId,
        feeds,
        articles,
        config,
        dependencies,
        changePublisher,
        throttle,
      ).finally(() => {
        activeFeeds.delete(feedId);
      });
      activeFeeds.add(feedId);
      return operation;
    },
    async refreshDueFeeds() {
      const due = await feeds.listDueForRefresh({ limit: config.scheduledLimit, nowMs: config.now() });
      return refreshFeedList(due, this.refreshOne, config.concurrency);
    },
    async refreshAll() {
      const refreshable = await feeds.listRefreshable();
      return refreshFeedList(refreshable, this.refreshOne, config.concurrency);
    },
    /** @param {{maxChunks?: number}} [input] */
    processOpmlRefreshJobs: (input = {}) =>
      processOpmlRefreshJobChunks({
        batchSize: config.scheduledLimit,
        concurrency: config.concurrency,
        jobs: opmlRefreshJobs,
        maxChunks: input.maxChunks,
        now: config.now,
        refreshOne: service.refreshOne,
      }),
    /** @param {{before: import('../data/settings-repository.js').SettingsRecord, after: import('../data/settings-repository.js').SettingsRecord}} input */
    async reconcileSettingsChange(input) {
      const result = await feeds.replanRefreshInterval({ ...input, nowMs: config.now() });
      await publishChange(changePublisher, result);
      return result;
    },
    async runMaintenance() {
      const maintenanceResult = await maintenance.runMaintenance({
        settings: await readSettings(dependencies.storageArea),
      });
      const opmlRefreshJob = await service.processOpmlRefreshJobs({ maxChunks: 1 });
      return {
        ...maintenanceResult,
        opmlRefreshJob,
        status:
          maintenanceResult.status === 'partial' || opmlRefreshJob.status === 'partial'
            ? 'partial'
            : maintenanceResult.status,
      };
    },
  };
  return service;
}

/**
 * @param {import('../data/settings-repository.js').StorageArea | undefined} storageArea
 */
async function readSettings(storageArea) {
  if (!storageArea) return DEFAULT_SETTINGS;
  return createSettingsRepository(storageArea).read();
}

/**
 * @param {string} feedId
 * @param {ReturnType<typeof createFeedRepository>} feeds
 * @param {ReturnType<typeof createArticleRepository>} articles
 * @param {ReturnType<typeof normalizeRefreshConfig>} config
 * @param {RefreshServiceDependencies} dependencies
 * @param {import('./change-events.js').ChangePublisher | null} changePublisher
 * @param {ReturnType<typeof createRefreshThrottle>} throttle
 */
async function refreshOneClaimed(feedId, feeds, articles, config, dependencies, changePublisher, throttle) {
  const runConfig = await refreshRunConfig(config, dependencies.storageArea);
  const runId = runConfig.runIdFactory();
  const claimedAtMs = runConfig.now();
  const claim = await feeds.claimRefresh(feedId, { nowMs: claimedAtMs, runId });
  await publishChange(changePublisher, claim);
  if (claim.status !== 'claimed') return { feedId, status: claim.status };
  crashIfRequested(dependencies.crashAfterClaim, 'crash after claim');

  const feed = claim.feed;
  if (!feed) throw createAppError(ERROR_CODES.INTERNAL_ERROR);
  const deferred = await throttle.consultBeforeFetch(feeds, feed, runId, runConfig);
  if (deferred) {
    await publishChange(changePublisher, deferred);
    return deferred;
  }
  const fetched = await fetchForFeed(feed, runConfig, dependencies);
  crashIfRequested(dependencies.crashAfterFetch, 'crash after fetch');
  if (fetched.status === 'failure') {
    const result = await throttle.routeFailure(feeds, feedId, runId, feed, fetched, runConfig);
    await publishChange(changePublisher, result);
    return result;
  }
  if (fetched.status === 'redirect-permission-required') {
    const result = await completeRedirectPermissionRequired(feeds, feedId, runId, fetched, runConfig);
    await publishChange(changePublisher, result);
    return result;
  }
  if (fetched.status === 'not-modified') {
    const result = await completeNotModified(feeds, feedId, runId, fetched, runConfig);
    await publishChange(changePublisher, result);
    return result;
  }

  const parsed = runConfig.parseFeedBytes(fetched.bytes, {
    contentType: fetched.contentType,
    nowMs: runConfig.now(),
    responseUrl: fetched.finalUrl,
  });
  if (!parsed.ok) {
    /** @type {import('./feed-fetcher.js').FetchFailureResult} */
    const failure = {
      error: parsed.error,
      httpStatus: fetched.httpStatus,
      retryAfterMs: 0,
      status: 'failure',
    };
    const result = await throttle.routeFailure(feeds, feedId, runId, feed, failure, runConfig);
    await publishChange(changePublisher, result);
    return result;
  }

  const prepared = await prepareArticlesForIngestion({
    entries: parsed.data.entries,
    feed,
    fetchedAtMs: runConfig.now(),
  });
  const ingest = await ingestPreparedOrRecoverQuota(
    articles,
    feeds,
    feedId,
    runId,
    prepared,
    runConfig,
    dependencies,
    changePublisher,
  );
  if (isFailedIngest(ingest)) return ingest;
  crashIfRequested(dependencies.crashBeforeComplete, 'crash before complete');
  const completed = await feeds.completeRefreshSuccess(feedId, {
    etag: fetched.etag,
    feed: parsed.data.feed,
    finalOrigin: fetched.finalOrigin,
    finalUrl: fetched.finalUrl,
    httpStatus: fetched.httpStatus,
    lastModified: fetched.lastModified,
    nowMs: runConfig.now(),
    refreshIntervalMinutes: runConfig.refreshIntervalMinutes,
    runId,
  });
  await publishChange(changePublisher, completed);
  // Fire-and-forget background icon resolution once the refresh transaction has
  // committed (never inside a txn). The resolver itself gates on empty iconUrl,
  // granted origin and the host throttle, so firing on every success is safe.
  if (completed.status === 'completed') fireIconResolution(dependencies.resolveIcon, feedId);
  return completed.status === 'completed'
    ? { ...completed, feedId, ingest, status: 'refreshed' }
    : { ...completed, feedId, status: completed.status };
}

/**
 * @param {unknown} value
 * @returns {value is {error: import('../domain/errors.js').SafeError, status: 'failed'}}
 */
function isFailedIngest(value) {
  return typeof value === 'object' && value !== null && /** @type {{status?: unknown}} */ (value).status === 'failed';
}

/**
 * @param {ReturnType<typeof createArticleRepository>} articles
 * @param {ReturnType<typeof createFeedRepository>} feeds
 * @param {string} feedId
 * @param {string} runId
 * @param {import('./article-preparation.js').PreparedArticle[]} prepared
 * @param {ReturnType<typeof normalizeRefreshConfig>} config
 * @param {RefreshServiceDependencies} dependencies
 * @param {import('./change-events.js').ChangePublisher | null} changePublisher
 */
async function ingestPreparedOrRecoverQuota(
  articles,
  feeds,
  feedId,
  runId,
  prepared,
  config,
  dependencies,
  changePublisher,
) {
  const crashAfterIngestChunk = crashAfterChunk(dependencies.crashAfterIngestChunks);
  try {
    return await articles.ingestPrepared(feedId, prepared, {
      afterChunk: async (aggregate) => {
        await publishChange(changePublisher, aggregate);
        crashAfterIngestChunk?.();
      },
      chunkSize: config.ingestChunkSize,
    });
  } catch (error) {
    const safe = safeError(error);
    if (safe.code !== ERROR_CODES.DB_QUOTA_EXCEEDED) throw error;
    const failure = await feeds.completeRefreshFailure(feedId, {
      error: safe,
      httpStatus: 0,
      nowMs: config.now(),
      refreshIntervalMinutes: config.refreshIntervalMinutes,
      runId,
    });
    await publishChange(changePublisher, failure);
    return { error: safe, status: 'failed' };
  }
}

/**
 * @param {import('../data/models.js').FeedRecord} feed
 * @param {ReturnType<typeof normalizeRefreshConfig>} config
 * @param {RefreshServiceDependencies} dependencies
 * @returns {Promise<import('./feed-fetcher.js').FetchResult>}
 */
async function fetchForFeed(feed, config, dependencies) {
  const input = {
    etag: feed.etag,
    lastModified: feed.lastModified,
    subscriptionOrigin: feed.permissionOrigin,
    timeoutMs: config.feedTimeoutSeconds * 1000,
    url: feed.resolvedUrl || feed.url,
  };
  try {
    if (dependencies.fetchFeed) return await dependencies.fetchFeed(input);
    return await defaultFetchFeed(input, { permissionController: dependencies.permissionController });
  } catch (error) {
    /** @type {import('./feed-fetcher.js').FetchFailureResult} */
    const failure = {
      error: safeError(error),
      httpStatus: 0,
      retryAfterMs: 0,
      status: 'failure',
    };
    return failure;
  }
}

/**
 * @param {ReturnType<typeof createFeedRepository>} feeds
 * @param {string} feedId
 * @param {string} runId
 * @param {import('./feed-fetcher.js').FetchRedirectPermissionRequiredResult} fetched
 * @param {ReturnType<typeof normalizeRefreshConfig>} config
 */
async function completeRedirectPermissionRequired(feeds, feedId, runId, fetched, config) {
  const result = await feeds.completeRefreshRedirectPermissionRequired(feedId, {
    error: fetched.error,
    finalOrigin: fetched.finalOrigin,
    finalUrl: fetched.finalUrl,
    httpStatus: fetched.httpStatus,
    nowMs: config.now(),
    runId,
  });
  return { ...result, feedId, status: result.status };
}

/**
 * @param {ReturnType<typeof createFeedRepository>} feeds
 * @param {string} feedId
 * @param {string} runId
 * @param {import('./feed-fetcher.js').FetchNotModifiedResult} fetched
 * @param {ReturnType<typeof normalizeRefreshConfig>} config
 */
async function completeNotModified(feeds, feedId, runId, fetched, config) {
  const result = await feeds.completeRefreshNotModified(feedId, {
    finalOrigin: fetched.finalOrigin,
    finalUrl: fetched.finalUrl,
    httpStatus: fetched.httpStatus,
    nowMs: config.now(),
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    runId,
  });
  return { ...result, feedId, status: result.status };
}

/**
 * @param {RefreshServiceDependencies} dependencies
 */
function normalizeRefreshConfig(dependencies) {
  return {
    concurrency: normalizePositiveInteger(dependencies.concurrency, 4),
    feedTimeoutSeconds: normalizePositiveInteger(dependencies.feedTimeoutSeconds, DEFAULT_SETTINGS.feedTimeoutSeconds),
    ingestChunkSize: normalizePositiveInteger(dependencies.ingestChunkSize, 200),
    now: dependencies.now ?? Date.now,
    parseFeedBytes: dependencies.parseFeedBytes ?? defaultParseFeedBytes,
    refreshIntervalMinutes: normalizePositiveInteger(
      dependencies.refreshIntervalMinutes,
      DEFAULT_SETTINGS.refreshIntervalMinutes,
    ),
    runIdFactory: dependencies.runIdFactory ?? createRunId,
    scheduledLimit: normalizePositiveInteger(dependencies.scheduledLimit, 20),
  };
}

/**
 * @param {ReturnType<typeof normalizeRefreshConfig>} config
 * @param {import('../data/settings-repository.js').StorageArea | undefined} storageArea
 */
async function refreshRunConfig(config, storageArea) {
  if (!storageArea) return config;
  const settings = await readSettings(storageArea);
  return {
    ...config,
    feedTimeoutSeconds: settings.feedTimeoutSeconds,
    refreshIntervalMinutes: settings.refreshIntervalMinutes,
  };
}
