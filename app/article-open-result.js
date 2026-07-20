// @ts-check

import { articleReadIntentGeneration } from './article-read-intent.js';

/**
 * Merges the background-owned open-original read mutation without replacing
 * unrelated Reader or preview state.
 * @param {{getArticleState: () => import('./reader-state.js').ArticleState, patchCachedArticleField?: (id: string, field: 'readState' | 'starredState', expectedValue: number, nextValue: number, article: Record<string, unknown>, options?: {authoritativeDataRevision?: number}) => void, setArticleState: (next: import('./reader-state.js').ArticleState) => void}} input
 * @param {string} id
 * @param {unknown} result
 * @param {number} expectedReadIntentGeneration
 * @param {Record<string, unknown> | null} [originArticle]
 */
export function mergeOpenOriginalReadResult(input, id, result, expectedReadIntentGeneration, originArticle = null) {
  if (!isRecord(result) || !isRecord(result.read) || !isRecord(result.read.article)) return;
  const readState = result.read.article.readState;
  const current = input.getArticleState();
  const dataRevision = numberValue(result.dataRevision);
  const readIntentIsCurrent = articleReadIntentGeneration(input, id) === expectedReadIntentGeneration;
  const nextReadState = typeof readState === 'number' ? readState : null;
  const articlePatch = readIntentIsCurrent && nextReadState !== null ? { readState: nextReadState } : null;
  const previousArticle = current.items.find((article) => article.id === id) ?? originArticle;
  if (articlePatch && previousArticle && nextReadState !== null) {
    input.patchCachedArticleField?.(
      id,
      'readState',
      numberValue(previousArticle.readState),
      nextReadState,
      previousArticle,
      { authoritativeDataRevision: dataRevision },
    );
  }
  input.setArticleState({
    ...current,
    dataRevision: dataRevision > current.dataRevision ? dataRevision : current.dataRevision,
    items: articlePatch
      ? current.items.map((article) => (article.id === id ? { ...article, ...articlePatch } : article))
      : current.items,
    previewByArticleId: articlePatch
      ? mergePreviewArticle(current.previewByArticleId, id, articlePatch)
      : current.previewByArticleId,
  });
}

/**
 * @param {Record<string, import('./article-preview.js').PreviewEntry>} previewByArticleId
 * @param {string} id
 * @param {Record<string, unknown>} patch
 */
function mergePreviewArticle(previewByArticleId, id, patch) {
  const nextPreview = previewByArticleId[id];
  return nextPreview?.detail
    ? { ...previewByArticleId, [id]: { ...nextPreview, detail: { ...nextPreview.detail, ...patch } } }
    : previewByArticleId;
}

/** @param {unknown} value */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}
