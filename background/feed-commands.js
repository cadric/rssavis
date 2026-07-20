// @ts-check

import { createFeedRepository } from '../data/feed-repository.js';
import { ERROR_CODES, createAppError } from '../domain/errors.js';
import { MESSAGE_TYPES } from '../domain/message-types.js';
import { toOriginPattern, createPermissionController } from './permission-controller.js';
import { createCommittedChangePublisher } from './change-events.js';
import { createRefreshService } from './refresh-service.js';
import { summarizeRefreshResults } from './refresh-queue.js';

/**
 * @typedef {import('../data/transaction.js').TransactionOptions} RepositoryOptions
 * @typedef {import('./change-events.js').BrowserRuntimeLike & import('./permission-controller.js').BrowserPermissionsLike} FeedBrowserLike
 */

/**
 * @param {RepositoryOptions} options
 * @param {FeedBrowserLike} [browserApi]
 * @param {ReturnType<typeof createRefreshService>} [refreshService]
 * @param {import('./change-events.js').ChangePublisher} [changePublisher]
 * @returns {Record<string, import('./command-router.js').CommandHandler>}
 */
export function createFeedCommandHandlers(
  options = {},
  browserApi = undefined,
  refreshService = undefined,
  changePublisher = undefined,
) {
  const feeds = createFeedRepository(options);
  const permissions = browserApi ? createPermissionController(options, browserApi) : null;
  const publisher = changePublisher ?? (browserApi ? createCommittedChangePublisher(browserApi) : null);
  const refresh = refreshService ?? createRefreshService(options, { browserApi, changePublisher: publisher });
  return {
    [MESSAGE_TYPES.FEEDS_LIST]: () => feeds.listWithStats(),
    [MESSAGE_TYPES.FEEDS_ADD]: async (payload) => {
      const input = normalizeAddPayload(payload);
      const permissionOrigin = toOriginPattern(input.url);
      if (permissions && !(await permissions.containsOrigin(permissionOrigin))) {
        throw createAppError(ERROR_CODES.HOST_PERMISSION_DENIED, {
          details: { operation: 'feeds.add' },
          retryable: false,
        });
      }
      const added = await runMutationCommand(() => feeds.addSubscription(input), publisher);
      triggerFirstFetch(refresh, added);
      return added;
    },
    [MESSAGE_TYPES.FEEDS_UPDATE]: async (payload) => {
      const input = normalizeUpdatePayload(payload);
      if (input.patch.url) {
        const permissionOrigin = toOriginPattern(input.patch.url);
        if (permissions && !(await permissions.containsOrigin(permissionOrigin))) {
          throw createAppError(ERROR_CODES.HOST_PERMISSION_DENIED, {
            details: { operation: 'feeds.update' },
            retryable: false,
          });
        }
      }
      const updated = await runMutationCommand(() => feeds.updateSubscription(input.id, input.patch), publisher);
      const { urlChanged, ...result } = updated;
      if (!urlChanged) return result;
      return { ...result, refresh: await refresh.refreshOne(input.id) };
    },
    [MESSAGE_TYPES.FEEDS_MOVE]: (payload) =>
      runMutationCommand(
        () =>
          feeds.moveRelative(
            requireString(payload, 'id'),
            requireString(payload, 'categoryId'),
            requireDirection(payload),
          ),
        publisher,
      ),
    [MESSAGE_TYPES.FEEDS_MOVE_CATEGORY]: (payload) =>
      runMutationCommand(
        () => feeds.moveToCategory(requireString(payload, 'id'), requireString(payload, 'categoryId')),
        publisher,
      ),
    [MESSAGE_TYPES.FEEDS_DELETE]: (payload) =>
      runMutationCommand(() => feeds.markDeletePending(requireString(payload, 'id')), publisher),
    [MESSAGE_TYPES.FEEDS_REFRESH_ONE]: (payload) => refresh.refreshOne(requireString(payload, 'id')),
    [MESSAGE_TYPES.FEEDS_REFRESH_ALL]: async () => summarizeRefreshResults(await refresh.refreshAll()),
    [MESSAGE_TYPES.FEEDS_GRANT_PERMISSION]: (payload) =>
      grantPermission(feeds, permissions, refresh, publisher, requireString(payload, 'id')),
    [MESSAGE_TYPES.FEEDS_GRANT_REDIRECT]: (payload) =>
      grantRedirectPermission(feeds, permissions, refresh, publisher, requireString(payload, 'id')),
  };
}

