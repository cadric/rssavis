// @ts-check

import { toSafeError } from '../domain/errors.js';
import { moveCategory } from './management-api.js';
import { announceStatus } from './toasts.js';

/** @typedef {import('./management-controller.js').ManagementControllerInput} ManagementControllerInput */

let draggedId = '';

/**
 * @param {ManagementControllerInput} input
 * @param {KeyboardEvent} event
 */
export function handleCategoryGripKeydown(input, event) {
  const target = event.target;
  if (!isHtmlElement(target)) return false;
  const grip = target.closest('[data-category-grip]');
  if (!isHtmlElement(grip)) return false;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
  const id = grip.dataset.categoryId ?? '';
  const direction = event.key === 'ArrowUp' ? 'up' : 'down';
  const categories = input.getSnapshot().categories;
  const index = categories.findIndex((category) => category.id === id);
  if (index < 0) return false;
  if (direction === 'up' && index === 0) return true;
  if (direction === 'down' && index === categories.length - 1) return true;
  void moveCategorySteps(input, id, direction, 1);
  return true;
}

/**
 * @param {ManagementControllerInput} input
 * @param {DragEvent} event
 */
export function handleCategoryDragEvent(input, event) {
  const row = categoryRowFromEvent(event);
  if (event.type === 'dragstart' && row) {
    draggedId = row.dataset.categoryId ?? '';
    if (!draggedId) return;
    const dataTransfer = event.dataTransfer;
    dataTransfer?.setData('text/plain', draggedId);
    if (dataTransfer) dataTransfer.effectAllowed = 'move';
    row.classList.add('is-dragging');
    return;
  }
  if (event.type === 'dragover' && row && draggedId) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    markDropTarget(input.options.documentRef, row);
    return;
  }
  if (event.type === 'dragleave' && row) {
    row.classList.remove('is-drop-target');
    return;
  }
  if (event.type === 'drop' && row) {
    event.preventDefault();
    const sourceId = event.dataTransfer?.getData('text/plain') || draggedId;
    const targetId = row.dataset.categoryId ?? '';
    clearDragState(input.options.documentRef);
    if (!sourceId || !targetId || sourceId === targetId) return;
    const categories = input.getSnapshot().categories;
    const from = categories.findIndex((category) => category.id === sourceId);
    const to = categories.findIndex((category) => category.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    void moveCategorySteps(input, sourceId, to < from ? 'up' : 'down', Math.abs(to - from));
    return;
  }
  if (event.type === 'dragend') clearDragState(input.options.documentRef);
}

/**
 * @param {ManagementControllerInput} input
 * @param {string} id
 * @param {'up' | 'down'} direction
 * @param {number} steps
 */
async function moveCategorySteps(input, id, direction, steps) {
  const getMessage = input.options.browserApi.i18n.getMessage;
  try {
    await input.runWithRefreshHold(async () => {
      for (let step = 0; step < steps; step += 1) {
        await moveCategory({ direction, id }, input.options.browserApi);
      }
    });
  } catch (error) {
    announceStatus(input.options.documentRef, getMessage(toSafeError(error).messageKey));
    return;
  }
  const categories = input.getSnapshot().categories;
  const index = categories.findIndex((category) => category.id === id);
  const title = typeof categories[index]?.title === 'string' ? categories[index].title : id;
  announceStatus(input.options.documentRef, getMessage('categoryReorderMoved', [title, index + 1, categories.length]));
  const grip = input.options.documentRef.querySelector(`[data-category-grip][data-category-id="${id}"]`);
  if (input.options.documentRef.defaultView && grip instanceof input.options.documentRef.defaultView.HTMLElement) {
    grip.focus();
  }
}

/**
 * @param {DragEvent} event
 */
function categoryRowFromEvent(event) {
  const target = event.target;
  if (!isHtmlElement(target)) return null;
  const row = target.closest('[data-category-row]');
  return isHtmlElement(row) ? row : null;
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} row
 */
function markDropTarget(documentRef, row) {
  for (const item of documentRef.querySelectorAll('[data-category-row]')) item.classList.remove('is-drop-target');
  row.classList.add('is-drop-target');
}

/**
 * @param {Document} documentRef
 */
function clearDragState(documentRef) {
  draggedId = '';
  for (const item of documentRef.querySelectorAll('[data-category-row]')) {
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
