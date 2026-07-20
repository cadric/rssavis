// @ts-check

import { toSafeError } from '../domain/errors.js';
import { captureOpener } from './adw-dialog.js';
import { SHORTCUT_ROWS, shortcutLabel } from './shortcuts-view.js';
import { cloneTemplate, queryRequired } from './templates.js';

/**
 * @typedef {object} ShortcutContext
 * @property {Document} documentRef
 * @property {() => 'reader' | 'settings' | 'help' | null} [getMode]
 * @property {() => unknown} [openPrimaryMenu]
 * @property {() => unknown} [openShortcutsDialog]
 * @property {(operation: string, task: () => unknown) => void} [runAsync]
 * @property {{navigate(mode: 'reader' | 'settings' | 'help'): Promise<void>, navigateSearch(origin?: 'reader' | 'settings'): Promise<void>}} router
 * @property {{openSearch(focusReturn?: HTMLElement | null): void, markCurrentScopeRead(): Promise<void>}} readerController
 * @property {Window} windowRef
 */

/** @type {WeakMap<HTMLElement, {restore(): void}>} */
const dialogFocusRestorers = new WeakMap();

/**
 * @param {KeyboardEvent} event
 * @param {ShortcutContext} context
 */
export function handleKeyboardShortcut(event, context) {
  if (isPrimaryModifier(event) && event.key.toLowerCase() === 'f') {
    if (!canOpenSearch(context.documentRef)) return false;
    event.preventDefault();
    runShortcutTask(context, 'shortcut-search', () =>
      context.router.navigateSearch(searchOrigin(context.getMode?.() ?? null)),
    );
    return true;
  }
  if (isPrimaryModifier(event) && event.key === ',') {
    event.preventDefault();
    runShortcutTask(context, 'shortcut-settings', () => context.router.navigate('settings'));
    return true;
  }
  if (event.key === 'F1' && noShortcutModifiers(event)) {
    event.preventDefault();
    runShortcutTask(context, 'shortcut-help', () => context.router.navigate('help'));
    return true;
  }
  if (event.key === 'F10' && noShortcutModifiers(event) && !event.shiftKey) {
    if (isEditableTarget(event.target) || hasOpenDialog(context.documentRef)) return false;
    event.preventDefault();
    runShortcutTask(context, 'shortcut-menu', () => context.openPrimaryMenu?.());
    return true;
  }
  if (event.key === '?' && noShortcutModifiers(event) && !isEditableTarget(event.target)) {
    event.preventDefault();
    runShortcutTask(context, 'shortcut-shortcuts', () => context.openShortcutsDialog?.());
    return true;
  }
  if (event.key.toLowerCase() === 'a' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (isEditableTarget(event.target)) return false;
    event.preventDefault();
    runShortcutTask(context, 'shortcut-mark-scope-read', () => context.readerController.markCurrentScopeRead());
    return true;
  }
  return false;
}

/**
 * @param {ShortcutContext} context
 * @param {string} operation
 * @param {() => unknown} task
 */
function runShortcutTask(context, operation, task) {
  if (context.runAsync) {
    context.runAsync(operation, task);
    return;
  }
  const result = task();
  if (isPromiseLike(result)) void result.catch((error) => reportShortcutError(operation, error));
}

/**
 * @param {string} operation
 * @param {unknown} error
 */
function reportShortcutError(operation, error) {
  const safe = toSafeError(error);
  console.error({
    atMs: Date.now(),
    code: safe.code,
    details: safe.details,
    level: 'error',
    operation,
  });
}

/**
 * @param {Document} documentRef
 * @param {Window} windowRef
 */
export function renderShortcutKeys(documentRef, windowRef) {
  ensureShortcutDialog(documentRef);
  for (const row of SHORTCUT_ROWS) setShortcut(documentRef, row.id, shortcutLabel(row.key, windowRef));
}

/**
 * @param {Document} documentRef
 */
export function ensureShortcutDialog(documentRef) {
  if (documentRef.querySelector('[data-shortcuts-dialog]')) return;
  const dialog = cloneTemplate(documentRef, 'data-shortcuts-dialog-template', '[data-shortcuts-dialog]');
  dialog.className = 'shortcuts-dialog';
  dialog.hidden = true;
  dialog.setAttribute('aria-labelledby', 'shortcuts-heading');
  dialog.setAttribute('data-shortcuts-dialog', '');
  const heading = queryRequired(dialog, '#shortcuts-heading');
  heading.id = 'shortcuts-heading';
  setI18n(heading, 'shortcutsTitle', 'Keyboard shortcuts');
  const list = queryRequired(dialog, '[data-shortcuts-dialog-list]');
  list.textContent = '';
  for (const row of SHORTCUT_ROWS) addShortcutRow(documentRef, list, row.id, row.key, row.messageKey, row.messageKey);
  const closeButton = /** @type {HTMLButtonElement} */ (queryRequired(dialog, '[data-shortcuts-close]'));
  closeButton.type = 'button';
  closeButton.setAttribute('data-shortcuts-close', '');
  closeButton.setAttribute('data-i18n-title', 'dialogClose');
  closeButton.setAttribute('title', 'Close');
  const closeLabel = queryRequired(closeButton, '.visually-hidden');
  setI18n(closeLabel, 'dialogClose', 'Close');
  const closeIcon = closeButton.querySelector('svg');
  closeIcon?.setAttribute('aria-hidden', 'true');
  documentRef.body.append(dialog);
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} container
 * @param {string} label
 */
