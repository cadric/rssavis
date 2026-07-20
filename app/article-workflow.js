// @ts-check

import { toSafeError } from '../domain/errors.js';
import { normalizeArticleUrl } from '../domain/urls.js';
import {
  getArticleDetail,
  openArticleContentLink,
  openArticleOriginal,
  setArticleRead,
  setArticleStarred,
} from './api-client.js';
import {
  articleFlagIntentGeneration,
  articleReadIntentGeneration,
  noteArticleFlagIntent,
} from './article-read-intent.js';
import { mergeOpenOriginalReadResult } from './article-open-result.js';
import { isCurrentExpandedPreview, nextPreviewDetailGeneration } from './article-preview-request.js';
import { showToast } from './toasts.js';

/**
 * @typedef {import('./reader-state.js').ArticleState} ArticleState
 * @typedef {import('./article-preview.js').PreviewEntry} PreviewEntry
 *
 * @typedef {object} WorkflowInput
 * @property {import('./app-shell.js').AppShellOptions} options
 * @property {() => {expandedArticleId: string, mode: string} | null} getState
 * @property {() => ArticleState} getArticleState
 * @property {(next: ArticleState) => void} setArticleState
 * @property {(id: string, field: 'readState' | 'starredState', expectedValue: number, nextValue: number, article: Record<string, unknown>, options?: {authoritativeDataRevision?: number}) => void} [patchCachedArticleField]
 * @property {(patch: Record<string, unknown>) => Promise<unknown>} writeState
 */

/**
 * @param {WorkflowInput} input
 * @param {HTMLElement} target
 * @returns {Promise<boolean>}
 */
export async function handleArticleActionClick(input, target) {
  const copyButton = target.closest('[data-article-copy]');
  if (isHtmlElement(input.options.documentRef, copyButton)) {
    await copyArticleLink(input, copyButton.dataset.articleCopy ?? '');
    return true;
  }
  const openButton = target.closest('[data-article-open], [data-article-title-open]');
  if (isHtmlElement(input.options.documentRef, openButton)) {
    await openArticle(input, openButton.dataset.articleOpen ?? openButton.dataset.articleTitleOpen ?? '');
    return true;
  }
  const contentLink = target.closest('[data-article-content-link]');
  if (isHtmlElement(input.options.documentRef, contentLink)) {
    await openContentLink(input, contentLink.dataset.articleContentLink ?? '');
    return true;
  }
  const readButton = target.closest('[data-article-read]');
  if (isHtmlElement(input.options.documentRef, readButton)) {
    await toggleRead(input, readButton.dataset.articleRead ?? '');
    return true;
  }
  const starButton = target.closest('[data-article-star]');
  if (isHtmlElement(input.options.documentRef, starButton)) {
    await toggleStar(input, starButton);
    return true;
  }
  const expandButton = target.closest('[data-article-expand]');
  if (isHtmlElement(input.options.documentRef, expandButton)) {
    await toggleExpandedArticle(input, expandButton.dataset.articleExpand ?? '');
    return true;
  }
  return false;
}

/**
 * @param {WorkflowInput} input
 * @param {KeyboardEvent} event
 */
export function handleArticleEscape(input, event) {
  if (event.key !== 'Escape') return false;
  const expandedId = input.getState()?.expandedArticleId ?? '';
  if (!expandedId) return false;
  void closeExpandedArticle(input, expandedId).then(() => {
    const button = input.options.documentRef.querySelector(`[data-article-expand="${cssEscape(expandedId)}"]`);
    if (isHtmlElement(input.options.documentRef, button)) button.focus();
  });
  return true;
}

/**
 * @param {WorkflowInput} input
 * @param {string} [id]
 */
export async function closeExpandedArticle(input, id = input.getState()?.expandedArticleId ?? '') {
  if (!id) return;
  nextPreviewDetailGeneration(input, id);
  await input.writeState({ expandedArticleId: '' });
}

/**
 * @param {WorkflowInput} input
 * @param {HTMLElement} starButton
 */
async function toggleStar(input, starButton) {
  const id = starButton.dataset.articleStar ?? '';
  const nextState = starButton.getAttribute('aria-pressed') === 'true' ? 0 : 1;
  if (!id) return;
  await setArticleFlag(input, id, 'starredState', nextState, () =>
    setArticleStarred(id, nextState, input.options.browserApi),
  );
}

/**
 * @param {WorkflowInput} input
 * @param {string} id
 */
