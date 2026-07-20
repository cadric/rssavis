// @ts-check

import { feedTitleOr } from '../domain/feed-title.js';
import { tryNormalizeHttpUrl } from '../domain/urls.js';
import { configureArticlePreviewContent } from './article-preview-content.js';
import { configurePreviewImages, previewImagePolicyKey } from './article-preview-images.js';
import { wrapArticleDestination } from './article-destination.js';
import { formatArticleDateTime } from './date-groups.js';
import { cloneTemplate, queryRequired } from './templates.js';

/**
 * @typedef {import('./reader-settings.js').ReaderSettings} ReaderSettings
 *
 * @typedef {object} PreviewEntry
 * @property {Record<string, unknown> | null} [detail]
 * @property {string} [message]
 * @property {'error' | 'loading' | 'ready'} status
 *
 * @typedef {object} ArticlePreviewOptions
 * @property {Map<string, string>} [feedTitleById]
 * @property {(key: string) => string} getMessage
 * @property {string} [labelledById]
 * @property {string} locale
 * @property {PreviewEntry | undefined} preview
 * @property {ReaderSettings} settings
 * @property {string} timeZone
 */

/**
 * @param {Document} documentRef
 * @param {Record<string, unknown>} article
 * @param {ArticlePreviewOptions} options
 * @returns {HTMLElement}
 */
export function createArticlePreview(documentRef, article, options) {
  const id = requireString(article.id, 'article.id');
  const preview = clonePreviewTemplate(documentRef);
  const titleId = options.labelledById || `article-preview-title-${id}`;
  preview.id = `article-preview-${id}`;
  preview.dataset.articlePreview = id;
  preview.setAttribute('aria-labelledby', titleId);

  const entry = options.preview ?? { status: 'loading' };
  if (entry.status === 'ready' && entry.detail) {
    renderReadyPreview(documentRef, preview, article, entry.detail, titleId, options);
  } else {
    renderStatusPreview(
      documentRef,
      preview,
      options.labelledById ? '' : titleId,
      entry.status === 'error'
        ? entry.message || options.getMessage('articleDetailFailed')
        : options.getMessage('articleDetailLoading'),
    );
  }
  return preview;
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} preview
 * @param {Record<string, unknown>} article
 * @param {Record<string, unknown>} detail
 * @param {string} titleId
 * @param {ArticlePreviewOptions} options
 */
function renderReadyPreview(documentRef, preview, article, detail, titleId, options) {
  const merged = { ...article, ...detail };
  const id = requireString(merged.id, 'article.id');
  const content = cloneTemplate(documentRef, 'data-article-preview-ready-template', '[data-article-preview-content]');
  const heading = queryRequired(content, '[data-article-preview-heading]');
  if (!options.labelledById) heading.id = titleId;
  configureTitle(documentRef, content, merged, id, options);
  configureMetadata(documentRef, content, merged, options);
  configureArticlePreviewContent(documentRef, content, merged, options.settings);
  configureActionGroup(documentRef, content, merged, options);
  configurePreviewImages(documentRef, content, merged, options);
  preview.dataset.imagePolicy = previewImagePolicyKey(options.settings);
  preview.append(content);
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} preview
 * @param {string} titleId
 * @param {string} message
 */
function renderStatusPreview(documentRef, preview, titleId, message) {
  const content = cloneTemplate(documentRef, 'data-article-preview-status-template', '[data-article-preview-content]');
  const heading = queryRequired(content, '[data-article-preview-heading]');
  if (titleId) {
    heading.id = titleId;
    heading.textContent = message;
  } else {
    heading.remove();
  }
  const paragraph = queryRequired(content, '[data-article-preview-status]');
  paragraph.textContent = message;
  preview.append(content);
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} content
 * @param {Record<string, unknown>} article
 * @param {ArticlePreviewOptions} options
 */
function configureMetadata(documentRef, content, article, options) {
  setOptionalText(
    content,
    '[data-article-preview-meta-feed]',
    feedTitleOr(options.feedTitleById, article.feedId, article.feedTitle),
  );
  setOptionalText(content, '[data-article-preview-meta-author]', stringValue(article.author));
  const time = queryRequired(content, '[data-article-preview-meta-time]');
  if (!isTimeElement(documentRef, time)) throw new Error('Article preview time template is invalid.');
  const publishedAtMs = numberValue(article.publishedAtMs);
  if (publishedAtMs > 0) {
    time.hidden = false;
    time.setAttribute('datetime', new Date(publishedAtMs).toISOString());
    time.textContent = formatArticleDateTime(publishedAtMs, options.locale, options.timeZone);
  } else {
    time.hidden = true;
    time.removeAttribute('datetime');
    time.textContent = '';
  }
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} content
 * @param {Record<string, unknown>} article
 * @param {ArticlePreviewOptions} options
 */
