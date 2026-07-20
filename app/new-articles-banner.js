// @ts-check

import { announceStatus } from './toasts.js';

/** @type {WeakMap<Document, {visible: boolean}>} */
const renderStateByDocument = new WeakMap();
/** @type {WeakSet<Document>} */
const pointerBoundDocuments = new WeakSet();

/**
 * @param {Document} documentRef
 * @param {import('./reader-state.js').ArticleState} articleState
 * @param {{getMessage(key: string): string}} i18n
 */
export function renderNewArticlesBanner(documentRef, articleState, i18n) {
  const banner = documentRef.querySelector('[data-new-articles-banner]');
  const title = banner?.querySelector('[data-new-articles-title]');
  const action = banner?.querySelector('[data-new-articles-action]');
  if (!isHtmlElement(banner) || !isHtmlElement(title) || !isButtonElement(action)) return;
  const renderState = renderStateByDocument.get(documentRef) ?? { visible: false };
  const available = articleState.newArticlesAvailable;
  if (!available) {
    const hadFocus = documentRef.activeElement === action;
    banner.hidden = true;
    banner.removeAttribute('data-revision');
    action.disabled = false;
    action.removeAttribute('aria-busy');
    renderState.visible = false;
    renderStateByDocument.set(documentRef, renderState);
    rearmAnnouncement(documentRef, i18n.getMessage('newArticlesAvailable'));
    if (hadFocus) focusReaderMain(documentRef);
    return;
  }
  const message = i18n.getMessage('newArticlesAvailable');
  const actionMessage = i18n.getMessage('newArticlesShow');
  banner.hidden = false;
  banner.dataset.revision = String(available.dataRevision);
  if (title.textContent !== message) title.textContent = message;
  if (action.textContent !== actionMessage) action.textContent = actionMessage;
  action.disabled = available.busy;
  if (available.busy) action.setAttribute('aria-busy', 'true');
  else action.removeAttribute('aria-busy');
  const reader = documentRef.querySelector('[data-reader-main]');
  const revealVisible = documentRef.hidden !== true && isHtmlElement(reader) && !reader.hidden;
  if (!renderState.visible && revealVisible) {
    announceStatus(documentRef, message);
    renderState.visible = true;
  }
  renderStateByDocument.set(documentRef, renderState);
}

/** @param {Document} documentRef @param {string} message */
function rearmAnnouncement(documentRef, message) {
  const status = documentRef.querySelector('[data-rssavis-status]');
  if (isHtmlElement(status) && status.textContent === message) status.textContent = '';
}

/**
 * Pointer activation must not move focus into a banner that may disappear.
 * Keyboard activation is left untouched and receives the normal focus return.
 * @param {Document} documentRef
 */
export function bindNewArticlesBannerPointerBehavior(documentRef) {
  if (pointerBoundDocuments.has(documentRef)) return;
  pointerBoundDocuments.add(documentRef);
  documentRef.addEventListener('pointerdown', (event) => {
    const target = isHtmlElement(event.target) ? event.target.closest('[data-new-articles-action]') : null;
    if (target) event.preventDefault();
  });
}

/** @param {Document} documentRef */
function focusReaderMain(documentRef) {
  const main = documentRef.querySelector('[data-reader-main]');
  if (isHtmlElement(main)) main.focus();
}

/** @param {unknown} value @returns {value is HTMLElement} */
function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}

/** @param {unknown} value @returns {value is HTMLButtonElement} */
function isButtonElement(value) {
  return isHtmlElement(value) && 'disabled' in value;
}
