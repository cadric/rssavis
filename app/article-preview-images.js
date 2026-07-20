// @ts-check

import { tryNormalizeHttpUrl } from '../domain/urls.js';
import { configureArticlePreviewContent } from './article-preview-content.js';
import { cloneTemplate, queryRequired } from './templates.js';

/**
 * @typedef {object} PreviewImageOptions
 * @property {(key: string) => string} getMessage
 * @property {import('./article-preview.js').PreviewEntry | undefined} preview
 * @property {import('./reader-settings.js').ReaderSettings} settings
 */

/**
 * @param {Document} documentRef
 * @param {HTMLElement} content
 * @param {Record<string, unknown>} article
 * @param {PreviewImageOptions} options
 */
export function configurePreviewImages(documentRef, content, article, options) {
  const note = queryRequired(content, '[data-article-preview-image-note]');
  const figure = queryRequired(content, '[data-article-preview-image]');
  if (options.settings.imageLoading === 'never') {
    figure.remove();
    note.textContent = options.getMessage('articleImageNever');
    return;
  }
  note.remove();
  const rich = queryRequired(content, '[data-article-preview-rich]');
  if (!rich.hidden && rich.querySelector('.article-content-figure-image')) {
    figure.remove();
    return;
  }
  const imageUrl = tryNormalizeHttpUrl(article.imageUrl);
  if (imageUrl) configureImageFigure(documentRef, figure, imageUrl, options.settings);
  else figure.remove();
}

/**
 * Applies a changed image policy to the connected preview without constructing
 * a request-capable comparison tree or replacing its shell/action controls.
 * @param {Document} documentRef
 * @param {HTMLElement} preview
 * @param {Record<string, unknown>} article
 * @param {PreviewImageOptions} options
 */
export function syncConnectedPreviewImages(documentRef, preview, article, options) {
  if (options.preview?.status !== 'ready' || !options.preview.detail) return;
  const desired = previewImagePolicyKey(options.settings);
  const current = preview.dataset.imagePolicy ?? inferImagePolicy(preview);
  if (current === desired) return;
  if (current.startsWith('load:') && desired.startsWith('load:')) {
    updateLoadingMode(preview, options.settings.lazyLoadImages);
    preview.dataset.imagePolicy = desired;
    return;
  }
  const content = preview.querySelector('[data-article-preview-content]');
  const columns = content?.querySelector('.article-preview-columns');
  if (!isHtmlElement(documentRef, content) || !columns) return;
  const template = cloneTemplate(documentRef, 'data-article-preview-ready-template', '[data-article-preview-content]');
  const freshColumns = queryRequired(template, '.article-preview-columns');
  for (const image of freshColumns.querySelectorAll('img')) image.removeAttribute('src');
  columns.replaceChildren(...freshColumns.childNodes);
  const merged = { ...article, ...options.preview.detail };
  configureArticlePreviewContent(documentRef, content, merged, options.settings, { deferRemoteImages: true });
  configurePreviewImages(documentRef, content, merged, options);
  preview.dataset.imagePolicy = desired;
}

/** @param {import('./reader-settings.js').ReaderSettings} settings */
export function previewImagePolicyKey(settings) {
  return settings.imageLoading === 'never' ? 'never' : `load:${settings.lazyLoadImages ? 'lazy' : 'eager'}`;
}

/** @param {HTMLElement} preview */
function inferImagePolicy(preview) {
  if (preview.querySelector('[data-article-preview-image-note]')) return 'never';
  const image = preview.querySelector('img');
  return `load:${image?.getAttribute('loading') === 'eager' ? 'eager' : 'lazy'}`;
}

/** @param {HTMLElement} preview @param {boolean} lazy */
function updateLoadingMode(preview, lazy) {
  const loading = lazy ? 'lazy' : 'eager';
  for (const image of preview.querySelectorAll('img')) {
    image.loading = loading;
    image.setAttribute('loading', loading);
  }
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} figure
 * @param {string} imageUrl
 * @param {import('./reader-settings.js').ReaderSettings} settings
 */
function configureImageFigure(documentRef, figure, imageUrl, settings) {
  const image = figure.querySelector('img');
  if (!isImageElement(documentRef, image)) throw new Error('Article preview image template is invalid.');
  figure.hidden = false;
  image.decoding = 'async';
  image.loading = settings.lazyLoadImages ? 'lazy' : 'eager';
  image.referrerPolicy = 'no-referrer';
  image.setAttribute('decoding', 'async');
  image.setAttribute('loading', settings.lazyLoadImages ? 'lazy' : 'eager');
  image.setAttribute('referrerpolicy', 'no-referrer');
  image.src = imageUrl;
  image.addEventListener('error', () => {
    figure.hidden = true;
  });
}

/** @param {Document} documentRef @param {unknown} value */
function isImageElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLImageElement;
}

/** @param {Document} documentRef @param {unknown} value */
function isHtmlElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLElement;
}

/** @param {Document} documentRef */
function requireView(documentRef) {
  const view = documentRef.defaultView;
  if (!view) throw new Error('Document defaultView is required.');
  return view;
}
