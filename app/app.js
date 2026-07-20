// @ts-check

import { createAppShell } from './app-shell.js';
import { toSafeError } from '../domain/errors.js';

/**
 * @typedef {object} AppBrowser
 * @property {{getUILanguage(): string, getMessage(key: string): string}} i18n
 * @property {{request(permissions: {origins: string[]}): Promise<boolean>}} permissions
 * @property {{sendMessage(message: unknown): Promise<unknown>, getManifest(): {version?: string}}} runtime
 * @property {{local: {get(keys: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>, set(items: Record<string, unknown>): Promise<void>}}} storage
 */

const browser = /** @type {{browser: AppBrowser}} */ (/** @type {unknown} */ (globalThis)).browser;
const shell = createAppShell({
  browserApi: browser,
  documentRef: document,
  matchMedia: window.matchMedia.bind(window),
  storageArea: browser.storage.local,
  windowRef: window,
});

void shell.start().catch((error) => {
  const safe = toSafeError(error);
  console.error({
    atMs: Date.now(),
    code: safe.code,
    details: safe.details,
    level: 'error',
    operation: 'app-start',
  });
  const status = document.querySelector('[data-rssavis-status]');
  if (!status || !('textContent' in status)) return;
  status.textContent = browser.i18n.getMessage('errorInternal');
});
