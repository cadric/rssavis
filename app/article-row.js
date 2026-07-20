// @ts-check

import { formatArticleTime, timestampForArticle } from './date-groups.js';
import { createArticlePreview } from './article-preview.js';
import { syncConnectedPreviewImages } from './article-preview-images.js';
import { feedTitleOr } from '../domain/feed-title.js';
import { tryNormalizeHttpUrl } from '../domain/urls.js';
import { applyFeedIcon } from './feed-icons.js';
import { cloneTemplate } from './templates.js';

/** @type {WeakMap<HTMLImageElement, string>} */
const appliedRowImageSignatures = new WeakMap();

/**
 * @typedef {object} ArticleRowOptions
 * @property {string} activeFeedId
 * @property {'compact' | 'normal' | 'large'} articleView
 * @property {string} expandedArticleId
 * @property {Map<string, string>} feedTitleById
 * @property {string} locale
 * @property {string} timeZone
 * @property {(key: string) => string} getMessage
 * @property {import('./article-preview.js').PreviewEntry | undefined} preview
 * @property {import('./reader-settings.js').ReaderSettings} settings
 */

/**
 * @param {Document} documentRef
 * @param {Record<string, unknown>} article
 * @param {ArticleRowOptions} options
 * @param {boolean} [suppressRowImages]
 * @param {boolean} [suppressPreviewImages]
 * @returns {HTMLElement}
 */
export function createArticleRow(
  documentRef,
  article,
  options,
  suppressRowImages = false,
  suppressPreviewImages = false,
) {
  const row = cloneTemplate(documentRef, 'data-article-row-template', '.article-row');
  const id = requireString(article.id, 'article.id');
  const expanded = options.expandedArticleId === id;
  const timestamp = timestampForArticle(article);
  const previewId = `article-preview-${id}`;
  row.dataset.articleId = id;
  row.dataset.articleView = options.articleView;
  row.dataset.readState = String(numberValue(article.readState));
  row.classList.toggle('is-unread', numberValue(article.readState) === 0);
  row.classList.toggle('is-expanded', expanded);
  const titleId = `article-row-title-${id}`;

  const rowImageOptions = suppressRowImages ? comparisonOptions(options) : options;
  applyRowFeedIcon(documentRef, row, article, rowImageOptions);
  const time = row.querySelector('time');
  if (isTimeElement(documentRef, time)) {
    time.dateTime = new Date(timestamp).toISOString();
    time.textContent = formatArticleTime(timestamp, options.locale, options.timeZone);
  }

  const main = row.querySelector('.article-row-main');
  if (isButtonElement(documentRef, main)) {
    main.dataset.articleExpand = id;
    main.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    main.setAttribute('aria-controls', previewId);
  }
  const title = row.querySelector('.article-row-title');
  if (isHtmlElement(documentRef, title)) {
    title.id = titleId;
    title.textContent = stringValue(article.title) || options.getMessage('untitledArticle');
  }
  const meta = row.querySelector('.article-row-meta');
  if (isHtmlElement(documentRef, meta)) {
    const metadata = rowMetadata(article, options.activeFeedId, options.feedTitleById);
    meta.hidden = metadata.length === 0;
    meta.textContent = metadata;
  }
  setText(
    row,
    '[data-read-state-label]',
    options.getMessage(numberValue(article.readState) === 1 ? 'articleReadStateRead' : 'articleReadStateUnread'),
  );
  applyRowImage(documentRef, row, article, rowImageOptions);

  const summary = row.querySelector('.article-row-summary');
  if (isHtmlElement(documentRef, summary)) {
    summary.hidden = expanded || options.articleView === 'compact';
    summary.textContent = expanded ? '' : stringValue(article.summaryText);
  }

  const star = row.querySelector('.article-row-star');
  if (isButtonElement(documentRef, star)) {
    const starred = numberValue(article.starredState) === 1;
    const label = options.getMessage(starred ? 'articleUnstar' : 'articleStar');
    star.dataset.articleStar = id;
    star.setAttribute('aria-pressed', starred ? 'true' : 'false');
    star.hidden = expanded;
    star.title = label;
    setText(star, '[data-star-label]', label);
  }

  if (expanded) {
    row.append(
      createArticlePreview(documentRef, article, {
        feedTitleById: options.feedTitleById,
        getMessage: options.getMessage,
        labelledById: titleId,
        locale: options.locale,
        preview: options.preview,
        settings: suppressPreviewImages ? comparisonOptions(options).settings : options.settings,
        timeZone: options.timeZone,
      }),
    );
  }

  return row;
}

