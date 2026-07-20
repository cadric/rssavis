// @ts-check

import { setResolvedIconUrl } from '../data/feed-management-repository.js';
import { createFeedRepository } from '../data/feed-repository.js';
import { readHostWindow } from '../data/host-throttle-repository.js';
import { hostKey, originPatternForUrl, tryNormalizeHttpUrl } from '../domain/urls.js';

/**
 * Response body cap for site-HTML icon discovery. Icon `<link>` tags live in the
 * document head, so a modest cap is plenty and keeps a hostile page bounded.
 */
const MAX_ICON_HTML_BYTES = 512 * 1024;

/**
 * Hard ceiling for a single site-HTML icon fetch. Icon discovery is best-effort
 * and fired fire-and-forget, so a slow or stalled origin must never pin the
 * fetch open; the AbortController trips at this deadline.
 */
const ICON_FETCH_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} IconResolverDependencies
 * @property {ReturnType<typeof createFeedRepository>} [feeds]
 * @property {(feedId: string, iconUrl: string) => Promise<{feed: import('../data/models.js').FeedRecord | null}>} [setResolvedIconUrl]
 * @property {(url: string, init: RequestInit) => Promise<IconFetchResponse>} [fetchImpl]
 * @property {(origin: string) => Promise<boolean>} [containsOrigin]
 * @property {(hostKey: string, nowMs: number) => Promise<{nextAllowedAtMs: number, lastStatus: number}>} [readHostWindow]
 * @property {(html: string) => Document} [parseHtml]
 * @property {() => number} [now]
 *
 * @typedef {object} IconFetchResponse
 * @property {boolean} ok
 * @property {number} status
 * @property {string} [type]
 * @property {{get: (name: string) => string | null}} headers
 * @property {IconResponseBody | null} [body]
 * @property {() => Promise<string>} [text]
 *
 * @typedef {object} IconResponseBody
 * @property {() => IconResponseReader} getReader
 *
 * @typedef {object} IconResponseReader
 * @property {() => Promise<{done: boolean, value?: Uint8Array}>} read
 * @property {() => void} [releaseLock]
 *
 * @typedef {{contains: (query: {origins: string[]}) => Promise<boolean>}} PermissionsLike
 */

/**
 * LOCKED decision #5 + NET-009: resolve `<link rel="icon">` icons in the
 * background against origins already granted through the feed's permission
 * origin. Never prompts, never fetches an ungranted origin, never touches a
 * third-party icon service, and never awaits the fetch/DOMParser inside a
 * transaction (read feed -> fetch outside txn -> write iconUrl in its own txn).
 *
 * @param {import('../data/transaction.js').TransactionOptions} [options]
 * @param {{permissions?: PermissionsLike} | undefined} [browserApi]
 * @param {IconResolverDependencies} [dependencies]
 */
export function createIconResolver(options = {}, browserApi = undefined, dependencies = {}) {
  const feeds = dependencies.feeds ?? createFeedRepository(options);
  const persistIconUrl =
    dependencies.setResolvedIconUrl ?? ((feedId, iconUrl) => setResolvedIconUrl(feedId, iconUrl, options));
  const now = dependencies.now ?? Date.now;
  const fetchImpl = dependencies.fetchImpl ?? defaultFetch;
  const parseHtml = dependencies.parseHtml ?? defaultParseHtml;
  const readWindow = dependencies.readHostWindow ?? ((key, nowMs) => readHostWindow(options, key, nowMs));
  const containsOrigin = dependencies.containsOrigin ?? defaultContainsOrigin(browserApi);

  /**
   * @param {string} feedId
   */
  async function resolveIcon(feedId) {
    const feed = await feeds.get(feedId);
    if (!feed) return skip('not-found');
    // Only the "auto" source consumes a resolved iconUrl; favicon/builtin never fetch.
    if (feed.iconSource && feed.iconSource !== 'auto') return skip('icon-source');
    if (stringValue(feed.iconUrl)) return skip('already-set');

    // SEC gate (NET-009): only fetch an origin the browser has already granted.
    const documentUrl = await selectGrantedDocumentUrl(feed, containsOrigin);
    if (!documentUrl) return skip('not-granted');

    // Respect B31's per-host throttle window: never fetch while it is closed.
    const nowMs = now();
    const window = await readWindow(hostKey(documentUrl), nowMs);
    if (window && window.nextAllowedAtMs > nowMs) return skip('throttled');

    // Fetch + parse OUTSIDE any transaction.
    const fetched = await fetchSiteHtml(fetchImpl, documentUrl);
    if (!fetched.ok) return { status: 'skipped', reason: fetched.reason, fetched: true };
    const iconUrl = pickBestIcon(parseHtml(fetched.html), documentUrl);
    if (!iconUrl) return { status: 'skipped', reason: 'no-icon', fetched: true };

    // Persist to the existing iconUrl field in its own transaction (only if still empty).
    const result = await persistIconUrl(feedId, iconUrl);
    return { status: 'resolved', iconUrl, feed: result.feed, fetched: true };
  }

  return { resolveIcon };
}

/**
 * Ordered document-URL candidates: the discovered site homepage first, then the
 * feed's own origin homepage (which equals the feed permissionOrigin). The first
 * candidate whose origin is granted is used; if none is granted we skip entirely.
 * @param {{siteUrl?: unknown, url?: unknown}} feed
 * @param {(origin: string) => Promise<boolean>} containsOrigin
 * @returns {Promise<string>}
 */
async function selectGrantedDocumentUrl(feed, containsOrigin) {
  // Candidates come from tryNormalizeHttpUrl / a validated feed origin, so
  // originPatternForUrl never throws here.
  for (const url of documentUrlCandidates(feed)) {
    if (await containsOrigin(originPatternForUrl(url))) return url;
  }
  return '';
}