function configureActionGroup(documentRef, content, article, options) {
  const id = requireString(article.id, 'article.id');
  const group = queryRequired(content, '[data-article-preview-actions]');
  group.setAttribute('aria-label', options.getMessage('articleActionsLabel'));
  const canonicalUrl = tryNormalizeHttpUrl(article.canonicalUrl);
  if (canonicalUrl) configureOpenOriginalLink(documentRef, content, id, canonicalUrl, options);
  else queryRequired(content, '[data-article-preview-actions] [data-article-open]').remove();
  configureButton(
    content,
    numberValue(article.readState) === 1 ? 'articleMarkUnread' : 'articleMarkRead',
    'data-article-read',
    id,
    false,
    options,
  );
  configureButton(
    content,
    numberValue(article.starredState) === 1 ? 'articleUnstar' : 'articleStar',
    'data-article-star',
    id,
    numberValue(article.starredState) === 1,
    options,
  );
  if (canonicalUrl) configureButton(content, 'articleCopyLink', 'data-article-copy', id, false, options);
  else queryRequired(content, '[data-article-preview-actions] [data-article-copy]').remove();
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} content
 * @param {string} id
 * @param {string} canonicalUrl
 * @param {ArticlePreviewOptions} options
 */
function configureOpenOriginalLink(documentRef, content, id, canonicalUrl, options) {
  const link = queryRequired(content, '[data-article-preview-actions] a[data-article-open]');
  if (!isAnchorElement(documentRef, link)) throw new Error('Article preview open link template is invalid.');
  link.dataset.articleOpen = id;
  link.setAttribute('href', openOriginalBridgeHref(id));
  link.textContent = options.getMessage('articleOpenOriginal');
  wrapArticleDestination(documentRef, link, canonicalUrl);
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} content
 * @param {Record<string, unknown>} article
 * @param {string} id
 * @param {ArticlePreviewOptions} options
 */
function configureTitle(documentRef, content, article, id, options) {
  const title = stringValue(article.title) || options.getMessage('untitledArticle');
  const href = tryNormalizeHttpUrl(article.canonicalUrl);
  const link = queryRequired(content, '[data-article-preview-title-link]');
  const text = queryRequired(content, '[data-article-preview-title-text]');
  queryRequired(content, '[data-article-preview-heading-placeholder]').remove();
  if (!href) {
    text.hidden = false;
    text.textContent = title;
    link.remove();
    return;
  }
  if (!isAnchorElement(documentRef, link)) throw new Error('Article preview title link template is invalid.');
  link.hidden = false;
  link.dataset.articleOpen = id;
  link.setAttribute('href', openOriginalBridgeHref(id));
  link.textContent = title;
  wrapArticleDestination(documentRef, link, href);
  text.remove();
}

/**
 * @param {string} articleId
 */
function openOriginalBridgeHref(articleId) {
  return `/app/open-original.html#${encodeURIComponent(articleId)}`;
}

/**
 * @param {HTMLElement} content
 * @param {string} key
 * @param {string} datasetName
 * @param {string} id
 * @param {boolean} pressed
 * @param {ArticlePreviewOptions} options
 */
function configureButton(content, key, datasetName, id, pressed, options) {
  const button = queryRequired(content, `button[${datasetName}]`);
  button.setAttribute(datasetName, id);
  if (datasetName === 'data-article-star') button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  button.textContent = options.getMessage(key);
}

/**
 * @param {ParentNode} root
 * @param {string} selector
 * @param {string} text
 */
function setOptionalText(root, selector, text) {
  if (!text) return;
  const element = queryRequired(root, selector);
  element.hidden = false;
  element.textContent = text;
}

/**
 * @param {Document} documentRef
 */
function clonePreviewTemplate(documentRef) {
  return cloneTemplate(documentRef, 'data-article-preview-template', '.article-preview');
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
 * @param {unknown} value
 * @param {string} label
 */
function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

/**
 * @param {Document} documentRef
 * @param {unknown} value
 * @returns {value is HTMLAnchorElement}
 */
function isAnchorElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLAnchorElement;
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
 */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}
