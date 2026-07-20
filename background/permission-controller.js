// @ts-check

import { createFeedRepository } from '../data/feed-repository.js';
import { PERMISSION_STATE } from '../data/constants.js';
import { originPatternForUrl } from '../domain/urls.js';

/**
 * @typedef {object} PermissionsApi
 * @property {(permissions: {origins: string[]}) => Promise<boolean>} contains
 * @property {() => Promise<{origins?: string[], permissions?: string[]}>} getAll
 *
 * @typedef {object} BrowserPermissionsLike
 * @property {PermissionsApi} permissions
 *
 * @typedef {import('../data/transaction.js').TransactionOptions} RepositoryOptions
 */

/**
 * @param {RepositoryOptions} options
 * @param {BrowserPermissionsLike} browserApi
 */
export function createPermissionController(options = {}, browserApi = getBrowserApi()) {
  const feeds = createFeedRepository(options);
  return {
    /**
     * @param {string} originPattern
     */
    containsOrigin: (originPattern) => containsOrigin(browserApi, originPattern),
    /**
     * @param {string} subscriptionOrigin
     * @param {string} finalUrl
     */
    resolveRedirectTarget: (subscriptionOrigin, finalUrl) =>
      resolveRedirectTarget(browserApi, subscriptionOrigin, finalUrl),
    async reconcileFeedPermissions() {
      const granted = await grantedOriginSet(browserApi);
      const items = await feeds.listWithStats();
      const origins = uniqueOrigins(items.map(({ feed }) => feed.permissionOrigin));
      const changed = [];
      const mutations = [];
      for (const origin of origins) {
        const state = isOriginGranted(origin, granted) ? PERMISSION_STATE.GRANTED : PERMISSION_STATE.MISSING;
        const result = await feeds.setPermissionStateByOrigin(origin, state);
        mutations.push(result);
        changed.push(...result.feedIds);
      }
      return { feedIds: changed, mutations };
    },
    /**
     * @param {unknown} permissions
     */
    async handlePermissionsAdded(permissions) {
      const origins = originsFromPermissionEvent(permissions);
      if (origins.some(isBroadHostPattern)) return this.reconcileFeedPermissions();
      const changed = [];
      const mutations = [];
      for (const origin of origins) {
        const result = await feeds.setPermissionStateByOrigin(origin, PERMISSION_STATE.GRANTED);
        mutations.push(result);
        changed.push(...result.feedIds);
      }
      return { feedIds: changed, mutations };
    },
    /**
     * @param {unknown} permissions
     */
    async handlePermissionsRemoved(permissions) {
      const origins = originsFromPermissionEvent(permissions);
      if (origins.some(isBroadHostPattern)) return this.reconcileFeedPermissions();
      const changed = [];
      const mutations = [];
      for (const origin of origins) {
        const result = await feeds.setPermissionStateByOrigin(origin, PERMISSION_STATE.MISSING);
        mutations.push(result);
        changed.push(...result.feedIds);
      }
      return { feedIds: changed, mutations };
    },
  };
}

/**
 * @param {string} inputUrl
 * @returns {string}
 */
export function toOriginPattern(inputUrl) {
  return originPatternForUrl(inputUrl);
}

/**
 * @param {BrowserPermissionsLike} browserApi
 * @param {string} originPattern
 */
async function containsOrigin(browserApi, originPattern) {
  return browserApi.permissions.contains({ origins: [originPattern] });
}

/**
 * @param {BrowserPermissionsLike} browserApi
 * @param {string} subscriptionOrigin
 * @param {string} finalUrl
 */
async function resolveRedirectTarget(browserApi, subscriptionOrigin, finalUrl) {
  const finalOrigin = toOriginPattern(finalUrl);
  if (finalOrigin === subscriptionOrigin) {
    return { status: 'same-origin', finalOrigin, redirectOriginPending: '' };
  }
  if (await containsOrigin(browserApi, finalOrigin)) {
    return { status: 'granted-redirect', finalOrigin, redirectOriginPending: '' };
  }
  return { status: 'permission-required', finalOrigin, redirectOriginPending: finalOrigin };
}

/**
 * @param {BrowserPermissionsLike} browserApi
 * @returns {Promise<Set<string>>}
 */
async function grantedOriginSet(browserApi) {
  const granted = await browserApi.permissions.getAll();
  return new Set((granted.origins ?? []).filter((origin) => typeof origin === 'string'));
}

/**
 * @param {string} origin
 * @param {ReadonlySet<string>} granted
 */
function isOriginGranted(origin, granted) {
  if (granted.has(origin)) return true;
  const url = new URL(origin.slice(0, -1));
  return granted.has(`${url.protocol}//*/*`);
}

/**
 * @param {unknown} permissions
 * @returns {string[]}
 */
function originsFromPermissionEvent(permissions) {
  if (typeof permissions !== 'object' || permissions === null || !('origins' in permissions)) return [];
  const origins = /** @type {{origins?: unknown}} */ (permissions).origins;
  if (!Array.isArray(origins)) return [];
  return origins.filter((origin) => typeof origin === 'string');
}

/**
 * @param {string[]} origins
 * @returns {string[]}
 */
function uniqueOrigins(origins) {
  return [...new Set(origins.filter(Boolean))];
}

/**
 * @param {string} pattern
 */
function isBroadHostPattern(pattern) {
  return pattern === 'http://*/*' || pattern === 'https://*/*';
}

/**
 * @returns {BrowserPermissionsLike}
 */
function getBrowserApi() {
  return /** @type {{browser: BrowserPermissionsLike}} */ (/** @type {unknown} */ (globalThis)).browser;
}