function renderKeycaps(documentRef, container, label) {
  container.textContent = '';
  const segments = label.split('+');
  segments.forEach((segment, index) => {
    if (index > 0) container.append(cloneTemplate(documentRef, 'data-keycap-separator-template', 'span'));
    const keycap = cloneTemplate(documentRef, 'data-keycap-template', 'kbd');
    keycap.textContent = segment;
    container.append(keycap);
  });
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} list
 * @param {string} name
 * @param {string} keyLabel
 * @param {string} messageKey
 * @param {string} fallback
 */
function addShortcutRow(documentRef, list, name, keyLabel, messageKey, fallback) {
  const row = cloneTemplate(documentRef, 'data-shortcut-row-template', 'div');
  const key = queryRequired(row, '[data-shortcut-key]');
  key.setAttribute('data-shortcut-key', name);
  renderKeycaps(documentRef, key, keyLabel);
  const description = queryRequired(row, '[data-shortcut-description]');
  setI18n(description, messageKey, fallback);
  list.append(row);
}

/**
 * @param {HTMLElement} element
 * @param {string} key
 * @param {string} fallback
 */
function setI18n(element, key, fallback) {
  element.setAttribute('data-i18n', key);
  element.textContent = fallback;
}

/**
 * @param {Document} documentRef
 * @param {string} selector
 */
export function showDialog(documentRef, selector) {
  const dialog = documentRef.querySelector(selector);
  if (!isHtmlElement(dialog)) return;
  dialogFocusRestorers.set(dialog, captureOpener(documentRef));
  dialog.removeAttribute('hidden');
  let opened = false;
  try {
    if ('showModal' in dialog && typeof dialog.showModal === 'function') {
      dialog.showModal();
      opened = true;
    }
  } catch (error) {
    if (!isExpectedDialogFallbackError(error)) throw error;
    // Fall through to the static open attribute path used by tests and older DOM implementations.
  }
  if (!opened) {
    dialog.removeAttribute('hidden');
    dialog.setAttribute('open', '');
  }
  focusDialogInitialControl(dialog);
}

/**
 * @param {unknown} error
 */
function isExpectedDialogFallbackError(error) {
  return error instanceof DOMException && (error.name === 'InvalidStateError' || error.name === 'NotSupportedError');
}

/**
 * @param {Document} documentRef
 * @param {string} selector
 */
export function closeDialog(documentRef, selector) {
  const dialog = documentRef.querySelector(selector);
  if (!isHtmlElement(dialog)) return;
  if ('close' in dialog && typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  dialog.setAttribute('hidden', '');
  const opener = dialogFocusRestorers.get(dialog);
  dialogFocusRestorers.delete(dialog);
  opener?.restore();
}

/**
 * @param {HTMLElement} dialog
 */
function focusDialogInitialControl(dialog) {
  const target =
    dialog.querySelector('[autofocus]:not([disabled])') ??
    dialog.querySelector(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
    );
  if (isHtmlElement(target)) target.focus();
}

/**
 * @param {KeyboardEvent} event
 */
function isPrimaryModifier(event) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

/**
 * @param {KeyboardEvent} event
 */
function noShortcutModifiers(event) {
  return !event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * @param {unknown} target
 */
function isEditableTarget(target) {
  if (!isHtmlElement(target)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

/**
 * @param {Document} documentRef
 */
function canOpenSearch(documentRef) {
  return Boolean(documentRef.querySelector('[data-reader-main]:not([hidden]), [data-settings-main]:not([hidden])'));
}

/**
 * @param {Document} documentRef
 */
function hasOpenDialog(documentRef) {
  return Boolean(documentRef.querySelector('dialog[open]'));
}

/**
 * @param {ReturnType<NonNullable<ShortcutContext['getMode']>>} mode
 * @returns {'reader' | 'settings'}
 */
function searchOrigin(mode) {
  return mode === 'settings' ? 'settings' : 'reader';
}

/**
 * @param {Document} documentRef
 * @param {string} name
 * @param {string} label
 */
function setShortcut(documentRef, name, label) {
  for (const element of documentRef.querySelectorAll(`[data-shortcut-key="${name}"]`)) {
    if (isHtmlElement(element) && element.classList.contains('shortcut-keys')) {
      renderKeycaps(documentRef, element, label);
    } else element.textContent = label;
  }
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
 * @returns {value is Promise<unknown>}
 */
function isPromiseLike(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    'catch' in value &&
    typeof (/** @type {{catch?: unknown}} */ (value).catch) === 'function'
  );
}
