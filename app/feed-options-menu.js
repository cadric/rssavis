// @ts-check

import { createAdwPopover } from './adw-popover.js';

/**
 * @typedef {import('./api-client.js').BootstrapSnapshot} BootstrapSnapshot
 */

/**
 * @param {Document} documentRef
 */
export function createFeedOptionsMenu(documentRef) {
  const popover = htmlElement(documentRef.querySelector('[data-feed-options-menu]'), documentRef);
  const controller = createAdwPopover(documentRef, {
    anchorAttribute: 'data-feed-menu-anchor',
    onOpen(trigger, context) {
      stampActions(popover, trigger);
      applyFeedState(popover, trigger, snapshotContext(context));
    },
    popover,
  });

  return {
    close: controller.close,
    getActiveTrigger: controller.getActiveTrigger,
    isOpen: controller.isOpen,
    openForTrigger: controller.openForTrigger,
    /** @param {BootstrapSnapshot} snapshot */
    prepareForSnapshot(snapshot) {
      const trigger = controller.getActiveTrigger();
      if (!trigger) return;
      const feed = snapshot.feeds.find((item) => item.id === (trigger.dataset.feedId ?? ''));
      if (!trigger.isConnected || !feed || trigger.closest('[data-settings-management-section]')) {
        controller.close();
        return;
      }
      applyFeedState(popover, trigger, snapshot);
    },
  };
}

/**
 * @param {HTMLElement} popover
 * @param {HTMLElement} trigger
 */
function stampActions(popover, trigger) {
  for (const action of popover.querySelectorAll('[data-feed-action]')) {
    if (!isHtmlElement(action)) continue;
    action.dataset.feedId = trigger.dataset.feedId ?? '';
    action.dataset.categoryId = trigger.dataset.categoryId ?? '';
  }
}

/**
 * @param {HTMLElement} popover
 * @param {HTMLElement} trigger
 * @param {BootstrapSnapshot} snapshot
 */
function applyFeedState(popover, trigger, snapshot) {
  const feedId = trigger.dataset.feedId ?? '';
  const feed = snapshot.feeds.find((item) => item.id === feedId);
  const mainStream = menuButton(popover, 'toggle-main-stream');
  mainStream.setAttribute('aria-pressed', feed?.mainStreamState === 1 ? 'true' : 'false');
}

/**
 * @param {HTMLElement} popover
 */
/** @param {HTMLElement} popover
 * @param {string} action
 */
function menuButton(popover, action) {
  const button = popover.querySelector(`[data-feed-action="${action}"]`);
  if (button instanceof requireView(popover.ownerDocument).HTMLButtonElement) return button;
  throw new Error(`Missing feed menu action ${action}`);
}

/**
 * @param {Element | null} element
 * @param {Document} documentRef
 */
function htmlElement(element, documentRef) {
  if (element instanceof requireView(documentRef).HTMLElement) return element;
  throw new Error('Missing feed options menu.');
}

/**
 * @param {Document} documentRef
 */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}

/**
 * @param {unknown} value
 * @returns {BootstrapSnapshot}
 */
function snapshotContext(value) {
  if (
    value &&
    typeof value === 'object' &&
    'feeds' in value &&
    Array.isArray(/** @type {{feeds?: unknown}} */ (value).feeds)
  ) {
    return /** @type {BootstrapSnapshot} */ (value);
  }
  throw new Error('Missing feed options menu snapshot.');
}
