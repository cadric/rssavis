// @ts-check

import { displayTitle } from '../domain/feed-title.js';
import { applyFeedIcon } from './feed-icons.js';
import { note, numberValue, sectionShell, stringValue } from './management-shared.js';
import { cloneTemplate, queryRequired } from './templates.js';

/**
 * @typedef {object} ManagementI18n
 * @property {(key: string, substitutions?: string | number | Array<string | number>) => string} getMessage
 * @property {(value: number | Date) => string} [formatDate]
 */

/**
 * @param {Document} documentRef
 * @param {{categories: Array<Record<string, unknown>>, deletingFeeds?: Array<Record<string, unknown>>, feeds: Array<Record<string, unknown>>}} snapshot
 * @param {ManagementI18n} i18n
 */
export function renderFeedsSection(documentRef, snapshot, i18n) {
  const getMessage = i18n.getMessage;
  const section = sectionShell(documentRef, {
    subtitle: getMessage('settingsFeedsSubtitle'),
    title: getMessage('settingsFeeds'),
  });
  const list = documentRef.createElement('div');
  list.className = 'settings-list';
  for (const feed of snapshot.feeds) list.append(feedRow(documentRef, snapshot, feed, i18n));
  for (const feed of snapshot.deletingFeeds ?? []) {
    list.append(note(documentRef, getMessage('feedDeletingStatus', [stringValue(feed.title)])));
  }
  section.append(list);
  return section;
}

/**
 * @param {Document} documentRef
 * @param {{categories: Array<Record<string, unknown>>}} snapshot
 * @param {Record<string, unknown>} feed
 * @param {ManagementI18n} i18n
 */
function feedRow(documentRef, snapshot, feed, i18n) {
  const getMessage = i18n.getMessage;
  const row = cloneTemplate(documentRef, 'data-feed-row-template', '.management-item-row');
  const id = stringValue(feed.id);
  row.dataset.feedId = id;
  row.dataset.categoryId = stringValue(feed.categoryId);
  const grip = /** @type {HTMLButtonElement} */ (queryRequired(row, '[data-feed-grip]'));
  grip.dataset.feedId = id;
  grip.dataset.categoryId = stringValue(feed.categoryId);
  grip.setAttribute('title', getMessage('feedReorderGrip'));
  grip.setAttribute('aria-label', getMessage('feedReorderGripFor', [displayTitle(feed)]));
  applyFeedIcon(documentRef, row, { ...feed, feedUrl: feed.url }, { imageLoading: 'never', lazyLoadImages: false });
  queryRequired(row, '[data-feed-row-title]').textContent = displayTitle(feed);
  queryRequired(row, '[data-feed-row-url]').textContent = stringValue(feed.url);
  const category = snapshot.categories.find((item) => stringValue(item.id) === stringValue(feed.categoryId));
  queryRequired(row, '[data-feed-row-category]').textContent = stringValue(category?.title);
  const status = queryRequired(row, '[data-feed-row-status]');
  const statusText = feedStatusText(feed, i18n);
  status.hidden = !statusText;
  status.textContent = statusText;
  status.classList.toggle('management-row-status--rate-limit', isRateLimitOnly(feed));
  const trigger = /** @type {HTMLButtonElement} */ (queryRequired(row, '[data-feed-menu-trigger]'));
  trigger.dataset.feedId = id;
  trigger.dataset.categoryId = stringValue(feed.categoryId);
  trigger.setAttribute('title', getMessage('feedOptions'));
  trigger.setAttribute('aria-label', getMessage('feedOptionsFor', [stringValue(feed.title)]));
  return row;
}

/**
 * @param {Record<string, unknown>} feed
 * @param {ManagementI18n} i18n
 */
function feedStatusText(feed, i18n) {
  const getMessage = i18n.getMessage;
  const items = [];
  if (stringValue(feed.redirectOriginPending)) items.push(getMessage('feedRedirectPermissionRequired'));
  else if (numberValue(feed.permissionState) !== 1) items.push(getMessage('feedPermissionMissing'));
  if (isRateLimited(feed))
    items.push(getMessage('feedRateLimited', [formatDate(i18n, numberValue(feed.nextFetchAtMs))]));
  else items.push(...feedErrorStatus(feed, i18n));
  return items.join(' · ');
}

/**
 * A deferred (rate-limited) feed carries `lastHttpStatus === 429` with a
 * cleared error code. This is not a failure, so it is surfaced as a plain
 * status line rather than through the error path.
 *
 * @param {Record<string, unknown>} feed
 */
function isRateLimited(feed) {
  return numberValue(feed.lastHttpStatus) === 429 && !stringValue(feed.lastErrorCode);
}

/**
 * True when the row's only status is the rate-limit line (no permission or
 * redirect problem alongside it), so the status slot can drop its destructive
 * tone. A permission/redirect problem keeps the attention styling.
 *
 * @param {Record<string, unknown>} feed
 */
function isRateLimitOnly(feed) {
  return isRateLimited(feed) && !stringValue(feed.redirectOriginPending) && numberValue(feed.permissionState) === 1;
}

/**
 * @param {Record<string, unknown>} feed
 * @param {ManagementI18n} i18n
 */
function feedErrorStatus(feed, i18n) {
  const getMessage = i18n.getMessage;
  const errorCode = stringValue(feed.lastErrorCode);
  if (!errorCode) return [];
  const items = [getMessage('feedLastErrorStatus', [safeErrorLabel(feed, getMessage, errorCode)])];
  const httpStatus = numberValue(feed.lastHttpStatus);
  const lastCheckedAtMs = numberValue(feed.lastCheckedAtMs);
  const nextFetchAtMs = numberValue(feed.nextFetchAtMs);
  if (httpStatus > 0) items.push(getMessage('feedHttpStatusValue', [httpStatus]));
  if (lastCheckedAtMs > 0) items.push(getMessage('feedLastCheckedValue', [formatDate(i18n, lastCheckedAtMs)]));
  if (nextFetchAtMs > 0) items.push(getMessage('feedNextRetryValue', [formatDate(i18n, nextFetchAtMs)]));
  return items;
}

/**
 * @param {ManagementI18n} i18n
 * @param {number} value
 */
function formatDate(i18n, value) {
  return i18n.formatDate ? i18n.formatDate(value) : new Intl.DateTimeFormat('en').format(value);
}

/**
 * @param {Record<string, unknown>} feed
 * @param {(key: string) => string} getMessage
 * @param {string} fallbackCode
 */
function safeErrorLabel(feed, getMessage, fallbackCode) {
  const messageKey = stringValue(feed.lastErrorMessage);
  if (/^error[A-Z][A-Za-z0-9]*$/u.test(messageKey)) {
    try {
      return getMessage(messageKey);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return fallbackCode;
    }
  }
  return fallbackCode;
}
