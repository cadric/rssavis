// @ts-check

import { scopeToStorageKey } from '../domain/scopes.js';

/**
 * @typedef {import('./state-store.js').createUiStateStore} UiStateStoreFactory
 * @typedef {Awaited<ReturnType<ReturnType<UiStateStoreFactory>['read']>>} UiStateRecord
 */

/**
 * @param {Document} documentRef
 * @param {{getState(): UiStateRecord | null, getArticleState?(): {searchActive?: boolean}, rememberScroll(scope: import('../domain/scopes.js').Scope, entry: {scrollTop: number, anchorArticleId?: string}): Promise<UiStateRecord>}} input
 * @returns {Promise<UiStateRecord | null>}
 */
export async function rememberReaderScroll(documentRef, input) {
  const state = input.getState();
  if (!state) return null;
  if (input.getArticleState?.().searchActive === true) return state;
  const main = documentRef.querySelector('[data-reader-main]');
  if (!isHtmlElement(main)) return null;
  const anchor = firstVisibleArticleRow(documentRef, main);
  if (!anchor) return null;
  const anchorArticleId = anchor.dataset.articleId ?? '';
  if (!anchorArticleId) return null;
  const anchorOffset = Math.trunc(main.getBoundingClientRect().top - anchor.getBoundingClientRect().top);
  return input.rememberScroll(state.activeScope, {
    anchorArticleId: anchorOffset >= 0 ? anchorArticleId : '',
    scrollTop: anchorOffset >= 0 ? anchorOffset : Math.max(0, Math.trunc(main.scrollTop)),
  });
}

/**
 * @param {Document} documentRef
 * @param {UiStateRecord} state
 */
export function restoreReaderScroll(documentRef, state) {
  const main = documentRef.querySelector('[data-reader-main]');
  const entry = state.scrollByScope[scopeToStorageKey(state.activeScope)];
  if (!isHtmlElement(main) || !entry) return;
  if (!entry.anchorArticleId) {
    main.scrollTop = entry.scrollTop;
    return;
  }
  const anchor = entry.anchorArticleId ? articleRowById(documentRef, entry.anchorArticleId) : null;
  if (!anchor) {
    return;
  }
  const mainRect = main.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const nextScrollTop = main.scrollTop + (anchorRect.top - mainRect.top) + entry.scrollTop;
  main.scrollTop = Math.max(0, Math.trunc(nextScrollTop));
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} main
 */
function firstVisibleArticleRow(documentRef, main) {
  const mainRect = main.getBoundingClientRect();
  for (const row of documentRef.querySelectorAll('.article-row')) {
    if (!isHtmlElement(row)) continue;
    const rowRect = row.getBoundingClientRect();
    if (rowRect.bottom <= mainRect.top || rowRect.top >= mainRect.bottom) continue;
    return row;
  }
  return null;
}

/**
 * @param {Document} documentRef
 * @param {string} articleId
 */
function articleRowById(documentRef, articleId) {
  for (const row of documentRef.querySelectorAll('.article-row')) {
    if (isHtmlElement(row) && row.dataset.articleId === articleId) return row;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}
