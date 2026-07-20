// @ts-check

import { setArticleRead } from './api-client.js';
import { articleReadIntentGeneration } from './article-read-intent.js';
import { toSafeError } from '../domain/errors.js';

const MAX_FLUSH = 25;

/**
 * @typedef {object} ScrollMarkerInput
 * @property {import('./app-shell.js').AppShellOptions} options
 * @property {() => import('./article-workflow.js').ArticleState} getArticleState
 * @property {(id: string, field: 'readState' | 'starredState', expectedValue: number, nextValue: number, article: Record<string, unknown>, options?: {authoritativeDataRevision?: number}) => void} [patchCachedArticleField]
 * @property {(next: import('./article-workflow.js').ArticleState) => void} setArticleState
 * @typedef {object} ScrollMarkerRuntime
 * @property {Set<string>} completed
 * @property {boolean} flushing
 * @property {IntersectionObserver | null} observer
 * @property {Set<Element>} observed
 * @property {Set<string>} queued
 * @property {Element | null} root
 * @property {WeakSet<Element>} seen
 */

export function createScrollReadMarker() {
  /** @type {ScrollMarkerRuntime} */
  const runtime = {
    completed: new Set(),
    flushing: false,
    observer: null,
    observed: new Set(),
    queued: new Set(),
    root: null,
    seen: new WeakSet(),
  };

  return {
    disconnect: () => disconnect(runtime),
    /**
     * @param {ScrollMarkerInput} input
     */
    reconcile: (input) => reconcile(runtime, input),
  };
}

/** @param {ScrollMarkerRuntime} runtime */
function disconnect(runtime) {
  runtime.observer?.disconnect();
  runtime.observer = null;
  runtime.observed.clear();
  runtime.queued.clear();
  runtime.root = null;
  runtime.seen = new WeakSet();
}

/**
 * @param {ScrollMarkerRuntime} runtime
 * @param {ScrollMarkerInput} input
 */
function reconcile(runtime, input) {
  const state = input.getArticleState();
  const root = input.options.documentRef.querySelector('[data-reader-main]');
  if (!state.settings.markReadOnScroll || state.status !== 'ready' || !root) {
    disconnect(runtime);
    return;
  }
  if (runtime.flushing) return;
  const Observer =
    /** @type {(new (callback: IntersectionObserverCallback, options?: IntersectionObserverInit) => IntersectionObserver) | undefined} */ (
      /** @type {Window & {IntersectionObserver?: unknown}} */ (input.options.windowRef).IntersectionObserver
    );
  if (typeof Observer !== 'function') {
    disconnect(runtime);
    return;
  }
  if (runtime.root && runtime.root !== root) disconnect(runtime);
  runtime.root = root;
  runtime.observer ??= createObserver(runtime, input, root, Observer);
  reconcileObservedRows(runtime, input.options.documentRef);
}

/**
 * @param {ScrollMarkerRuntime} runtime
 * @param {ScrollMarkerInput} input
 * @param {Element} root
 * @param {new (callback: IntersectionObserverCallback, options?: IntersectionObserverInit) => IntersectionObserver} Observer
 */
function createObserver(runtime, input, root, Observer) {
  /** @type {IntersectionObserver} */
  let activeObserver;
  activeObserver = new Observer((entries) => handleEntries(runtime, input, root, activeObserver, entries), {
    root,
    threshold: 0,
  });
  return activeObserver;
}

/**
 * @param {ScrollMarkerRuntime} runtime
 * @param {ScrollMarkerInput} input
 * @param {Element} root
 * @param {IntersectionObserver} activeObserver
 * @param {IntersectionObserverEntry[]} entries
 */
function handleEntries(runtime, input, root, activeObserver, entries) {
  if (root.hasAttribute('hidden')) return;
  const suppressQueue = runtime.flushing;
  for (const entry of entries) {
    if (!root.contains(entry.target)) continue;
    if (!runtime.seen.has(entry.target)) {
      runtime.seen.add(entry.target);
      continue;
    }
    if (suppressQueue) continue;
    const id = exitedTopUnreadArticleId(input, entry, root);
    if (!id || runtime.queued.has(id) || runtime.completed.has(id)) continue;
    runtime.queued.add(id);
    runtime.observed.delete(entry.target);
    activeObserver.unobserve(entry.target);
  }
  if (!runtime.flushing && runtime.queued.size > 0) {
    runtime.flushing = true;
    pauseObserver(runtime);
    void flush(input, runtime.queued, runtime.completed).finally(() => {
      runtime.flushing = false;
      reconcile(runtime, input);
    });
  }
}

