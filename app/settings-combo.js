// @ts-check

import { createAdwPopover } from './adw-popover.js';
import { cloneTemplate, queryRequired } from './templates.js';

const TYPE_AHEAD_RESET_MS = 500;

/**
 * @typedef {object} SettingsListbox
 * @property {(trigger: HTMLElement) => boolean} openForTrigger
 */

/**
 * @param {Document} documentRef
 * @returns {SettingsListbox}
 */
export function createSettingsListbox(documentRef) {
  const popover = queryRequired(documentRef, '[data-settings-listbox]');
  let trigger = /** @type {HTMLElement | null} */ (null);
  let select = /** @type {HTMLSelectElement | null} */ (null);
  let typeAhead = '';
  let typeAheadTimer = 0;
  const controller = createAdwPopover(documentRef, {
    anchorAttribute: 'data-settings-combo-anchor',
    focusFirst: false,
    onClose: cleanupListbox,
    onOpen(nextTrigger, context) {
      prepareListbox(nextTrigger, selectContext(context));
    },
    popover,
  });

  popover.setAttribute('role', 'listbox');
  popover.addEventListener('click', (event) => {
    if (isHidden(popover)) return;
    const option = listboxOption(documentRef, event.target);
    if (!option) return;
    event.preventDefault();
    commitOption(option);
  });
  popover.addEventListener('keydown', (event) => {
    if (event instanceof requireView(documentRef).KeyboardEvent) handleKeyDown(event);
  });

  return { openForTrigger };

  /**
   * @param {HTMLElement} nextTrigger
   */
  function openForTrigger(nextTrigger) {
    const nextSelect = selectForTrigger(documentRef, nextTrigger);
    if (!nextSelect) return false;
    if (trigger === nextTrigger && controller.isOpen()) {
      closeListbox(true);
      return true;
    }
    controller.openForTrigger(nextTrigger, nextSelect);
    focusSelectedOption();
    return true;
  }

  /**
   * @param {KeyboardEvent} event
   */
  function handleKeyDown(event) {
    const options = optionButtons();
    if (options.length === 0) return;
    const key = event.key;
    if (key === 'Escape') {
      event.preventDefault();
      closeListbox(true);
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault();
      focusByKey(key, options);
      return;
    }
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      event.preventDefault();
      const option = listboxOption(documentRef, event.target);
      if (option) commitOption(option);
      return;
    }
    if (isTypeAheadKey(event)) {
      event.preventDefault();
      focusTypeAhead(key, options);
    }
  }

  function buildOptions() {
    if (!select) return;
    popover.replaceChildren();
    popover.setAttribute('aria-labelledby', trigger?.getAttribute('aria-labelledby') ?? '');
    for (const sourceOption of select.options) {
      const option = /** @type {HTMLButtonElement} */ (
        cloneTemplate(documentRef, 'data-settings-listbox-option-template', 'button')
      );
      option.id = `${select.id}-${safeId(sourceOption.value)}-option`;
      option.dataset.value = sourceOption.value;
      option.textContent = sourceOption.textContent;
      option.setAttribute('aria-selected', String(sourceOption.value === select.value));
      popover.append(option);
    }
  }

  function focusSelectedOption() {
    const selected = optionButtons().find((option) => option.getAttribute('aria-selected') === 'true');
    (selected ?? optionButtons()[0])?.focus();
  }

  /**
   * @param {'ArrowDown' | 'ArrowUp' | 'Home' | 'End'} key
   * @param {HTMLButtonElement[]} options
   */
  function focusByKey(key, options) {
    const currentIndex = Math.max(0, options.indexOf(activeOption()));
    const nextIndex =
      key === 'Home'
        ? 0
        : key === 'End'
          ? options.length - 1
          : (currentIndex + (key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[nextIndex]?.focus();
  }

  /**
   * @param {string} key
   * @param {HTMLButtonElement[]} options
   */
  function focusTypeAhead(key, options) {
    typeAhead += key.toLocaleLowerCase();
    clearTypeAheadTimer();
    const view = requireView(documentRef);
    typeAheadTimer = view.setTimeout(() => {
      typeAhead = '';
      typeAheadTimer = 0;
    }, TYPE_AHEAD_RESET_MS);
    const match = options.find((option) => option.textContent?.trim().toLocaleLowerCase().startsWith(typeAhead));
    if (match) match.focus();
  }

  /**
   * @param {HTMLButtonElement} option
   */
  function commitOption(option) {
    if (!select) return;
    const targetSelect = select;
    const value = option.dataset.value ?? '';
    const changed = targetSelect.value !== value;
    targetSelect.value = value;
    syncComboRows(documentRef);
    closeListbox(true);
    const view = requireView(documentRef);
    if (changed) targetSelect.dispatchEvent(new view.Event('change', { bubbles: true }));
  }

  /**
   * @param {boolean} restoreFocus
   */
  function closeListbox(restoreFocus) {
    controller.close({ restoreFocus });
  }

  /**
   * @param {HTMLElement} nextTrigger
   * @param {HTMLSelectElement} nextSelect
   */
  function prepareListbox(nextTrigger, nextSelect) {
    if (trigger && trigger !== nextTrigger) trigger.setAttribute('aria-expanded', 'false');
    trigger = nextTrigger;
    select = nextSelect;
    clearTypeAheadTimer();
    typeAhead = '';
    buildOptions();
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', ensureListboxId(popover));
  }

  function cleanupListbox() {
    if (trigger) {
      trigger.removeAttribute('data-settings-combo-anchor');
      trigger.setAttribute('aria-expanded', 'false');
    }
    popover.replaceChildren();
    trigger = null;
    select = null;
    typeAhead = '';
    clearTypeAheadTimer();
  }

  function clearTypeAheadTimer() {
    if (typeAheadTimer === 0) return;
    requireView(documentRef).clearTimeout(typeAheadTimer);
    typeAheadTimer = 0;
  }

  function optionButtons() {
    return /** @type {HTMLButtonElement[]} */ (
      Array.from(popover.querySelectorAll('[role="option"]')).filter(
        (option) => option instanceof requireView(documentRef).HTMLButtonElement,
      )
    );
  }

  function activeOption() {
    const active = documentRef.activeElement;
    return active instanceof requireView(documentRef).HTMLButtonElement ? active : optionButtons()[0];
  }
}

/**
 * @param {Document} documentRef
 */
export function syncComboRows(documentRef) {
  for (const row of documentRef.querySelectorAll('[data-settings-combo-row]')) {
    const trigger = row.querySelector('[data-settings-combo-trigger]');
    const value = row.querySelector('[data-settings-combo-value]');
    const select = row.querySelector('select');
    const view = requireView(documentRef);
    if (!(trigger instanceof view.HTMLElement) || !(value instanceof view.HTMLElement)) continue;
    if (!(select instanceof view.HTMLSelectElement)) continue;
    const selected = select.selectedOptions[0] ?? select.options[select.selectedIndex] ?? select.options[0];
    value.textContent = selected?.textContent ?? '';
    trigger.dataset.value = select.value;
  }
}

/**
 * @param {Document} documentRef
 * @param {EventTarget | null} value
 */
function listboxOption(documentRef, value) {
  if (!(value instanceof requireView(documentRef).Element)) return null;
  const option = value.closest('[role="option"]');
  return option instanceof requireView(documentRef).HTMLButtonElement ? option : null;
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} trigger
 */
function selectForTrigger(documentRef, trigger) {
  const row = trigger.closest('[data-settings-combo-row]');
  const select = row?.querySelector('select');
  return select instanceof requireView(documentRef).HTMLSelectElement ? select : null;
}

/**
 * @param {unknown} value
 * @returns {HTMLSelectElement}
 */
function selectContext(value) {
  if (!value || typeof value !== 'object' || !('ownerDocument' in value)) {
    throw new Error('Missing settings listbox select.');
  }
  const ownerDocument = /** @type {{ownerDocument?: Document}} */ (value).ownerDocument;
  if (ownerDocument && value instanceof requireView(ownerDocument).HTMLSelectElement) return value;
  throw new Error('Missing settings listbox select.');
}

/**
 * @param {KeyboardEvent} event
 */
function isTypeAheadKey(event) {
  return event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey;
}

/**
 * @param {HTMLElement} popover
 */
function ensureListboxId(popover) {
  if (!popover.id) popover.id = 'settings-listbox';
  return popover.id;
}

/**
 * @param {HTMLElement} element
 */
function isHidden(element) {
  return element.hidden || !element.isConnected;
}

/**
 * @param {string} value
 */
function safeId(value) {
  return value.replace(/[^a-z0-9_-]+/giu, '-');
}

/**
 * @param {Document} documentRef
 */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}
