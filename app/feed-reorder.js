// @ts-check

import { toSafeError } from '../domain/errors.js';
import { displayTitle } from '../domain/feed-title.js';
import { moveFeed } from './management-api.js';
import { announceStatus } from './toasts.js';

/** @typedef {import('./management-controller.js').ManagementControllerInput} ManagementControllerInput */

let draggedId = '';
let draggedCategoryId = '';

/**
 * @param {ManagementControllerInput} input
 * @param {KeyboardEvent} event
 */
export function handleFeedGripKeydown(input, event) {
  const target = event.target;
  if (!isHtmlElement(target)) return false;
  const grip = target.closest('[data-feed-grip]');
  if (!isHtmlElement(grip)) return false;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
  const id = grip.dataset.feedId ?? '';
  const categoryId = grip.dataset.categoryId ?? '';
  const direction = event.key === 'ArrowUp' ? 'up' : 'down';
  const feeds = categoryFeeds(input, categoryId);
  const index = feeds.findIndex((feed) => feed.id === id);
  if (index < 0) return false;
  if (direction === 'up' && index === 0) return true;
  if (direction === 'down' && index === feeds.length - 1) return true;
  void moveFeedSteps(input, id, categoryId, direction, 1);
  return true;
}

/**
 * @param {ManagementControllerInput} input
 * @param {DragEvent} event
 */
export function handleFeedDragEvent(input, event) {
  const row = feedRowFromEvent(event);
  if (event.type === 'dragstart' && row) {
    draggedId = row.dataset.feedId ?? '';
    draggedCategoryId = row.dataset.categoryId ?? '';
    if (!draggedId) return;
    event.dataTransfer?.setData('text/plain', draggedId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    row.classList.add('is-dragging');
    return;
  }
  // Same-category constraint (user decision): rows in other categories are
  // never valid drop targets, so cross-category drops fall through untouched.
  const sameCategory = Boolean(row && draggedId && row.dataset.categoryId === draggedCategoryId);
  if (event.type === 'dragover' && row && sameCategory) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    markDropTarget(input.options.documentRef, row);
    return;
  }
  if (event.type === 'dragleave' && row) {
    row.classList.remove('is-drop-target');
    return;
  }
  if (event.type === 'drop' && row && sameCategory) {
    event.preventDefault();
    const sourceId = event.dataTransfer?.getData('text/plain') || draggedId;
    const targetId = row.dataset.feedId ?? '';
    const categoryId = draggedCategoryId;
    clearDragState(input.options.documentRef);
    if (!sourceId || !targetId || sourceId === targetId) return;
    const feeds = categoryFeeds(input, categoryId);
    const from = feeds.findIndex((feed) => feed.id === sourceId);
    const to = feeds.findIndex((feed) => feed.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    void moveFeedSteps(input, sourceId, categoryId, to < from ? 'up' : 'down', Math.abs(to - from));
    return;
  }
  if (event.type === 'dragend') clearDragState(input.options.documentRef);
}

/**
 * @param {ManagementControllerInput} input
 * @param {string} categoryId
 */
function categoryFeeds(input, categoryId) {
  return input.getSnapshot().feeds.filter((feed) => feed.categoryId === categoryId);
}

/**
 * @param {ManagementControllerInput} input
 * @param {string} id
 * @param {string} categoryId
 * @param {'up' | 'down'} direction
 * @param {number} steps
 */
async function moveFeedSteps(input, id, categoryId, direction, steps) {
  const getMessage = input.options.browserApi.i18n.getMessage;
  try {
    await input.runWithRefreshHold(async () => {
      for (let step = 0; step < steps; step += 1) {
        await moveFeed({ categoryId, direction, id }, input.options.browserApi);
      }
    });
  } catch (error) {
    announceStatus(input.options.documentRef, getMessage(toSafeError(error).messageKey));
    return;
  }
  const feeds = categoryFeeds(input, categoryId);
  const index = feeds.findIndex((feed) => feed.id === id);
  const title = index >= 0 ? displayTitle(feeds[index]) : id;
  announceStatus(input.options.documentRef, getMessage('feedReorderMoved', [title, index + 1, feeds.length]));
  const grip = input.options.documentRef.querySelector(`[data-feed-grip][data-feed-id="${id}"]`);
  if (input.options.documentRef.defaultView && grip instanceof input.options.documentRef.defaultView.HTMLElement) {
    grip.focus();
  }
}

/**
 * @param {DragEvent} event
 */
function feedRowFromEvent(event) {
  const target = event.target;
  if (!isHtmlElement(target)) return null;
  const row = target.closest('[data-feed-row]');
  return isHtmlElement(row) ? row : null;
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} row
 */
function markDropTarget(documentRef, row) {
  for (const item of documentRef.querySelectorAll('[data-feed-row]')) item.classList.remove('is-drop-target');
  row.classList.add('is-drop-target');
}

/**
 * @param {Document} documentRef
 */
function clearDragState(documentRef) {
  draggedId = '';
  draggedCategoryId = '';
  for (const item of documentRef.querySelectorAll('[data-feed-row]')) {
    item.classList.remove('is-dragging', 'is-drop-target');
  }
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}