/** @param {ScrollMarkerRuntime} runtime */
function pauseObserver(runtime) {
  runtime.observer?.disconnect();
  runtime.observer = null;
  runtime.observed.clear();
  runtime.seen = new WeakSet();
}

/**
 * @param {ScrollMarkerRuntime} runtime
 * @param {Document} documentRef
 */
function reconcileObservedRows(runtime, documentRef) {
  const rows = new Set(documentRef.querySelectorAll('.article-row.is-unread[data-article-id]'));
  for (const target of runtime.observed) {
    if (rows.has(target)) continue;
    runtime.observer?.unobserve(target);
    runtime.observed.delete(target);
  }
  for (const row of rows) {
    if (runtime.observed.has(row)) continue;
    runtime.observer?.observe(row);
    runtime.observed.add(row);
  }
}

/**
 * @param {ScrollMarkerInput} input
 * @param {Set<string>} queued
 * @param {Set<string>} completed
 */
async function flush(input, queued, completed) {
  const ids = [...queued].slice(0, MAX_FLUSH);
  for (const id of ids) {
    queued.delete(id);
    if (completed.has(id) || !isUnread(input.getArticleState(), id)) continue;
    const originArticle = input.getArticleState().items.find((article) => article.id === id) ?? null;
    const readIntentGeneration = articleReadIntentGeneration(input, id);
    try {
      const result = await setArticleRead(id, 1, input.options.browserApi);
      completed.add(id);
      if (articleReadIntentGeneration(input, id) === readIntentGeneration) {
        setArticleReadState(input, id, 1, originArticle, dataRevisionFromResult(result));
      }
    } catch (error) {
      reportScrollMarkerError(error, id);
    }
  }
  if (queued.size > 0) await flush(input, queued, completed);
}

/**
 * @param {unknown} error
 * @param {string} articleId
 */
function reportScrollMarkerError(error, articleId) {
  const safe = toSafeError(error);
  console.error({
    atMs: Date.now(),
    articleId,
    code: safe.code,
    details: safe.details,
    level: 'error',
    operation: 'article-scroll-mark-read',
  });
}

/**
 * @param {ScrollMarkerInput} input
 * @param {IntersectionObserverEntry | {target: Element, isIntersecting: boolean, boundingClientRect: {bottom: number}, rootBounds?: {top: number} | null}} entry
 * @param {Element} root
 */
function exitedTopUnreadArticleId(input, entry, root) {
  const rootTop = entry.rootBounds?.top ?? root.getBoundingClientRect().top;
  if (
    entry.isIntersecting ||
    entry.boundingClientRect.bottom > rootTop ||
    entry.target.getBoundingClientRect().bottom > rootTop
  )
    return '';
  const view = input.options.documentRef.defaultView;
  if (!view || !(entry.target instanceof view.HTMLElement) || !root.contains(entry.target)) return '';
  const id = entry.target.dataset.articleId ?? '';
  return id && isUnread(input.getArticleState(), id) ? id : '';
}

/**
 * @param {import('./article-workflow.js').ArticleState} state
 * @param {string} id
 */
function isUnread(state, id) {
  return state.items.some((article) => article.id === id && article.readState === 0);
}

/**
 * @param {ScrollMarkerInput} input
 * @param {string} id
 * @param {number} readState
 */
/**
 * @param {ScrollMarkerInput} input
 * @param {string} id
 * @param {number} readState
 * @param {Record<string, unknown> | null} [originArticle]
 * @param {number} [dataRevision]
 */
function setArticleReadState(input, id, readState, originArticle = null, dataRevision = 0) {
  const current = input.getArticleState();
  const article = current.items.find((item) => item.id === id) ?? originArticle;
  if (article) {
    input.patchCachedArticleField?.(id, 'readState', numberValue(article.readState), readState, article, {
      authoritativeDataRevision: dataRevision,
    });
  }
  input.setArticleState({
    ...current,
    items: current.items.map((article) => (article.id === id ? { ...article, readState } : article)),
  });
}

/** @param {unknown} value */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** @param {unknown} result */
function dataRevisionFromResult(result) {
  if (typeof result !== 'object' || result === null || !('dataRevision' in result)) return 0;
  return numberValue(result.dataRevision);
}
