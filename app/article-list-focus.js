// @ts-check

/**
 * @typedef {object} ArticleFocusTarget
 * @property {'content-link' | 'copy-link' | 'expander' | 'load-more' | 'mark-read' | 'open' | 'star'} action
 * @property {number} index
 * @property {string} articleId
 * @property {string} [href]
 * @property {number} [occurrence]
 */

/** @type {WeakMap<HTMLElement, ArticleFocusTarget>} */
const loadMoreFocusIntents = new WeakMap();

/** @param {HTMLElement} root @param {boolean} busy */
export function captureArticleListRenderFocus(root, busy) {
  const active = root.ownerDocument.activeElement;
  const captured = captureArticleListFocus(root);
  if (captured?.action === 'load-more') loadMoreFocusIntents.set(root, captured);
  if (captured) return captured;
  if (busy) return null;
  const remembered = loadMoreFocusIntents.get(root) ?? null;
  return active === root.ownerDocument.body || !active?.isConnected ? remembered : null;
}

/** @param {HTMLElement} root @param {ArticleFocusTarget | null} target @param {boolean} busy */
export function restoreArticleListRenderFocus(root, target, busy) {
  if (!busy) loadMoreFocusIntents.delete(root);
  if (busy && target?.action === 'load-more') return;
  restoreArticleListFocus(root, target);
}

/** @param {HTMLElement} root @returns {ArticleFocusTarget | null} */
export function captureArticleListFocus(root) {
  const active = root.ownerDocument.activeElement;
  if (!isElement(active) || !root.contains(active)) return null;
  if (active.closest('[data-load-more]')) {
    return { action: 'load-more', articleId: '', index: root.querySelectorAll('[data-article-id]').length };
  }
  const row = active.closest('[data-article-id]');
  if (!isElement(row)) return null;
  const action = articleFocusAction(active);
  if (!action) return null;
  const rows = [...root.querySelectorAll('[data-article-id]')];
  const contentLink = active.closest('[data-article-content-link]');
  const href = contentLink?.getAttribute('data-article-content-link') ?? '';
  const sameHrefLinks = contentLink
    ? [...row.querySelectorAll('[data-article-content-link]')].filter(
        (link) => link.getAttribute('data-article-content-link') === href,
      )
    : [];
  return {
    action,
    articleId: row.getAttribute('data-article-id') ?? '',
    href,
    index: Math.max(0, rows.indexOf(row)),
    occurrence: Math.max(0, contentLink ? sameHrefLinks.indexOf(contentLink) : 0),
  };
}

/** @param {HTMLElement} root @param {ArticleFocusTarget | null} target */
export function restoreArticleListFocus(root, target) {
  if (!target) return;
  const exact = focusControlFor(root, target.articleId, target);
  if (focusArticleCandidate(root.ownerDocument, exact)) return;
  const rows = [...root.querySelectorAll('[data-article-id]')];
  if (target.action === 'load-more') {
    const positionalRow = rows[Math.min(target.index, rows.length - 1)] ?? rows.at(-1) ?? null;
    const expander = positionalRow?.querySelector('[data-article-expand]') ?? null;
    if (!focusArticleCandidate(root.ownerDocument, expander)) focusReaderMain(root);
    return;
  }
  const fallbackRow = rows[Math.min(target.index, rows.length - 1)] ?? rows.at(-1) ?? null;
  const fallbackId = fallbackRow?.getAttribute('data-article-id') ?? '';
  const fallback = fallbackId ? focusControlFor(root, fallbackId, target) : null;
  if (focusArticleCandidate(root.ownerDocument, fallback)) return;
  if (focusArticleCandidate(root.ownerDocument, fallbackRow?.querySelector('[data-article-expand]'))) return;
  const localControl = fallbackRow?.querySelector('button:not(:disabled), a[href], [tabindex]') ?? null;
  if (focusArticleCandidate(root.ownerDocument, localControl)) return;
  const firstControl = root.querySelector('button:not(:disabled), a[href], [tabindex]');
  if (!focusArticleCandidate(root.ownerDocument, firstControl)) focusReaderMain(root);
}

/** @param {HTMLElement} root @param {string} articleId @param {ArticleFocusTarget} target */
function focusControlFor(root, articleId, target) {
  if (target.action === 'load-more') {
    const loadMore = root.querySelector('[data-load-more]');
    return isHtmlElement(root.ownerDocument, loadMore) ? loadMore : null;
  }
  if (target.action === 'content-link') {
    const row = root.querySelector(`[data-article-id="${cssEscape(articleId)}"]`);
    if (!row) return null;
    const links = [...row.querySelectorAll('[data-article-content-link]')].filter(
      (link) => link.getAttribute('data-article-content-link') === (target.href ?? ''),
    );
    const control = links[target.occurrence ?? 0] ?? null;
    return isHtmlElement(root.ownerDocument, control) ? control : null;
  }
  const control = root.querySelector(articleFocusSelector(articleId, target));
  return isHtmlElement(root.ownerDocument, control) ? control : null;
}

/** @param {HTMLElement} root */
function focusReaderMain(root) {
  const readerMain = root.ownerDocument.querySelector('[data-reader-main]');
  focusArticleCandidate(root.ownerDocument, readerMain);
}

/** @param {Document} documentRef @param {Element | null | undefined} target */
function focusArticleCandidate(documentRef, target) {
  if (!isHtmlElement(documentRef, target) || !target.isConnected) return false;
  if (target.hidden || target.closest('[hidden], [aria-hidden="true"]') || target.matches(':disabled')) return false;
  const style = requireView(documentRef).getComputedStyle(target);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  target.focus();
  return documentRef.activeElement === target;
}

/** @param {Element} element @returns {ArticleFocusTarget['action'] | null} */
function articleFocusAction(element) {
  if (element.closest('[data-article-content-link]')) return 'content-link';
  if (element.closest('[data-article-expand]')) return 'expander';
  if (element.closest('[data-article-star]')) return 'star';
  if (element.closest('[data-article-open]')) return 'open';
  if (element.closest('[data-article-read]')) return 'mark-read';
  if (element.closest('[data-article-copy]')) return 'copy-link';
  return null;
}

/** @param {string} articleId @param {ArticleFocusTarget} target */
function articleFocusSelector(articleId, target) {
  const id = cssEscape(articleId);
  if (target.action === 'expander') return `[data-article-expand="${id}"]`;
  if (target.action === 'star') return `[data-article-star="${id}"]`;
  if (target.action === 'open') return `[data-article-open="${id}"]`;
  if (target.action === 'mark-read') return `[data-article-read="${id}"]`;
  return `[data-article-copy="${id}"]`;
}

/** @param {string} value */
function cssEscape(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/** @param {Document} documentRef @param {unknown} value @returns {value is HTMLElement} */
function isHtmlElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLElement;
}

/** @param {unknown} value @returns {value is Element} */
function isElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}

/** @param {Document} documentRef */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}
