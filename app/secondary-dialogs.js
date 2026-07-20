// @ts-check

import { captureOpener, trapDialogTab } from './adw-dialog.js';
import { activateAboutResource } from './about-resources.js';
import { bindAboutDialogNavigation, renderAboutDialogContent } from './about-dialog.js';
import { ensureShortcutDialog } from './keyboard-shortcuts.js';
import { requireCanonicalProductVersion } from '../domain/release-version.js';

/** @type {WeakMap<HTMLElement, {restore(): void}>} */
const secondaryOpeners = new WeakMap();
/** @type {WeakSet<HTMLElement>} */
const initializedDialogs = new WeakSet();

/**
 * @param {{documentRef: Document, browserApi: {i18n: {getMessage(key: string, substitutions?: string | string[]): string}, runtime: {getManifest(): {version?: string}, sendMessage(message: unknown): Promise<unknown>}}}} input
 */
export function openAboutDialog(input) {
  const dialog = requiredDialog(input.documentRef, '[data-about-dialog]');
  const content = requiredElement(input.documentRef, '[data-about-dialog-content]');
  const version = requireCanonicalProductVersion(input.browserApi.runtime.getManifest().version);
  const fragment = renderAboutDialogContent(input.documentRef, input.browserApi.i18n.getMessage, version);
  content.replaceChildren(fragment);
  bindAboutDialogNavigation(content, {
    openResource: (resource, button) =>
      activateAboutResource({
        browserApi: input.browserApi,
        button,
        dialog,
        documentRef: input.documentRef,
        getMessage: input.browserApi.i18n.getMessage,
        resource,
      }),
  });
  setupSecondaryDialog(dialog, '[data-about-close]');
  showSecondaryDialog(input.documentRef, dialog);
}

/**
 * @param {{documentRef: Document, windowRef: Window}} input
 */
export function openShortcutsDialog(input) {
  void input.windowRef;
  ensureShortcutDialog(input.documentRef);
  const dialog = requiredDialog(input.documentRef, '[data-shortcuts-dialog]');
  setupSecondaryDialog(dialog, '[data-shortcuts-close]');
  showSecondaryDialog(input.documentRef, dialog);
}

/**
 * @param {HTMLDialogElement} dialog
 * @param {string} closeSelector
 */
function setupSecondaryDialog(dialog, closeSelector) {
  if (initializedDialogs.has(dialog)) return;
  initializedDialogs.add(dialog);
  dialog.querySelector(closeSelector)?.addEventListener('click', () => closeSecondaryDialog(dialog));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeSecondaryDialog(dialog);
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeSecondaryDialog(dialog);
  });
  dialog.addEventListener('keydown', (event) => trapDialogTab(dialog, event));
}

/**
 * @param {Document} documentRef
 * @param {HTMLDialogElement} dialog
 */
function showSecondaryDialog(documentRef, dialog) {
  secondaryOpeners.set(dialog, captureOpener(documentRef));
  dialog.hidden = false;
  let opened = false;
  try {
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
      opened = true;
    }
  } catch (error) {
    if (!isExpectedDialogFallbackError(error)) throw error;
  }
  if (!opened) dialog.setAttribute('open', '');
  focusInitialControl(dialog);
}

/**
 * @param {HTMLDialogElement} dialog
 */
function closeSecondaryDialog(dialog) {
  if (typeof dialog.close === 'function' && dialog.hasAttribute('open')) dialog.close();
  else dialog.removeAttribute('open');
  dialog.hidden = true;
  secondaryOpeners.get(dialog)?.restore();
  secondaryOpeners.delete(dialog);
}

/**
 * @param {unknown} error
 */
function isExpectedDialogFallbackError(error) {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  return error.name === 'InvalidStateError' || error.name === 'NotSupportedError';
}

/**
 * @param {HTMLElement} dialog
 */
function focusInitialControl(dialog) {
  const target =
    dialog.querySelector('[data-dialog-initial-focus]') ??
    dialog.querySelector(
      '[autofocus], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
    );
  const view = dialog.ownerDocument.defaultView;
  if (view && target instanceof view.HTMLElement) target.focus();
}

/**
 * @param {Document} documentRef
 * @param {string} selector
 */
function requiredDialog(documentRef, selector) {
  const element = documentRef.querySelector(selector);
  if (documentRef.defaultView && element instanceof documentRef.defaultView.HTMLDialogElement) return element;
  throw new Error(`RSSavis secondary dialog is missing ${selector}.`);
}

/**
 * @param {Document} documentRef
 * @param {string} selector
 */
function requiredElement(documentRef, selector) {
  const element = documentRef.querySelector(selector);
  if (documentRef.defaultView && element instanceof documentRef.defaultView.HTMLElement) return element;
  throw new Error(`RSSavis secondary dialog is missing ${selector}.`);
}
