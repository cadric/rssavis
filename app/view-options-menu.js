// @ts-check

import { createAdwPopover } from './adw-popover.js';

/**
 * @param {Document} documentRef
 */
export function createViewOptionsMenu(documentRef) {
  const trigger = requireHtmlElement(documentRef, '[data-view-options-button]');
  const popover = requireHtmlElement(documentRef, '[data-view-options-menu]');
  let keepOpenActivation = false;
  const controller = createAdwPopover(documentRef, {
    anchorAttribute: 'data-view-options-anchor',
    focusFirst: false,
    onOpen: () => focusFirstMenuItem(documentRef, popover),
    popover,
  });

  trigger.addEventListener('click', () => controller.toggleForTrigger(trigger));
  popover.addEventListener('keydown', (event) => {
    const item = menuItemFromTarget(documentRef, event.target);
    if (!item) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(documentRef, popover, item, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    keepOpenActivation = event.key === ' ';
    item.click();
  });
  popover.addEventListener('click', (event) => {
    if (!menuItemFromTarget(documentRef, event.target)) return;
    if (keepOpenActivation) {
      keepOpenActivation = false;
      return;
    }
    controller.close();
  });

  return controller;
}

/** @param {Document} documentRef @param {HTMLElement} popover */
function focusFirstMenuItem(documentRef, popover) {
  const items = visibleMenuItems(documentRef, popover);
  syncRovingTabIndex(items, items[0] ?? null);
  items[0]?.focus();
}

/** @param {Document} documentRef @param {HTMLElement} popover @param {HTMLElement} current @param {number} direction */
function moveFocus(documentRef, popover, current, direction) {
  const items = visibleMenuItems(documentRef, popover);
  const currentIndex = items.indexOf(current);
  if (currentIndex < 0 || items.length === 0) return;
  const next = items[(currentIndex + direction + items.length) % items.length];
  syncRovingTabIndex(items, next);
  next.focus();
}

/** @param {HTMLElement[]} items @param {HTMLElement | null} current */
function syncRovingTabIndex(items, current) {
  for (const item of items) item.tabIndex = item === current ? 0 : -1;
}

/** @param {Document} documentRef @param {HTMLElement} popover */
function visibleMenuItems(documentRef, popover) {
  /** @type {HTMLElement[]} */
  const items = [];
  for (const item of popover.querySelectorAll('[role="menuitemradio"]')) {
    if (
      isHtmlElement(documentRef, item) &&
      !item.matches(':disabled') &&
      !item.closest('[hidden], [aria-hidden="true"]')
    ) {
      items.push(item);
    }
  }
  return items;
}

/** @param {Document} documentRef @param {EventTarget | null} target */
function menuItemFromTarget(documentRef, target) {
  if (!isHtmlElement(documentRef, target)) return null;
  const item = target.closest('[role="menuitemradio"]');
  return isHtmlElement(documentRef, item) ? item : null;
}

/** @param {Document} documentRef @param {string} selector */
function requireHtmlElement(documentRef, selector) {
  const element = documentRef.querySelector(selector);
  if (isHtmlElement(documentRef, element)) return element;
  throw new Error(`RSSavis shell node missing: ${selector}`);
}

/** @param {Document} documentRef @param {unknown} value @returns {value is HTMLElement} */
function isHtmlElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLElement;
}

/** @param {Document} documentRef */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}
