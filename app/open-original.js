// @ts-check

import { openArticleOriginal } from './api-client.js';
import { toSafeError } from '../domain/errors.js';
import { createAppI18n } from './i18n.js';

/**
 * @typedef {object} BridgeBrowser
 * @property {{getMessage(key: string): string, getUILanguage(): string}} i18n
 * @property {{getURL(path: string): string, sendMessage(message: unknown): Promise<unknown>}} runtime
 * @property {{local: {get(keys: string): Promise<Record<string, unknown>>}}} storage
 */

const browserApi = /** @type {{browser: BridgeBrowser}} */ (/** @type {unknown} */ (globalThis)).browser;
const ARTICLE_ID_PATTERN = /^art_[0-9a-f]{64}$/i;

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
    reportOpenOriginalError(error);
    await i18n.setLanguage('auto');
  }
  localizeDocument(i18n.getMessage);
  const heading = requiredElement('[data-open-original-root] h1');
  focusElement(heading);
  const articleId = articleIdFromHash(location.hash);
  if (!articleId) {
    showRecovery(i18n.getMessage('openOriginalInvalid'));
    return;
  }
  void openArticleOriginal(articleId, 'current-tab', browserApi).catch((error) => {
    reportOpenOriginalError(error);
    showRecovery(i18n.getMessage('openOriginalFailed'));
  });
}

/** @param {(key: string) => string} getMessage */
function localizeDocument(getMessage) {
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = getMessage(element.getAttribute('data-i18n') ?? '');
  }
  requiredElement('[data-open-original-reader]').addEventListener('click', () => {
    location.href = browserApi.runtime.getURL('app/index.html');
  });
  requiredElement('[data-open-original-close]').addEventListener('click', () => {
    window.close();
  });
}

/**
 * @param {string} hash
 */
function articleIdFromHash(hash) {
  const encoded = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!encoded) return '';
  try {
    const decoded = decodeURIComponent(encoded);
    return ARTICLE_ID_PATTERN.test(decoded) ? decoded : '';
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return '';
  }
}

/**
 * @param {unknown} error
 */
function reportOpenOriginalError(error) {
  const safe = toSafeError(error);
  console.error({
    atMs: Date.now(),
    code: safe.code,
    details: safe.details,
    level: 'error',
    operation: 'open-original-bridge',
  });
}

/**
 * @param {string} message
 */
function showRecovery(message) {
  const status = requiredElement('[data-open-original-status]');
  status.textContent = message;
  const recovery = requiredElement('[data-open-original-recovery]');
  recovery.hidden = false;
  requiredElement('[data-open-original-error]').textContent = message;
  focusElement(requiredElement('[data-open-original-reader]'));
}

/**
 * @param {string} selector
 * @returns {HTMLElement}
 */
function requiredElement(selector) {
  const element = document.querySelector(selector);
  if (element instanceof HTMLElement) return element;
  throw new Error(`Missing open-original element: ${selector}`);
}

/**
 * @param {HTMLElement} element
 */
function focusElement(element) {
  element.focus({ preventScroll: true });
}
