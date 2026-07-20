// @ts-check

import { ERROR_CODES, createAppError } from '../domain/errors.js';
import { httpsOnlyUrl, normalizeArticleUrl } from '../domain/urls.js';
import {
  compareContextIdentity,
  pruneReaderContextActivity,
  readReaderContextActivity,
  recordReaderContextActivity,
  writeReaderContextActivity,
} from './reader-context-activity.js';

/**
 * @typedef {object} BrowserLike
 * @property {{getURL(path: string): string, getContexts(filter: Record<string, unknown>): Promise<ExtensionContext[]>}} runtime
 * @property {{session?: import('./reader-context-activity.js').StorageArea}} [storage]
 * @property {{create(properties: {url: string, active?: boolean}): Promise<{id?: number, windowId?: number}>, update(tabId: number, properties: {active?: boolean, url?: string}): Promise<unknown>}} tabs
 * @property {{update(windowId: number, properties: {focused: boolean}): Promise<unknown>}} windows
 *
 * @typedef {object} ArticleReader
 * @property {(id: string) => Promise<Record<string, unknown>>} getDetail
 */

/**
 * @typedef {object} ExtensionContext
 * @property {string} [contextId]
 * @property {string} [contextType]
 * @property {string} [documentId]
 * @property {string} [documentUrl]
 * @property {number} [frameId]
 * @property {number} [tabId]
 * @property {number} [windowId]
 *
 * @typedef {object} OpenReaderInput
 * @property {number} [windowId]
 *
 * @typedef {object} ReaderActionControllerOptions
 * @property {() => number} [clock]
 */

/**
 * @typedef {object} ReaderActionResult
 * @property {'created' | 'focused'} action
 * @property {number | null} tabId
 * @property {number | null} windowId
 * @property {string} url
 */

/**
 * @param {BrowserLike} [browserApi]
 * @returns {string}
 */
export function getReaderUrl(browserApi = getBrowserApi()) {
  return browserApi.runtime.getURL('app/index.html');
}

/**
 * @param {BrowserLike} [browserApi]
 * @param {ReaderActionControllerOptions} [options]
 */
export function createReaderActionController(browserApi = getBrowserApi(), options = {}) {
  /** @type {Map<string, number>} */
  const writeThrottleByContext = new Map();
  const clock = options.clock ?? Date.now;
  return {
    /**
     * @param {OpenReaderInput} [input]
     */
    openOrFocusReader: (input = {}) => openOrFocusReader(browserApi, { preferredWindowId: input.windowId }),
    /**
     * @param {Record<string, unknown>} _payload
     * @param {{sender?: unknown}} context
     */
    recordReaderContextActive: async (_payload, context) => {
      const readerContext = readerContextFromSender(context.sender, getReaderUrl(browserApi));
      if (!readerContext) return { recorded: false, throttled: false };
      return recordReaderContextActivity(browserApi.storage?.session, readerContext, clock(), writeThrottleByContext);
    },
  };
}

/**
 * @param {BrowserLike} [browserApi]
 * @param {{preferredWindowId?: number}} [options]
 * @returns {Promise<ReaderActionResult>}
 */
export async function openOrFocusReader(browserApi = getBrowserApi(), options = {}) {
  const url = getReaderUrl(browserApi);
  const contexts = await browserApi.runtime.getContexts({
    contextTypes: ['TAB'],
    documentUrls: [url],
  });
  const existing = await selectReaderContext(contexts, browserApi.storage?.session, options.preferredWindowId);
  if (existing?.tabId != null && existing.tabId >= 0) {
    await browserApi.tabs.update(existing.tabId, { active: true });
    if (existing.windowId != null && existing.windowId >= 0) {
      await browserApi.windows.update(existing.windowId, { focused: true });
    }
    return {
      action: 'focused',
      tabId: existing.tabId,
      windowId: existing.windowId ?? null,
      url,
    };
  }

  const created = await browserApi.tabs.create({ url });
  return {
    action: 'created',
    tabId: created.id ?? null,
    windowId: created.windowId ?? null,
    url,
  };
}

/**
 * @param {Record<string, unknown>} payload
 * @param {{sender?: unknown}} context
 * @param {{articles: ArticleReader, browserApi?: BrowserLike}} dependencies
 */
export async function openArticleOriginal(payload, context, dependencies) {
  const articleId = requireString(payload.id, 'id');
  const mode = normalizeOpenMode(payload.mode);
  const detail = await dependencies.articles.getDetail(articleId);
  const url = normalizeArticleUrl(requireString(detail.canonicalUrl, 'canonicalUrl'));
  const browserApi = dependencies.browserApi ?? getBrowserApi();
  const senderTabId = senderTabIdFrom(context.sender);

  if (mode === 'current-tab' && senderTabId !== null) {
    await browserApi.tabs.update(senderTabId, { url });
    return { action: 'updated', mode, tabId: senderTabId, url };
  }

  const created = await browserApi.tabs.create({ active: mode === 'foreground-tab', url });
  return {
    action: 'created',
    mode,
    tabId: created.id ?? null,
    windowId: created.windowId ?? null,
    url,
  };
}

