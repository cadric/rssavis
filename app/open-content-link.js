// @ts-check

import { openArticleContentLink } from './api-client.js';
import { httpsOnlyUrl } from '../domain/urls.js';
import { toSafeError } from '../domain/errors.js';
import { createAppI18n } from './i18n.js';

/**
 * @typedef {object} BridgeBrowser
 * @property {{getMessage(key: string): string, getUILanguage(): string}} i18n
 * @property {{getURL(path: string): string, sendMessage(message: unknown): Promise<unknown>}} runtime
 * @property {{local: {get(keys: string): Promise<Record<string, unknown>>}}} storage
 */

const browserApi = /** @type {{browser: BridgeBrowser}} */ (/** @type {unknown} */ (globalThis)).browser;

void startBridge();

async function startBridge() {
  const i18n = createAppI18n({
    browserI18n: browserApi.i18n,
    documentRef: document,
    storageArea: browserApi.storage.local,
  });
  try {
    await i18n.start();
  } catch (error) {
    reportOpenContentLinkError(error);
    await i18n.setLanguage('auto');
  }
  localizeDocument(i18n.getMessage);
  const heading = requiredElement('[data-open-content-link-root] h1');
  focusElement(heading);
  const url = contentLinkFromHash(location.hash);
  if (!url) {
    showRecovery(i18n.getMessage('openContentLinkInvalid'));
    return;
  }
  // SEC-004: the decoded+validated https URL is handed to the background command
  // (which re-validates it and opens it via browser.tabs). It is never assigned
  // to `location`/`window.open` here — only the internal reader URL is (below).
  void openArticleContentLink(url, 'current-tab', browserApi).catch((error) => {
    reportOpenContentLinkError(error);
    showRecovery(i18n.getMessage('openContentLinkFailed'));
  });
}

/** @param {(key: string) => string} getMessage */
function localizeDocument(getMessage) {
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = getMessage(element.getAttribute('data-i18n') ?? '');
  }
  requiredElement('[data-open-content-link-reader]').addEventListener('click', () => {
    location.href = browserApi.runtime.getURL('app/index.html');
  });
  requiredElement('[data-open-content-link-close]').addEventListener('click', () => {
    window.close();
  });
}

/**
 * @param {string} hash
 * @returns {string} the decoded https URL, or '' for a missing/malformed/non-https hash
 */
function contentLinkFromHash(hash) {
  const encoded = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!encoded) return '';
  try {
    return httpsOnlyUrl(decodeURIComponent(encoded));
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return '';
  }
}

/**
 * @param {unknown} error
 */
function reportOpenContentLinkError(error) {
  const safe = toSafeError(error);
  console.error({
    atMs: Date.now(),
    code: safe.code,
    details: safe.details,
    level: 'error',
    operation: 'open-content-link-bridge',
  });
}

/**
 * @param {string} message
 */
function showRecovery(message) {
  const status = requiredElement('[data-open-content-link-status]');
  status.textContent = message;
  const recovery = requiredElement('[data-open-content-link-recovery]');
  recovery.hidden = false;
  requiredElement('[data-open-content-link-error]').textContent = message;
  focusElement(requiredElement('[data-open-content-link-reader]'));
}

/**
 * @param {string} selector
 * @returns {HTMLElement}
 */
function requiredElement(selector) {
  const element = document.querySelector(selector);
  if (element instanceof HTMLElement) return element;
  throw new Error(`Missing open-content-link element: ${selector}`);
}

/**
 * @param {HTMLElement} element
 */
function focusElement(element) {
  element.focus({ preventScroll: true });
}