/**
 * @param {ReturnType<typeof createFeedRepository>} feeds
 * @param {ReturnType<typeof createPermissionController> | null} permissions
 * @param {ReturnType<typeof createRefreshService>} refresh
 * @param {import('./change-events.js').ChangePublisher | null} publisher
 * @param {string} id
 */
async function grantPermission(feeds, permissions, refresh, publisher, id) {
  const feed = await feeds.get(id);
  if (!feed) throw createAppError(ERROR_CODES.FEED_NOT_FOUND, { details: { feedId: id } });
  if (permissions && !(await permissions.containsOrigin(feed.permissionOrigin))) {
    throw createAppError(ERROR_CODES.HOST_PERMISSION_DENIED, {
      details: { operation: 'feeds.grantPermission' },
      retryable: false,
    });
  }
  const granted = await feeds.grantPermission(id, { permissionOrigin: feed.permissionOrigin });
  if (publisher) await publisher(granted);
  return { ...granted, refresh: await refresh.refreshOne(id) };
}

/**
 * @param {ReturnType<typeof createFeedRepository>} feeds
 * @param {ReturnType<typeof createPermissionController> | null} permissions
 * @param {ReturnType<typeof createRefreshService>} refresh
 * @param {import('./change-events.js').ChangePublisher | null} publisher
 * @param {string} id
 */
async function grantRedirectPermission(feeds, permissions, refresh, publisher, id) {
  const feed = await feeds.get(id);
  if (!feed) throw createAppError(ERROR_CODES.FEED_NOT_FOUND, { details: { feedId: id } });
  if (!feed.redirectOriginPending || !feed.redirectUrlPending) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
      details: { field: 'redirectOriginPending', reason: 'missing or stale redirect permission' },
    });
  }
  if (permissions && !(await permissions.containsOrigin(feed.redirectOriginPending))) {
    throw createAppError(ERROR_CODES.HOST_PERMISSION_DENIED, {
      details: { operation: 'feeds.grantRedirect' },
      retryable: false,
    });
  }
  const granted = await feeds.grantRedirectPermission(id, {
    redirectOriginPending: feed.redirectOriginPending,
    redirectUrlPending: feed.redirectUrlPending,
  });
  if (publisher) await publisher(granted);
  return { ...granted, refresh: await refresh.refreshOne(id) };
}

/**
 * Fire-and-forget the first fetch after a feed is added. The command response must not wait for the
 * network (unlike the grantPermission paths, which await refreshOne), and a refresh failure must
 * never change the successful add response. The refresh service's activeFeeds set plus lease claim
 * guard against a double run with the 5-minute alarm, and B31's throttle inherits this path.
 * @param {ReturnType<typeof createRefreshService>} refresh
 * @param {unknown} added
 */
function triggerFirstFetch(refresh, added) {
  const feedId = isRecord(added) && isRecord(added.feed) ? added.feed.id : undefined;
  if (typeof feedId !== 'string' || feedId.length === 0) return;
  void refresh.refreshOne(feedId).catch((error) => {
    console.error({
      atMs: Date.now(),
      code: error instanceof Error ? error.name : 'FEED_FIRST_FETCH_FAILED',
      level: 'error',
      operation: 'feeds.add.refresh',
    });
  });
}

/**
 * @template {import('./change-events.js').RepositoryMutationResult & Record<string, unknown>} T
 * @param {() => Promise<T>} operation
 * @param {import('./change-events.js').ChangePublisher | null} publisher
 * @returns {Promise<T>}
 */
