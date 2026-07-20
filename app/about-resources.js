// @ts-check

import { openTrustedResource } from './api-client.js';
import { cloneTemplate, queryRequired } from './templates.js';
import { showToast } from './toasts.js';

/** @typedef {'source' | 'license' | 'security'} AboutResource */

/**
 * @param {Document} documentRef
 * @param {ReadonlyArray<{label: string, resource: AboutResource}>} items
 * @returns {HTMLElement}
 */
export function createAboutResourceGroup(documentRef, items) {
  const group = cloneTemplate(documentRef, 'data-static-body-template', '.static-copy');
  group.className = 'about-resource-group';
  group.append(...items.map((item) => createAboutResourceButton(documentRef, item)));
  return group;
}

/**
 * @param {{browserApi: import('./api-client.js').BrowserRuntimeLike, button: HTMLButtonElement, dialog: HTMLDialogElement, documentRef: Document, getMessage(key: string): string, resource: AboutResource}} input
 * @returns {Promise<void>}
 */
export async function activateAboutResource(input) {
  try {
    await openTrustedResource(input.resource, input.browserApi);
  } catch (error) {
    void error;
    showToast(input.documentRef, input.getMessage('aboutResourceOpenFailed'));
  } finally {
    if (dialogIsOpen(input.dialog) && input.button.isConnected) input.button.focus();
  }
}

/**
 * @param {Document} documentRef
 * @param {{label: string, resource: AboutResource}} item
 * @returns {HTMLButtonElement}
 */
function createAboutResourceButton(documentRef, item) {
  const button = cloneTemplate(documentRef, 'data-about-resource-template', '.about-resource-button');
  if (!(button instanceof requireView(documentRef).HTMLButtonElement)) {
    throw new Error('RSSavis About resource template must contain a native button.');
  }
  button.dataset.aboutResource = item.resource;
  queryRequired(button, '[data-about-resource-label]').textContent = item.label;
  return button;
}

/** @param {HTMLDialogElement} dialog */
function dialogIsOpen(dialog) {
  return !dialog.hidden && (dialog.open || dialog.hasAttribute('open'));
}

/** @param {Document} documentRef */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('RSSavis About resources require a document window.');
}
