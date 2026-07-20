// @ts-check

import { announceStatus, showToast } from './toasts.js';
import { isButtonElement } from './app-shell-utils.js';

/**
 * @typedef {import('./api-validation.js').RefreshAllSummary} RefreshAllSummary
 * @typedef {{getMessage(key: string, substitutions?: string | number | Array<string | number>): string, formatNumber?(value: number): string}} RefreshI18n
 */

/**
 * @param {{documentRef: Document, i18n: RefreshI18n}} options
 */
export function beginRefreshAllProgress(options) {
  setBusyState(options.documentRef, true);
  announceStatus(options.documentRef, options.i18n.getMessage('refreshStarted'));
}

/**
 * @param {{documentRef: Document, i18n: RefreshI18n}} options
 * @param {RefreshAllSummary} summary
 */
export function completeRefreshAllProgress(options, summary) {
  setBusyState(options.documentRef, false);
  showToast(options.documentRef, formatRefreshAllSummary(options.i18n, summary));
}

/**
 * @param {Document} documentRef
 */
export function endRefreshAllProgress(documentRef) {
  setBusyState(documentRef, false);
}

/**
 * @param {Document} documentRef
 * @param {boolean} busy
 */
function setBusyState(documentRef, busy) {
  for (const button of documentRef.querySelectorAll('[data-refresh-all]')) {
    if (!isButtonElement(documentRef, button)) continue;
    button.disabled = busy;
    if (busy) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }
}

/**
 * @param {RefreshI18n} i18n
 * @param {RefreshAllSummary} summary
 */
function formatRefreshAllSummary(i18n, summary) {
  return i18n.getMessage('refreshAllSummary', [
    formatNumber(i18n, summary.checkedCount),
    formatNumber(i18n, summary.updatedFeedCount),
    formatNumber(i18n, summary.unchangedFeedCount),
    formatNumber(i18n, summary.failedFeedCount),
    formatNumber(i18n, summary.newArticleCount),
  ]);
}

/**
 * @param {RefreshI18n} i18n
 * @param {number} value
 */
function formatNumber(i18n, value) {
  return i18n.formatNumber ? i18n.formatNumber(value) : new Intl.NumberFormat().format(value);
}
