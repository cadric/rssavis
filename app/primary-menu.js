// @ts-check

import { createAdwPopover } from './adw-popover.js';

/**
 * @typedef {object} PrimaryMenuOptions
 * @property {HTMLElement} popover
 * @property {HTMLElement[]} triggers
 * @property {Document} documentRef
 */

/**
 * @param {PrimaryMenuOptions} options
 */
export function createPrimaryMenu(options) {
  const controller = createAdwPopover(options.documentRef, {
    anchorAttribute: 'data-primary-menu-anchor',
    popover: options.popover,
  });
  /** @param {HTMLElement} trigger */
  const toggleFor = (trigger) => controller.toggleForTrigger(trigger);
  const open = () => controller.openForTrigger(controller.getActiveTrigger() ?? fallbackTrigger(options.triggers));
  const toggle = () => controller.toggleForTrigger(controller.getActiveTrigger() ?? fallbackTrigger(options.triggers));

  for (const trigger of options.triggers) trigger.addEventListener('click', () => toggleFor(trigger));

  return { close: controller.close, open, toggle };
}

/**
 * @param {HTMLElement[]} triggers
 */
function firstVisibleTrigger(triggers) {
  return triggers.find((trigger) => !trigger.hidden && !trigger.closest('[hidden]')) ?? null;
}

/**
 * @param {HTMLElement[]} triggers
 */
function fallbackTrigger(triggers) {
  const trigger = firstVisibleTrigger(triggers) ?? triggers[0];
  if (!trigger) throw new Error('RSSavis primary menu requires at least one trigger.');
  return trigger;
}
