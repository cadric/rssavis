// @ts-check

/**
 * Keeps a user-expanded article pinned to the top of the Reader scrollport
 * (FreshRSS "sticky" open article). Collapsing a long article above the new
 * target otherwise removes the browser's scroll anchor and throws the target
 * far above the viewport. Positioning is instant so the scroll-read marker can
 * be reseeded before the next rendering update; programmatic repositioning
 * must never count as the user scrolling rows past the top.
 *
 * @typedef {object} ExpansionLayoutHooks
 * @property {(id: string, expanded: boolean) => void} onExpansionCommitted Called synchronously after the expansion state paints.
 * @property {(id: string) => void} onExpansionContentReady Called synchronously after the preview detail paints.
 */

/**
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {{scrollMarker: {reseed(input: import('./article-scroll-marker.js').ScrollMarkerInput): void}}} runtime
 * @returns {ExpansionLayoutHooks}
 */
export function createExpansionLayoutHooks(input, runtime) {
  let pinnedScrollTop = -1;
  return {
    onExpansionCommitted(id, expanded) {
      const scrollTop = pinArticleRowToTop(input.options.documentRef, id, { onlyWhenAbove: !expanded });
      pinnedScrollTop = expanded ? scrollTop : -1;
      runtime.scrollMarker.reseed(input);
    },
    onExpansionContentReady(id) {
      const main = readerMain(input.options.documentRef);
      // Re-pin only when nothing moved since the commit pin, e.g. a row near
      // the end of the list that could not reach the top before its body grew.
      if (!main || pinnedScrollTop < 0 || main.scrollTop !== pinnedScrollTop) return;
      pinnedScrollTop = pinArticleRowToTop(input.options.documentRef, id);
      runtime.scrollMarker.reseed(input);
    },
  };
}

/**
 * Aligns the article row's top edge with the Reader scrollport top.
 * @param {Document} documentRef
 * @param {string} articleId
 * @param {{onlyWhenAbove?: boolean}} [options] When set, only rows above the scrollport top move.
 * @returns {number} The resulting scrollTop, or -1 when the row or scrollport is unavailable.
 */
export function pinArticleRowToTop(documentRef, articleId, options = {}) {
  const main = readerMain(documentRef);
  if (!main || main.hidden || !articleId) return -1;
  const row = [...main.querySelectorAll('.article-row[data-article-id]')].find(
    (candidate) =>
      candidate instanceof requireView(documentRef).HTMLElement && candidate.dataset.articleId === articleId,
  );
  if (!row) return -1;
  const distance = row.getBoundingClientRect().top - main.getBoundingClientRect().top;
  if (options.onlyWhenAbove ? distance < 0 : distance !== 0) main.scrollTop = Math.max(0, main.scrollTop + distance);
  return main.scrollTop;
}

/** @param {Document} documentRef */
function readerMain(documentRef) {
  const main = documentRef.querySelector('[data-reader-main]');
  return main instanceof requireView(documentRef).HTMLElement ? main : null;
}

/** @param {Document} documentRef */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}
