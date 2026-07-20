// @ts-check

import { httpsOnlyUrl } from '../domain/urls.js';
import { wrapArticleDestination } from './article-destination.js';

/**
 * @typedef {import('../domain/article-content-blocks.js').Block} Block
 * @typedef {import('../domain/article-content-blocks.js').Inline} Inline
 * @typedef {import('./reader-settings.js').ReaderSettings} ReaderSettings
 */

/**
 * Renders a validated `Block[]` (the article's rich content model — produced
 * by `background/content-sanitizer.js` and re-validated on read by
 * `validateContentBlocks`) into a `DocumentFragment`.
 *
 * This is the second of B35's two trust boundaries: the sanitizer never emits
 * raw HTML, and this renderer never turns text back into markup. DOM is built
 * with `createElement`/`createTextNode`/`textContent`/`append` only — no
 * `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `setHTML`,
 * `createContextualFragment`, `document.write`, or `DOMParser` anywhere in
 * this file. The private static-template policy gate enforces this over the
 * renderer.
 *
 * A `figure` block's `<img>` is a trust boundary of its own (SEC-005):
 * `block.src` is sanitizer-guaranteed https, but this renderer re-checks it
 * with `httpsOnlyUrl` before ever setting it as an `<img src>`, and whether
 * an `<img>` is created at all is gated on `settings.imageLoading` — see
 * `renderFigure` below, which mirrors `configureImageFigure` in
 * `app/article-preview.js`.
 *
 * Inline links use the same validated, background-owned navigation boundary
 * as article originals: a `link` inline node renders an
 * `<a class="article-content-link">`
 * whose navigable `href` is ALWAYS the internal bridge page owned by
 * `app/open-content-link.html` (never the raw feed URL). The validated https
 * feed URL rides only in `data-article-content-link`, which the app-shell click
 * handler forwards to the `articles.openContentLink` background command; a
 * modified/middle click instead lets the browser open the bridge href, which
 * re-validates the encoded URL before touching `browser.tabs`. `link.href` is
 * sanitizer-guaranteed https but is re-checked here with `httpsOnlyUrl` (this
 * renderer is a second trust boundary); a href that fails the re-check falls
 * back to a plain
 * `<span class="article-content-link">` with no navigation, so the text is
 * never lost.
 *
 * Defensive: `contentBlocks` is validated upstream, but this function treats
 * `blocks` as possibly-untrusted too — a non-array input renders an empty
 * fragment, and an unrecognized `type` at any level is skipped rather than
 * thrown on.
 *
 * @param {Document} documentRef
 * @param {Block[]} blocks
 * @param {ReaderSettings} settings gates inline image loading via `settings.imageLoading` (SEC-005) and `settings.lazyLoadImages`
 * @param {{deferRemoteImages?: boolean}} [options]
 * @returns {DocumentFragment}
 */
export function renderArticleContent(documentRef, blocks, settings, options = {}) {
  const fragment = documentRef.createDocumentFragment();
  if (!Array.isArray(blocks)) return fragment;
  appendBlocks(documentRef, fragment, blocks, settings, options.deferRemoteImages === true);
  return fragment;
}

/**
 * @param {Document} documentRef
 * @param {ParentNode} parent
 * @param {Block[]} blocks
 * @param {ReaderSettings} settings
 * @param {boolean} deferRemoteImages
 */
function appendBlocks(documentRef, parent, blocks, settings, deferRemoteImages) {
  for (const block of blocks) {
    const node = renderBlock(documentRef, block, settings, deferRemoteImages);
    if (node) parent.append(node);
  }
}

/**
 * @param {Document} documentRef
 * @param {Block} block
 * @param {ReaderSettings} settings
 * @param {boolean} deferRemoteImages
 * @returns {HTMLElement | null}
 */
function renderBlock(documentRef, block, settings, deferRemoteImages) {
  switch (block.type) {
    case 'paragraph':
      return renderParagraph(documentRef, block.children);
    case 'heading':
      return renderHeading(documentRef, block.level, block.children);
    case 'list':
      return renderList(documentRef, block.ordered, block.items);
    case 'blockquote':
      return renderBlockquote(documentRef, block.children, settings, deferRemoteImages);
    case 'code':
      return renderCodeBlock(documentRef, block.text);
    case 'rule':
      return documentRef.createElement('hr');
    case 'figure':
      return renderFigure(documentRef, block.src, block.alt, block.caption, settings, deferRemoteImages);
    default:
      return null;
  }
}

/**
 * @param {Document} documentRef
 * @param {Inline[]} children
 * @returns {HTMLParagraphElement}
 */
function renderParagraph(documentRef, children) {
  const paragraph = documentRef.createElement('p');
  paragraph.className = 'article-content-p';
  appendInline(documentRef, paragraph, children);
  return paragraph;
}