async function runMutationCommand(operation, publisher) {
  const result = await operation();
  if (publisher) await publisher(result);
  return result;
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {{url: string, title: string, categoryId?: string, customTitle?: string}}
 */
function normalizeAddPayload(payload) {
  const url = requireString(payload, 'url');
  const title = requireString(payload, 'title');
  const categoryId = optionalString(payload, 'categoryId');
  const base = categoryId ? { url, title, categoryId } : { url, title };
  return 'customTitle' in payload ? { ...base, customTitle: optionalTitleField(payload, 'customTitle') } : base;
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {{id: string, patch: {title?: string, customTitle?: string, url?: string, categoryId?: string, mainStreamState?: number, keepReadOnPurge?: number, iconSource?: string, iconColor?: string}}}
 */
function normalizeUpdatePayload(payload) {
  const id = requireString(payload, 'id');
  const patch = payload.patch;
  if (!isRecord(patch)) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
      details: { field: 'patch', reason: 'must be an object' },
    });
  }
  /** @type {{title?: string, customTitle?: string, url?: string, categoryId?: string, mainStreamState?: number, keepReadOnPurge?: number, iconSource?: string, iconColor?: string}} */
  const clean = {};
  if ('title' in patch) clean.title = requireString(patch, 'title');
  if ('customTitle' in patch) clean.customTitle = optionalTitleField(patch, 'customTitle');
  if ('url' in patch) clean.url = requireString(patch, 'url');
  if ('categoryId' in patch) clean.categoryId = requireString(patch, 'categoryId');
  if ('mainStreamState' in patch) clean.mainStreamState = requireState(patch.mainStreamState);
  if ('keepReadOnPurge' in patch) clean.keepReadOnPurge = requireState(patch.keepReadOnPurge);
  if ('iconSource' in patch) clean.iconSource = requireIconSource(patch.iconSource);
  if ('iconColor' in patch) clean.iconColor = requireIconColor(patch.iconColor);
  const allowedKeys = [
    'title',
    'customTitle',
    'url',
    'categoryId',
    'mainStreamState',
    'keepReadOnPurge',
    'iconSource',
    'iconColor',
  ];
  for (const key of Object.keys(patch)) {
    if (!allowedKeys.includes(key)) {
      throw createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field: key, reason: 'unknown patch field' } });
    }
  }
  return { id, patch: clean };
}

/**
 * @param {unknown} value
 * @returns {'auto' | 'favicon'}
 */
function requireIconSource(value) {
  if (value === 'auto' || value === 'favicon') return value;
  throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
    details: { field: 'iconSource', reason: 'must be auto or favicon' },
  });
}

const ICON_COLOR_VALUES = new Set(['', '0', '1', '2', '3', '4', '5', '6', '7', '8']);

/**
 * @param {unknown} value
 * @returns {string}
 */
function requireIconColor(value) {
  if (typeof value === 'string' && ICON_COLOR_VALUES.has(value)) return value;
  throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
    details: { field: 'iconColor', reason: 'must be empty or an identity index 0-8' },
  });
}

/**
 * A user title (customTitle) may be an empty string to fall back to the feed's remote title, so it is
 * validated as a string without the non-empty requirement the other feed fields carry.
 * @param {Record<string, unknown>} payload
 * @param {string} key
 * @returns {string}
 */
function optionalTitleField(payload, key) {
  const value = payload[key];
  if (typeof value !== 'string') {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field: key, reason: 'must be a string' } });
  }
  return value;
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} key
 */
function requireString(payload, key) {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
      details: { field: key, reason: 'must be a non-empty string' },
    });
  }
  return value;
}

/**
 * @param {unknown} value
 */
function requireState(value) {
  if (value === 0 || value === 1) return value;
  throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
    details: { field: 'mainStreamState', reason: 'invalid state' },
  });
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {'up' | 'down'}
 */
function requireDirection(payload) {
  const direction = payload.direction;
  if (direction === 'up' || direction === 'down') return direction;
  throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
    details: { field: 'direction', reason: 'must be up or down' },
  });
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} key
 */
function optionalString(payload, key) {
  const value = payload[key];
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
      details: { field: key, reason: 'must be a non-empty string' },
    });
  }
  return value;
}