/**
 * @param {{siteUrl?: unknown, url?: unknown}} feed
 * @returns {string[]}
 */
function documentUrlCandidates(feed) {
  /** @type {string[]} */
  const candidates = [];
  const siteUrl = tryNormalizeHttpUrl(feed.siteUrl);
  if (siteUrl) candidates.push(siteUrl);
  const feedUrl = tryNormalizeHttpUrl(feed.url);
  if (feedUrl) {
    const homepage = `${new URL(feedUrl).origin}/`;
    if (!candidates.includes(homepage)) candidates.push(homepage);
  }
  return candidates;
}

/**
 * @param {(url: string, init: RequestInit) => Promise<IconFetchResponse>} fetchImpl
 * @param {string} url
 * @returns {Promise<{ok: true, html: string} | {ok: false, reason: string}>}
 */
async function fetchSiteHtml(fetchImpl, url) {
  // A fetch/read rejection (network error or the abort deadline) propagates to the
  // fire-and-forget caller, which logs it; icon resolution is best-effort and never
  // blocks a refresh. The AbortController bounds a slow origin and lets the size-cap
  // reader stop a hostile body mid-stream.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ICON_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      // NET-009: never follow a redirect. The granted-origin gate only validated the
      // initial URL, so a 3xx could reach an ungranted origin (SSRF/privacy). With
      // redirect:'manual' a 3xx yields an opaque-redirect (status 0, ok false) which
      // we skip below instead of issuing a follow-up GET.
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      headers: { accept: 'text/html' },
      signal: controller.signal,
    });
    if (!response) return { ok: false, reason: 'http-error' };
    if (response.type === 'opaqueredirect') return { ok: false, reason: 'redirect' };
    if (!response.ok) return { ok: false, reason: 'http-error' };
    const contentType = String(response.headers.get('content-type') ?? '');
    if (!/^\s*text\/html\b/iu.test(contentType)) return { ok: false, reason: 'not-html' };
    // Cheap early-out: reject an honestly-declared oversized body before reading it.
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ICON_HTML_BYTES) {
      return { ok: false, reason: 'too-large' };
    }
    // Stream and cap: a granted-but-hostile origin that omits/understates
    // content-length cannot buffer an unbounded body into the background page.
    const html = await readCappedHtml(response, controller);
    if (html === null) return { ok: false, reason: 'too-large' };
    return { ok: true, html };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Reads the response body chunk by chunk, decoding as it goes, and stops the
 * moment the accumulated byte count exceeds MAX_ICON_HTML_BYTES: it aborts the
 * in-flight fetch and returns null (discard + skip) so a hostile stream is
 * bounded. Returns '' when there is no readable body (nothing to parse).
 * @param {IconFetchResponse} response
 * @param {AbortController} controller
 * @returns {Promise<string | null>}
 */
async function readCappedHtml(response, controller) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_ICON_HTML_BYTES) {
        controller.abort();
        return null;
      }
      html += decoder.decode(value, { stream: true });
    }
    html += decoder.decode();
    return html;
  } finally {
    // Both exits (stream done, or over-cap after controller.abort) leave no pending
    // read, so releaseLock cannot throw here; it just frees the lock as hygiene.
    reader.releaseLock?.();
  }
}

/**
 * Selects the largest `rel~="icon"` candidate, resolving relative hrefs against
 * the document URL. `rel~="icon"` matches the whitespace-separated `icon` token
 * (so `shortcut icon` qualifies) but not single hyphenated tokens like
 * `apple-touch-icon`.
 * @param {Document | null} doc
 * @param {string} baseUrl
 * @returns {string}
 */
function pickBestIcon(doc, baseUrl) {
  if (!doc) return '';
  let best = '';
  let bestArea = -1;
  for (const link of doc.querySelectorAll('link')) {
    const rel = String(link.getAttribute('rel') ?? '')
      .toLowerCase()
      .split(/\s+/u);
    if (!rel.includes('icon')) continue;
    const resolved = tryNormalizeHttpUrl(String(link.getAttribute('href') ?? '').trim(), baseUrl);
    if (!resolved) continue;
    const area = iconArea(String(link.getAttribute('sizes') ?? ''));
    if (area > bestArea) {
      bestArea = area;
      best = resolved;
    }
  }
  return best;
}

/**
 * @param {string} sizes
 * @returns {number}
 */
function iconArea(sizes) {
  const value = sizes.trim().toLowerCase();
  if (!value) return 0;
  if (value.split(/\s+/u).includes('any')) return Number.MAX_SAFE_INTEGER;
  let max = 0;
  for (const token of value.split(/\s+/u)) {
    const match = /^(\d+)x(\d+)$/u.exec(token);
    if (match) max = Math.max(max, Number(match[1]) * Number(match[2]));
  }
  return max;
}

/**
 * @param {string} html
 * @returns {Document}
 */
function defaultParseHtml(html) {
  // DOMParser produces an inert document and never evaluates scripts.
  return new DOMParser().parseFromString(html, 'text/html');
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<IconFetchResponse>}
 */
function defaultFetch(url, init) {
  return /** @type {Promise<IconFetchResponse>} */ (/** @type {unknown} */ (fetch(url, init)));
}

/**
 * @param {{permissions?: PermissionsLike} | undefined} browserApi
 * @returns {(origin: string) => Promise<boolean>}
 */
function defaultContainsOrigin(browserApi) {
  return async (origin) => {
    if (!browserApi || !browserApi.permissions) return false;
    return Boolean(await browserApi.permissions.contains({ origins: [origin] }));
  };
}

/**
 * @param {string} reason
 */
function skip(reason) {
  return { status: 'skipped', reason, fetched: false };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringValue(value) {
  return typeof value === 'string' ? value : '';
}