/**
 * @param {Document} documentRef
 * @param {2 | 3 | 4} level
 * @param {Inline[]} children
 * @returns {HTMLHeadingElement}
 */
function renderHeading(documentRef, level, children) {
  const heading =
    level === 2
      ? documentRef.createElement('h2')
      : level === 3
        ? documentRef.createElement('h3')
        : documentRef.createElement('h4');
  appendInline(documentRef, heading, children);
  return heading;
}

/**
 * @param {Document} documentRef
 * @param {boolean} ordered
 * @param {Inline[][]} items
 * @returns {HTMLElement}
 */
function renderList(documentRef, ordered, items) {
  const list = ordered ? documentRef.createElement('ol') : documentRef.createElement('ul');
  for (const item of items) {
    const listItem = documentRef.createElement('li');
    appendInline(documentRef, listItem, item);
    list.append(listItem);
  }
  return list;
}

/**
 * @param {Document} documentRef
 * @param {Block[]} children
 * @param {ReaderSettings} settings
 * @param {boolean} deferRemoteImages
 * @returns {HTMLQuoteElement}
 */
function renderBlockquote(documentRef, children, settings, deferRemoteImages) {
  const quote = documentRef.createElement('blockquote');
  appendBlocks(documentRef, quote, children, settings, deferRemoteImages);
  return quote;
}

/**
 * @param {Document} documentRef
 * @param {string} text
 * @returns {HTMLPreElement}
 */
function renderCodeBlock(documentRef, text) {
  const pre = documentRef.createElement('pre');
  const code = documentRef.createElement('code');
  code.textContent = text;
  pre.append(code);
  return pre;
}

/**
 * Renders a `figure` block under SEC-005 remote-image controls, mirroring
 * `configureImageFigure` in `app/article-preview.js`: `imageLoading: 'never'`
 * never creates an `<img>` element (no network request), and `on-expand` /
 * `always` render one with async decoding, `loading` matching
 * `settings.lazyLoadImages`, `referrerpolicy="no-referrer"`, and a
 * broken-image hide. `src` is sanitizer-guaranteed https already, but this
 * renderer is a second trust boundary and re-checks it with `httpsOnlyUrl`
 * before ever setting it as an `<img src>`; a non-https `src` (should not
 * occur post-sanitizer) falls back to the same alt/caption text path as
 * `imageLoading: 'never'`.
 *
 * @param {Document} documentRef
 * @param {string} src
 * @param {string} alt
 * @param {Inline[] | undefined} caption
 * @param {ReaderSettings} settings
 * @param {boolean} deferRemoteImages
 * @returns {HTMLElement | null}
 */
function renderFigure(documentRef, src, alt, caption, settings, deferRemoteImages) {
  const imageSrc = settings.imageLoading === 'never' ? '' : httpsOnlyUrl(src);
  return imageSrc
    ? renderFigureImage(documentRef, imageSrc, alt, caption, settings, deferRemoteImages)
    : renderFigureFallback(documentRef, alt, caption);
}

/**
 * @param {Document} documentRef
 * @param {string} src an already https-re-checked URL
 * @param {string} alt
 * @param {Inline[] | undefined} caption
 * @param {ReaderSettings} settings
 * @param {boolean} deferRemoteImages
 * @returns {HTMLElement}
 */
function renderFigureImage(documentRef, src, alt, caption, settings, deferRemoteImages) {
  const figure = documentRef.createElement('figure');
  figure.className = 'article-content-figure';
  const image = documentRef.createElement('img');
  image.className = 'article-content-figure-image';
  image.decoding = 'async';
  image.setAttribute('decoding', 'async');
  const loading = settings.lazyLoadImages ? 'lazy' : 'eager';
  image.loading = loading;
  image.setAttribute('loading', loading);
  image.referrerPolicy = 'no-referrer';
  image.setAttribute('referrerpolicy', 'no-referrer');
  image.alt = alt;
  image.addEventListener('error', () => {
    // Hide only the broken image. Alt and caption stay visible, and a figure
    // left with neither is removed so the preview can activate plain fallback.
    image.remove();
    appendFigureAltFallback(documentRef, figure, alt);
    if (figure.childNodes.length === 0) figure.remove();
  });
  if (deferRemoteImages) image.setAttribute('data-article-image-src', src);
  else image.src = src;
  figure.append(image);
  const figcaption = renderFigureCaption(documentRef, caption);
  if (figcaption) figure.append(figcaption);
  return figure;
}

