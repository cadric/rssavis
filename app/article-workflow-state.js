// @ts-check

/**
 * Article-state patch helpers shared by the article workflow. Each helper
 * replaces only the targeted article/preview entry and leaves concurrent
 * snapshot, availability and unrelated preview state untouched.
 *
 * @typedef {import('./reader-state.js').ArticleState} ArticleState
 * @typedef {import('./article-preview.js').PreviewEntry} PreviewEntry
 * @typedef {{getArticleState(): ArticleState, setArticleState(next: ArticleState): void}} WorkflowInput
 */

/**
 * Rolls back only the still-current optimistic field. Concurrent snapshot,
 * availability, preview and unrelated flag state remains owned by its source.
 * @param {WorkflowInput} input
 * @param {string} id
 * @param {'readState' | 'starredState'} field
 * @param {number} optimisticState
 * @param {number} previousState
 */
export function rollbackArticleStateValue(input, id, field, optimisticState, previousState) {
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
 * @param {string} id
 * @param {Record<string, unknown>} detail
 */
export function setReadyArticleDetail(input, id, detail) {
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
export function setArticleStateValue(input, id, field, value) {
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
export function setPreview(input, id, entry) {
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
 * @param {unknown} value
 */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