/**
 * Updates the small set of row fields that may change without membership
 * changing, while preserving the row, expander and preview identities.
 * @param {Document} documentRef
 * @param {HTMLElement} row
 * @param {Record<string, unknown>} article
 * @param {ArticleRowOptions} options
 */
export function patchArticleRow(documentRef, row, article, options) {
  applyRowFeedIcon(documentRef, row, article, options);
  // Disconnected comparison rows always use the strict image policy.
  const suppressPreviewImages = options.preview?.status === 'ready';
  const fresh = createArticleRow(documentRef, article, options, true, suppressPreviewImages);
  syncAttributes(row, fresh);
  syncElement(row, fresh, '.article-row-main');
  for (const selector of [
    'time',
    '.article-row-title',
    '.article-row-meta',
    '[data-read-state-label]',
    '.article-row-summary',
    '.article-row-star',
  ]) {
    syncElement(row, fresh, selector, selector !== '.article-row-star');
  }
  syncElement(row, fresh, '[data-star-label]', true);
  syncPreview(row, fresh, !suppressPreviewImages);
  const currentPreview = row.querySelector('[data-article-preview]');
  if (suppressPreviewImages && isHtmlElement(documentRef, currentPreview)) {
    syncConnectedPreviewImages(documentRef, currentPreview, article, options);
  }
  applyRowImage(documentRef, row, article, options);
}

/** @param {ArticleRowOptions} options @returns {ArticleRowOptions} */
function comparisonOptions(options) {
  return {
    ...options,
    settings: { ...options.settings, imageLoading: 'never' },
  };
}

/** @param {Document} documentRef @param {HTMLElement} row @param {Record<string, unknown>} article @param {ArticleRowOptions} options */
function applyRowFeedIcon(documentRef, row, article, options) {
  applyFeedIcon(
    documentRef,
    row,
    {
      feedUrl: article.feedUrl,
      iconColor: article.feedIconColor,
      iconSource: article.feedIconSource,
      iconUrl: article.feedIconUrl,
      id: article.feedId,
      siteUrl: article.feedSiteUrl,
      title: feedTitleOr(options.feedTitleById, article.feedId, article.feedTitle),
    },
    options.settings,
  );
}

/** @param {HTMLElement} current @param {HTMLElement} fresh @param {boolean} syncImagePolicy */
function syncPreview(current, fresh, syncImagePolicy) {
  const currentPreview = current.querySelector('[data-article-preview]');
  const freshPreview = fresh.querySelector('[data-article-preview]');
  if (isElement(currentPreview) && isElement(freshPreview)) {
    const imagePolicy = currentPreview.getAttribute('data-image-policy');
    syncAttributes(currentPreview, freshPreview);
    if (!syncImagePolicy && imagePolicy) currentPreview.setAttribute('data-image-policy', imagePolicy);
    for (const selector of [
      '[data-article-preview-meta-feed]',
      '[data-article-preview-meta-author]',
      '[data-article-preview-meta-time]',
    ]) {
      syncElement(currentPreview, freshPreview, selector, true);
    }
    if (syncImagePolicy) syncPreviewImagePolicy(currentPreview, freshPreview);
    const currentActions = currentPreview.querySelector('[data-article-preview-actions]');
    const freshActions = freshPreview.querySelector('[data-article-preview-actions]');
    if (isElement(currentActions) && isElement(freshActions)) {
      for (const selector of ['[data-article-read]', '[data-article-star]']) {
        syncElement(currentActions, freshActions, selector, true);
      }
      return;
    }
    const currentStatus = currentPreview.querySelector('[data-article-preview-status]');
    const freshStatus = freshPreview.querySelector('[data-article-preview-status]');
    if (isElement(currentStatus) && isElement(freshStatus)) {
      currentStatus.textContent = freshStatus.textContent;
      return;
    }
    currentPreview.replaceChildren(...freshPreview.childNodes);
    return;
  }
  if (isElement(currentPreview)) currentPreview.remove();
  if (isElement(freshPreview)) current.append(freshPreview);
}

/**
 * Applies settings-sensitive image presentation without replacing the preview,
 * its content root, or its action controls.
 * @param {Element} currentPreview
 * @param {Element} freshPreview
 */
function syncPreviewImagePolicy(currentPreview, freshPreview) {
  const currentColumns = currentPreview.querySelector('.article-preview-columns');
  const freshColumns = freshPreview.querySelector('.article-preview-columns');
  if (!isElement(currentColumns) || !isElement(freshColumns)) return;
  if (previewImagePolicySignature(currentColumns) === previewImagePolicySignature(freshColumns)) return;
  currentColumns.replaceChildren(...freshColumns.childNodes);
}