/**
 * No image request is made — `imageLoading: 'never'`, or a `src` that failed
 * the defensive https re-check. The reader still sees what the image was via
 * alt text and/or caption, with zero network requests; a figure with neither
 * renders nothing.
 *
 * @param {Document} documentRef
 * @param {string} alt
 * @param {Inline[] | undefined} caption
 * @returns {HTMLElement | null}
 */
function renderFigureFallback(documentRef, alt, caption) {
  const figcaption = renderFigureCaption(documentRef, caption);
  if (!alt && !figcaption) return null;
  const figure = documentRef.createElement('figure');
  figure.className = 'article-content-figure';
  appendFigureAltFallback(documentRef, figure, alt);
  if (figcaption) figure.append(figcaption);
  return figure;
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} figure
 * @param {string} alt
 */
function appendFigureAltFallback(documentRef, figure, alt) {
  if (!alt || figure.querySelector('.article-content-figure-alt')) return;
  const altText = documentRef.createElement('p');
  altText.className = 'article-content-figure-alt';
  altText.textContent = alt;
  figure.prepend(altText);
}

/**
 * @param {Document} documentRef
 * @param {Inline[] | undefined} caption
 * @returns {HTMLElement | null}
 */
function renderFigureCaption(documentRef, caption) {
  if (!caption || caption.length === 0) return null;
  const figcaption = documentRef.createElement('figcaption');
  figcaption.className = 'article-content-figure-caption';
  appendInline(documentRef, figcaption, caption);
  return figcaption;
}

/**
 * @param {Document} documentRef
 * @param {ParentNode} parent
 * @param {Inline[]} inlineNodes
 */
function appendInline(documentRef, parent, inlineNodes) {
  for (const inline of inlineNodes) {
    const node = renderInline(documentRef, inline);
    if (node) parent.append(node);
  }
}

/**
 * @param {Document} documentRef
 * @param {Inline} inline
 * @returns {Node | null}
 */
function renderInline(documentRef, inline) {
  switch (inline.type) {
    case 'text':
      return documentRef.createTextNode(inline.text);
    case 'strong':
      return renderInlineWrapper(documentRef, 'strong', inline.children);
    case 'em':
      return renderInlineWrapper(documentRef, 'em', inline.children);
    case 'code': {
      const code = documentRef.createElement('code');
      code.textContent = inline.text;
      return code;
    }
    case 'break':
      return documentRef.createElement('br');
    case 'link':
      // SEC-004: the anchor's navigable href is the internal bridge page, never
      // the raw feed URL — that rides only in data-article-content-link. See the
      // file header and renderLink below.
      return renderLink(documentRef, inline.href, inline.children);
    default:
      return null;
  }
}

/**
 * @param {Document} documentRef
 * @param {'strong' | 'em'} tag
 * @param {Inline[]} children
 * @returns {HTMLElement}
 */
function renderInlineWrapper(documentRef, tag, children) {
  const element = documentRef.createElement(tag);
  appendInline(documentRef, element, children);
  return element;
}

/**
 * Renders an inline link as a navigable bridge anchor (SEC-004). `href` is
 * sanitizer-guaranteed https but is re-checked with `httpsOnlyUrl`; on success
 * the anchor's navigable `href` is the internal bridge page and the validated
 * feed URL is stored in `data-article-content-link`. A href that fails the
 * defensive re-check (should not occur post-sanitizer) renders a plain span so
 * no raw/unsafe URL becomes navigable and the link text is still shown.
 *
 * @param {Document} documentRef
 * @param {string} href
 * @param {Inline[]} children
 * @returns {HTMLElement}
 */
function renderLink(documentRef, href, children) {
  const safeHref = httpsOnlyUrl(href);
  if (!safeHref) return renderLinkFallback(documentRef, children);
  const anchor = documentRef.createElement('a');
  anchor.className = 'article-content-link';
  anchor.dataset.articleContentLink = safeHref;
  anchor.setAttribute('href', contentLinkBridgeHref(safeHref));
  appendInline(documentRef, anchor, children);
  return wrapArticleDestination(documentRef, anchor, safeHref);
}

/**
 * @param {Document} documentRef
 * @param {Inline[]} children
 * @returns {HTMLSpanElement}
 */
function renderLinkFallback(documentRef, children) {
  const span = documentRef.createElement('span');
  span.className = 'article-content-link';
  appendInline(documentRef, span, children);
  return span;
}

/**
 * The internal extension bridge URL for a validated https feed link. This — never
 * the raw feed URL — is what the anchor's `href` navigates to (SEC-004); the bridge
 * page decodes and re-validates the URL before opening it through `browser.tabs`.
 *
 * @param {string} href a validated https URL
 * @returns {string}
 */
function contentLinkBridgeHref(href) {
  return `/app/open-content-link.html#${encodeURIComponent(href)}`;
}
