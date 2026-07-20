// @ts-check

import { announceStatus } from './toasts.js';

/**
 * Tracks the last announced feed+action so a repeated render of the same
 * banner state does not re-announce, while a different feed (or hiding and
 * re-showing) still speaks.
 *
 * @type {string}
 */
let announcedKey = '';

/**
 * AdwBanner-style permission bar above the article list. Only a feed scope
 * with a missing host permission or a pending redirect shows the banner; the
 * redirect state wins when both apply (same precedence as the settings row
 * status in feed-list-view.js). The action button reuses the existing
 * [data-feed-action] delegation, so the grant flow stays on the
 * app/permission-request.js path.
 *
 * @param {Document} documentRef
 * @param {{activeScope: import('../domain/scopes.js').Scope}} state
 * @param {{feeds: Array<Record<string, unknown>>}} snapshot
 * @param {{getMessage(key: string, substitutions?: string | number | Array<string | number>): string}} i18n
 */
export function renderPermissionBanner(documentRef, state, snapshot, i18n) {
  const banner = documentRef.querySelector('[data-permission-banner]');
  if (!isHtmlElement(banner)) return;
  const text = banner.querySelector('[data-permission-banner-text]');
  const action = banner.querySelector('[data-permission-banner-action]');
  if (!isHtmlElement(text) || !isHtmlElement(action)) return;
  const feed =
    state.activeScope.type === 'feed'
      ? snapshot.feeds.find((item) => stringValue(item.id) === state.activeScope.id)
      : undefined;
  const pendingRedirect = Boolean(feed && stringValue(feed.redirectOriginPending));
  const missingPermission = Boolean(feed && numberValue(feed.permissionState) !== 1);
  if (!(pendingRedirect || missingPermission)) {
    hideBanner(documentRef, banner, action);
    return;
  }
  banner.hidden = false;
  action.dataset.feedId = stringValue(feed?.id);
  action.dataset.categoryId = stringValue(feed?.categoryId);
  action.dataset.feedAction = pendingRedirect ? 'grant-redirect' : 'grant-permission';
  const host = pendingRedirect
    ? hostLabel(stringValue(feed?.redirectUrlPending)) || stringValue(feed?.redirectOriginPending)
    : hostLabel(stringValue(feed?.url)) || stringValue(feed?.permissionOrigin);
  text.textContent = i18n.getMessage(pendingRedirect ? 'feedPermissionBannerRedirect' : 'feedPermissionBannerMissing', [
    host,
  ]);
  action.textContent = i18n.getMessage(pendingRedirect ? 'feedPermissionBannerAllow' : 'feedPermissionBannerGrant');
  announceOnce(documentRef, `${stringValue(feed?.id)}:${action.dataset.feedAction}`, text.textContent ?? '');
}

/**
 * Hides the banner. When it disappears while the grant button holds focus (the
 * post-grant reload), focus lands on the article list so keyboard users are not
 * stranded. Hiding also clears the announcement key so a later re-show speaks.
 *
 * @param {Document} documentRef
 * @param {HTMLElement} banner
 * @param {HTMLElement} action
 */
function hideBanner(documentRef, banner, action) {
  const hadFocus = documentRef.activeElement === action;
  banner.hidden = true;
  announcedKey = '';
  if (!hadFocus) return;
  const main = documentRef.querySelector('[data-reader-main]');
  if (isHtmlElement(main)) main.focus();
}

/**
 * @param {Document} documentRef
 * @param {string} key
 * @param {string} message
 */
function announceOnce(documentRef, key, message) {
  if (key === announcedKey) return;
  announcedKey = key;
  announceStatus(documentRef, message);
}

/** @param {string} url */
function hostLabel(url) {
  try {
    return new URL(url).host;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return '';
  }
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

/** @param {unknown} value */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}
