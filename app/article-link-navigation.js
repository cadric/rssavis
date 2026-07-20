// @ts-check

export const ARTICLE_ACTION_SELECTOR =
  '[data-article-copy], [data-article-open], [data-article-title-open], [data-article-read], [data-article-star], [data-article-expand], [data-article-content-link]';

/**
 * @param {MouseEvent} event
 * @param {HTMLElement} action
 */
export function shouldUseArticleBridgeNavigation(event, action) {
  return (
    action.matches(
      'a[href][data-article-open], a[href][data-article-title-open], a[href][data-article-content-link]',
    ) &&
    (event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      (typeof event.button === 'number' && event.button !== 0))
  );
}
