// @ts-check

import { groupArticlesByDate } from './date-groups.js';
import { reconcileKeyedChildren } from './keyed-dom.js';
import { cloneTemplate, queryRequired } from './templates.js';

/**
 * @typedef {object} KeyedArticleListOptions
 * @property {boolean} hasMore
 * @property {string} loadMoreLabel
 * @property {string} locale
 * @property {string} timeZone
 * @property {(article: Record<string, unknown>) => HTMLElement} createRow
 * @property {(row: HTMLElement, article: Record<string, unknown>) => void} patchRow
 *
 * @typedef {object} DateGroupEntry
 * @property {'group'} kind
 * @property {string} key
 * @property {{key: string, label: string, items: Array<Record<string, unknown>>}} group
 *
 * @typedef {object} LoadMoreEntry
 * @property {'load-more'} kind
 * @property {'load-more'} key
 */

/**
 * Reconciles successful Reader rows by date and article identity. Existing
 * article nodes may move, but are never recreated merely because membership
 * or ordering changed.
 * @param {Document} documentRef
 * @param {HTMLElement} root
 * @param {Array<Record<string, unknown>>} items
 * @param {KeyedArticleListOptions} options
 */
export function reconcileReadyArticleList(documentRef, root, items, options) {
  const existingRows = articleRowsById(root);
  const createdRows = new Set();
  /** @type {Array<DateGroupEntry | LoadMoreEntry>} */
  const entries = groupArticlesByDate(items, { locale: options.locale, timeZone: options.timeZone }).map((group) => ({
    group,
    key: `date:${group.key}`,
    kind: 'group',
  }));
  if (options.hasMore) entries.push({ key: 'load-more', kind: 'load-more' });
  reconcileKeyedChildren(
    root,
    entries,
    articleListNodeKey,
    (entry) => entry.key,
    (entry) => createListNode(documentRef, entry, options.loadMoreLabel),
    (node, entry) => {
      if (entry.kind === 'load-more') {
        setText(node, options.loadMoreLabel);
        return;
      }
      configureDateGroup(documentRef, node, entry.group, existingRows, createdRows, options);
    },
  );
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} section
 * @param {{key: string, label: string, items: Array<Record<string, unknown>>}} group
 * @param {Map<string, HTMLElement>} existingRows
 * @param {Set<HTMLElement>} createdRows
 * @param {KeyedArticleListOptions} options
 */
function configureDateGroup(documentRef, section, group, existingRows, createdRows, options) {
  const heading = queryRequired(section, 'h2');
  const stack = queryRequired(section, '.article-stack');
  const headingId = `date-group-${group.key}`;
  setAttribute(section, 'data-date-key', group.key);
  setAttribute(section, 'aria-labelledby', headingId);
  setAttribute(heading, 'id', headingId);
  setText(heading, group.label);
  reconcileKeyedChildren(
    stack,
    group.items,
    (row) => row.dataset.articleId ?? '',
    articleId,
    (article) => {
      const row = existingRows.get(articleId(article)) ?? options.createRow(article);
      if (!existingRows.has(articleId(article))) createdRows.add(row);
      return row;
    },
    (row, article) => {
      if (!createdRows.has(row)) options.patchRow(row, article);
    },
  );
}

/** @param {Document} documentRef @param {DateGroupEntry | LoadMoreEntry} entry @param {string} loadMoreLabel */
function createListNode(documentRef, entry, loadMoreLabel) {
  if (entry.kind === 'group') return cloneTemplate(documentRef, 'data-article-date-section-template', 'section');
  const button = cloneTemplate(documentRef, 'data-load-more-template', '.load-more-button');
  setText(button, loadMoreLabel);
  return button;
}

/** @param {HTMLElement} node */
function articleListNodeKey(node) {
  if (node.matches('[data-load-more]')) return 'load-more';
  const dateKey = node.getAttribute('data-date-key');
  return dateKey ? `date:${dateKey}` : '';
}

/** @param {HTMLElement} root */
function articleRowsById(root) {
  /** @type {Map<string, HTMLElement>} */
  const rows = new Map();
  for (const row of root.querySelectorAll('[data-article-id]')) {
    if (isHtmlElement(row) && row.dataset.articleId) rows.set(row.dataset.articleId, row);
  }
  return rows;
}

/** @param {Record<string, unknown>} article */
function articleId(article) {
  return typeof article.id === 'string' ? article.id : '';
}

/** @param {Element} element @param {string} name @param {string} value */
function setAttribute(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** @param {Node} node @param {string} text */
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/** @param {unknown} value @returns {value is HTMLElement} */
function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}