/**
 * Opens an inline article-content link (SEC-004). Unlike {@link openArticleOriginal}
 * this takes the target URL directly in the payload rather than resolving it from an
 * article id: the URL is re-validated here with `httpsOnlyUrl` (a non-https or
 * malformed URL is rejected before the tabs API is touched), then the same tab
 * routing as the "open original" boundary is applied. The URL only ever reaches
 * `browser.tabs`, never a `location`/`window.open` assignment.
 *
 * @param {Record<string, unknown>} payload
 * @param {{sender?: unknown}} context
 * @param {{browserApi?: BrowserLike}} dependencies
 */
export async function openArticleContentLink(payload, context, dependencies) {
  const url = httpsOnlyUrl(requireString(payload.url, 'url'));
  if (!url) {
    throw createAppError(ERROR_CODES.UNSUPPORTED_URL_SCHEME, {
      details: { field: 'url', reason: 'only https URLs are supported' },
    });
  }
  const mode = normalizeOpenMode(payload.mode);
  const browserApi = dependencies.browserApi ?? getBrowserApi();
  const senderTabId = senderTabIdFrom(context.sender);

  if (mode === 'current-tab' && senderTabId !== null) {
    await browserApi.tabs.update(senderTabId, { url });
    return { action: 'updated', mode, tabId: senderTabId, url };
  }

  const created = await browserApi.tabs.create({ active: mode === 'foreground-tab', url });
  return {
    action: 'created',
    mode,
    tabId: created.id ?? null,
    windowId: created.windowId ?? null,
    url,
  };
}

/**
 * @param {ExtensionContext[]} contexts
 * @param {import('./reader-context-activity.js').StorageArea | undefined} storageArea
 * @param {number | undefined} preferredWindowId
 * @returns {Promise<ExtensionContext | null>}
 */
async function selectReaderContext(contexts, storageArea, preferredWindowId) {
  const tabContexts = contexts.filter((context) => context.contextType === 'TAB' && context.frameId === 0);
  const activity = await readReaderContextActivity(storageArea);
  const pruned = pruneReaderContextActivity(activity, tabContexts);
  if (pruned.changed) await writeReaderContextActivity(storageArea, pruned.record);
  const active = newestPersistedReaderContext(tabContexts, pruned.record);
  if (active) return active;
  const preferred = deterministicContext(tabContexts.filter((context) => context.windowId === preferredWindowId));
  return preferred ?? deterministicContext(tabContexts);
}

/**
 * @param {ExtensionContext[]} contexts
 * @param {import('./reader-context-activity.js').ReaderContextActivityRecord} activity
 */
function newestPersistedReaderContext(contexts, activity) {
  for (const item of activity.contexts) {
    const match = contexts.find((context) => context.tabId === item.tabId && context.windowId === item.windowId);
    if (match) return match;
  }
  return null;
}

/**
 * @param {ExtensionContext[]} contexts
 */
function deterministicContext(contexts) {
  return [...contexts].sort(compareContextIdentity)[0] ?? null;
}

/**
 * @param {unknown} sender
 * @param {string} readerUrl
 */
function readerContextFromSender(sender, readerUrl) {
  if (typeof sender !== 'object' || sender === null) return null;
  const record = /** @type {{frameId?: unknown, tab?: {id?: unknown, windowId?: unknown}, url?: unknown}} */ (sender);
  if (record.frameId !== 0 || !isReaderDocumentUrl(record.url, readerUrl)) return null;
  const tabId = safeId(record.tab?.id);
  const windowId = safeId(record.tab?.windowId);
  return tabId === null || windowId === null ? null : { tabId, windowId };
}

/**
 * @param {unknown} value
 * @param {string} readerUrl
 */
function isReaderDocumentUrl(value, readerUrl) {
  return typeof value === 'string' && (value === readerUrl || value.startsWith(`${readerUrl}#`));
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function safeId(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * @param {unknown} value
 * @returns {'background-tab' | 'foreground-tab' | 'current-tab'}
 */
function normalizeOpenMode(value) {
  if (value === 'background-tab' || value === 'foreground-tab' || value === 'current-tab') return value;
  throw createAppError(ERROR_CODES.VALIDATION_ERROR, {
    details: { field: 'mode', reason: 'invalid open mode' },
  });
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function requireString(value, field) {
  if (typeof value === 'string' && value.length > 0) return value;
  throw createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field, reason: 'must be a string' } });
}

/**
 * @param {unknown} sender
 * @returns {number | null}
 */
function senderTabIdFrom(sender) {
  if (typeof sender !== 'object' || sender === null || !('tab' in sender)) return null;
  const tab = /** @type {{tab?: {id?: unknown}}} */ (sender).tab;
  return typeof tab?.id === 'number' && Number.isSafeInteger(tab.id) && tab.id >= 0 ? tab.id : null;
}

/**
 * @returns {BrowserLike}
 */
function getBrowserApi() {
  return /** @type {{browser: BrowserLike}} */ (/** @type {unknown} */ (globalThis)).browser;
}
