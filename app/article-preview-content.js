// @ts-check

import { renderArticleContent } from './article-content.js';
import { queryRequired } from './templates.js';

/**
 * Chooses rich or plain preview content and restores the plain fallback if a
 * later image failure leaves the rich render visually empty.
 * @param {Document} documentRef
 * @param {HTMLElement} content
 * @param {Record<string, unknown>} article
 * @param {import('./reader-settings.js').ReaderSettings} settings
 * @param {{deferRemoteImages?: boolean}} [options]
 */
export function configureArticlePreviewContent(documentRef, content, article, settings, options = {}) {
  const body = isRecord(article.body) ? article.body : null;
  const blocks = body && Array.isArray(body.contentBlocks) ? body.contentBlocks : [];
  const fragment =
    blocks.length > 0
      ? renderArticleContent(documentRef, blocks, settings, { deferRemoteImages: options.deferRemoteImages })
      : null;
  const paragraph = queryRequired(content, '[data-article-preview-body]');
  if (!fragment || !hasVisibleContent(fragment)) {
    paragraph.textContent = bodyText(article);
    return;
  }
  const rich = queryRequired(content, '[data-article-preview-rich]');
  rich.append(fragment);
  activateDeferredImages(rich);
  rich.hidden = false;
  paragraph.hidden = true;
  // Image errors do not bubble. Capture and defer so article-content's target
  // handler has removed the broken image or inserted its alt fallback first.
  rich.addEventListener(
    'error',
    () => {
      queueMicrotask(() => {
        if (hasVisibleContent(rich)) return;
        rich.hidden = true;
        rich.replaceChildren();
        paragraph.hidden = false;
        paragraph.textContent = bodyText(article);
      });
    },
    true,
  );
}

/** @param {ParentNode} root */
function activateDeferredImages(root) {
  for (const image of root.querySelectorAll('img[data-article-image-src]')) {
    const source = image.getAttribute('data-article-image-src') ?? '';
    image.removeAttribute('data-article-image-src');
    if (source) image.setAttribute('src', source);
  }
}

/**
 * A lone rule or an emptied figure is not meaningful article content. Readable
 * text or a remaining image is visible; everything else uses plain fallback.
 * @param {ParentNode} root
 */
function hasVisibleContent(root) {
  if ((root.textContent ?? '').trim() !== '') return true;
  return root.querySelector('img') !== null;
}

/** @param {Record<string, unknown>} article */
function bodyText(article) {
  const body = isRecord(article.body) && typeof article.body.contentText === 'string' ? article.body.contentText : '';
  return body || (typeof article.summaryText === 'string' ? article.summaryText : '');
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