async function toggleRead(input, id) {
  const article = articleById(input.getArticleState(), id);
  if (!article) return;
  const currentReadState = numberValue(article.readState);
  await setArticleFlag(input, id, 'readState', currentReadState === 1 ? 0 : 1, () =>
    setArticleRead(id, currentReadState === 1 ? 0 : 1, input.options.browserApi),
  );
}

/**
 * @param {WorkflowInput} input
 * @param {string} id
 */
async function toggleExpandedArticle(input, id) {
  const current = input.getState();
  if (!current || !id) return;
  if (current.expandedArticleId === id) {
    await closeExpandedArticle(input, id);
    return;
  }
  const detailGeneration = nextPreviewDetailGeneration(input, id);
  await input.writeState({ expandedArticleId: id });
  if (shouldMarkRead(input, id, 'markReadOnExpand')) {
    await setArticleFlag(input, id, 'readState', 1, () => setArticleRead(id, 1, input.options.browserApi));
  }
  try {
    const detail = await getArticleDetail(id, input.options.browserApi);
    if (isCurrentExpandedPreview(input, id, detailGeneration)) setReadyArticleDetail(input, id, detail);
  } catch (error) {
    if (!isCurrentExpandedPreview(input, id, detailGeneration)) return;
    const safe = toSafeError(error);
    setPreview(input, id, {
      detail: null,
      message: input.options.browserApi.i18n.getMessage(safe.messageKey),
      status: 'error',
    });
  }
}

/**
 * @param {WorkflowInput} input
 * @param {string} id
 */
async function copyArticleLink(input, id) {
  try {
    const detail = await detailForArticle(input, id);
    const url = normalizeArticleUrl(typeof detail.canonicalUrl === 'string' ? detail.canonicalUrl : '');
    await input.options.windowRef.navigator.clipboard.writeText(url);
    showToast(input.options.documentRef, input.options.browserApi.i18n.getMessage('articleLinkCopied'));
  } catch (error) {
    reportWorkflowError(input, 'article-copy-link', error);
    showToast(input.options.documentRef, input.options.browserApi.i18n.getMessage('articleCopyFailed'));
  }
}

/**
 * @param {WorkflowInput} input
 * @param {string} id
 */
async function openArticle(input, id) {
  if (!id) return;
  try {
    const originArticle = articleById(input.getArticleState(), id);
    const readIntentGeneration = articleReadIntentGeneration(input, id);
    const result = await openArticleOriginal(
      id,
      input.getArticleState().settings.openLinksMode,
      input.options.browserApi,
    );
    mergeOpenOriginalReadResult(input, id, result, readIntentGeneration, originArticle);
    showToast(input.options.documentRef, input.options.browserApi.i18n.getMessage('articleOpenedOriginal'));
  } catch (error) {
    reportWorkflowError(input, 'article-open-original', error);
    showToast(input.options.documentRef, input.options.browserApi.i18n.getMessage('articleOpenFailed'));
  }
}

/**
 * Sends a sanitized inline content link through the validated
 * `articles.openContentLink` command (a separate SEC-004 path, no mark-read).
 * @param {WorkflowInput} input
 * @param {string} url
 */
async function openContentLink(input, url) {
  if (!url) return;
  try {
    await openArticleContentLink(url, input.getArticleState().settings.openLinksMode, input.options.browserApi);
  } catch (error) {
    reportWorkflowError(input, 'article-open-content-link', error);
    showToast(input.options.documentRef, input.options.browserApi.i18n.getMessage('articleOpenFailed'));
  }
}

/**
 * @param {WorkflowInput} input
 * @param {string} id
 * @returns {Promise<Record<string, unknown>>}
 */
async function detailForArticle(input, id) {
  const preview = input.getArticleState().previewByArticleId[id];
  if (preview?.status === 'ready' && preview.detail) return preview.detail;
  const detail = await getArticleDetail(id, input.options.browserApi);
  setReadyArticleDetail(input, id, detail);
  return detail;
}

/**
 * @param {WorkflowInput} input
 * @param {string} id
 * @param {'readState' | 'starredState'} field
 * @param {number} nextState
 * @param {() => Promise<unknown>} operation
 */