/** @param {Element} columns */
function previewImagePolicySignature(columns) {
  const images = [...columns.querySelectorAll('img')].map((image) => [
    image.className,
    image.getAttribute('src') ?? '',
    image.getAttribute('loading') ?? '',
    image.getAttribute('referrerpolicy') ?? '',
  ]);
  const note = columns.querySelector('[data-article-preview-image-note]');
  return JSON.stringify({ images, note: note?.textContent ?? null });
}

/**
 * @param {ParentNode} currentRoot
 * @param {ParentNode} freshRoot
 * @param {string} selector
 * @param {boolean} [copyContent]
 */
function syncElement(currentRoot, freshRoot, selector, copyContent = false) {
  const current = currentRoot.querySelector(selector);
  const fresh = freshRoot.querySelector(selector);
  if (!isElement(current) || !isElement(fresh)) return;
  syncAttributes(current, fresh);
  if (copyContent && current.textContent !== fresh.textContent) current.textContent = fresh.textContent;
}

/** @param {Element} current @param {Element} fresh */
function syncAttributes(current, fresh) {
  for (const attribute of [...current.attributes]) {
    if (!fresh.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of [...fresh.attributes]) {
    if (current.getAttribute(attribute.name) !== attribute.value) {
      current.setAttribute(attribute.name, attribute.value);
    }
  }
}

/** @param {unknown} value @returns {value is Element} */
function isElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} row
 * @param {Record<string, unknown>} article
 * @param {ArticleRowOptions} options
 */
function applyRowImage(documentRef, row, article, options) {
  const figure = row.querySelector('.article-row-image');
  const image = figure?.querySelector('img');
  if (!isHtmlElement(documentRef, figure) || !(image instanceof requireView(documentRef).HTMLImageElement)) return;
  const imageUrl = tryNormalizeHttpUrl(article.imageUrl);
  const canLoad =
    options.expandedArticleId !== requireString(article.id, 'article.id') &&
    options.settings.imageLoading === 'always' &&
    options.articleView !== 'compact' &&
    imageUrl;
  if (!canLoad) {
    if (!figure.hidden) figure.hidden = true;
    image.onerror = null;
    image.removeAttribute('src');
    row.removeAttribute('data-has-thumbnail');
    appliedRowImageSignatures.set(image, 'hidden');
    return;
  }
  const signature = `${options.settings.lazyLoadImages ? 'lazy' : 'eager'}:${imageUrl}`;
  if (appliedRowImageSignatures.get(image) === signature) return;
  appliedRowImageSignatures.set(image, signature);
  if (figure.hidden) figure.hidden = false;
  figure.dataset.articleImage = requireString(article.id, 'article.id');
  image.decoding = 'async';
  image.loading = options.settings.lazyLoadImages ? 'lazy' : 'eager';
  image.referrerPolicy = 'no-referrer';
  image.setAttribute('decoding', 'async');
  image.setAttribute('loading', options.settings.lazyLoadImages ? 'lazy' : 'eager');
  image.setAttribute('referrerpolicy', 'no-referrer');
  image.setAttribute('src', imageUrl);
  image.onerror = () => {
    figure.hidden = true;
  };
  row.dataset.hasThumbnail = 'true';
}

/**
 * @param {ParentNode} root
 * @param {string} selector
 * @param {string} text
 */
function setText(root, selector, text) {
  const element = root.querySelector(selector);
  if (element) element.textContent = text;
}

/**
 * @param {unknown} value
 */
function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {unknown} value
 */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The row line stays title-first: only the feed name qualifies as scanning
 * context in aggregated scopes; authors belong to the expanded preview meta.
 * @param {Record<string, unknown>} article
 * @param {string} activeFeedId
 * @param {Map<string, string>} feedTitleById
 */
function rowMetadata(article, activeFeedId, feedTitleById) {
  return stringValue(article.feedId) === activeFeedId
    ? ''
    : feedTitleOr(feedTitleById, article.feedId, article.feedTitle);
}

/**
 * @param {Document} documentRef
 * @param {unknown} value
 * @returns {value is HTMLTimeElement}
 */
function isTimeElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLTimeElement;
}

/**
 * @param {Document} documentRef
 * @param {unknown} value
 * @returns {value is HTMLButtonElement}
 */
function isButtonElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLButtonElement;
}

/**
 * @param {Document} documentRef
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLElement;
}

/**
 * @param {Document} documentRef
 */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}