async function setArticleFlag(input, id, field, nextState, operation) {
  const previous = input.getArticleState();
  const previousArticle = articleById(previous, id);
  if (!previousArticle) return;
  const previousState = numberValue(previousArticle[field]);
  const intentGeneration = noteArticleFlagIntent(input, id, field);
  input.patchCachedArticleField?.(id, field, previousState, nextState, previousArticle);
  setArticleStateValue(input, id, field, nextState);
  try {
    await operation();
    if (articleFlagIntentGeneration(input, id, field) !== intentGeneration) return;
    const currentArticle = articleById(input.getArticleState(), id);
    if (!currentArticle) return;
    const currentState = numberValue(currentArticle[field]);
    if (currentState === nextState) return;
    input.patchCachedArticleField?.(id, field, currentState, nextState, currentArticle);
    setArticleStateValue(input, id, field, nextState);
  } catch (error) {
    if (articleFlagIntentGeneration(input, id, field) === intentGeneration) {
      input.patchCachedArticleField?.(id, field, nextState, previousState, previousArticle);
      rollbackArticleStateValue(input, id, field, nextState, previousState);
    }
    reportWorkflowError(input, `article-set-${field}`, error);
    showToast(input.options.documentRef, input.options.browserApi.i18n.getMessage('articleUpdateFailed'));
  }
}

/**
 * Rolls back only the still-current optimistic field. Concurrent snapshot,
 * availability, preview and unrelated flag state remains owned by its source.
 * @param {WorkflowInput} input
 * @param {string} id
 * @param {'readState' | 'starredState'} field
 * @param {number} optimisticState
 * @param {number} previousState
 */
function rollbackArticleStateValue(input, id, field, optimisticState, previousState) {
  const current = input.getArticleState();
  const article = articleById(current, id);
  if (!article || numberValue(article[field]) !== optimisticState) return;
  const preview = current.previewByArticleId[id];
  input.setArticleState({
    ...current,
    items: current.items.map((item) => (item.id === id ? { ...item, [field]: previousState } : item)),
    previewByArticleId:
      preview?.detail && numberValue(preview.detail[field]) === optimisticState
        ? {
            ...current.previewByArticleId,
            [id]: { ...preview, detail: { ...preview.detail, [field]: previousState } },
          }
        : current.previewByArticleId,
  });
}

/**
 * @param {WorkflowInput} input
 * @param {string} operation
 * @param {unknown} error
 */
function reportWorkflowError(input, operation, error) {
  const safe = toSafeError(error);
  console.error({
    atMs: Date.now(),
    code: safe.code,
    details: safe.details,
    level: 'error',
    operation,
  });
}

/**
 * @param {WorkflowInput} input
 * @param {string} id
 * @param {'markReadOnExpand' | 'markReadOnOpen'} setting
 */
function shouldMarkRead(input, id, setting) {
  return (
    input.getArticleState().settings[setting] && numberValue(articleById(input.getArticleState(), id)?.readState) === 0
  );
}

/**
 * @param {WorkflowInput} input
 * @param {string} id
 * @param {Record<string, unknown>} detail
 */
function setReadyArticleDetail(input, id, detail) {
  const current = input.getArticleState();
  const article = articleById(current, id);
  const synchronizedDetail = article
    ? { ...detail, readState: article.readState, starredState: article.starredState }
    : detail;
  input.setArticleState({
    ...current,
    previewByArticleId: { ...current.previewByArticleId, [id]: { detail: synchronizedDetail, status: 'ready' } },
  });
}

/**
 * @param {WorkflowInput} input
 * @param {string} id
 * @param {'readState' | 'starredState'} field
 * @param {number} value
 */
function setArticleStateValue(input, id, field, value) {
  const current = input.getArticleState();
  const nextPreview = current.previewByArticleId[id];
  input.setArticleState({
    ...current,
    items: current.items.map((article) => (article.id === id ? { ...article, [field]: value } : article)),
    previewByArticleId: nextPreview?.detail
      ? {
          ...current.previewByArticleId,
          [id]: { ...nextPreview, detail: { ...nextPreview.detail, [field]: value } },
        }
      : current.previewByArticleId,
  });
}

/**
 * @param {WorkflowInput} input
 * @param {string} id
 * @param {PreviewEntry} entry
 */
function setPreview(input, id, entry) {
  const current = input.getArticleState();
  input.setArticleState({
    ...current,
    previewByArticleId: { ...current.previewByArticleId, [id]: entry },
  });
}

/**
 * @param {ArticleState} state
 * @param {string} id
 */
function articleById(state, id) {
  return state.items.find((article) => article.id === id) ?? null;
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
 * @param {unknown} value
 */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {string} value
 */
function cssEscape(value) {
  const css = globalThis.CSS;
  if (css && typeof css.escape === 'function') return css.escape(value);
  return value.replaceAll('"', '\\"');
}

/**
 * @param {Document} documentRef
 */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}
