// @ts-check

import { CHANGE_EVENT_TYPES } from '../shared/messages.js';
import { createEventBoundary } from './event-boundary.js';
import { cloneTemplate } from './templates.js';

/**
 * @param {{browserApi: {i18n: {getMessage(key: string): string}, runtime: {onMessage?: {addListener(listener: (message: unknown) => unknown): void}}}, documentRef: Document}} options
 * @param {{handleDataChangedEvent(event: unknown): Promise<void>, reloadReaderData?(announceRefresh?: boolean): Promise<boolean | void>}} readerController
 */
export function setupDatabaseRecoveryEvents(options, readerController) {
  const runEvent = createEventBoundary(options);
  options.browserApi.runtime.onMessage?.addListener((message) => {
    if (isDataChangedEvent(message)) {
      runEvent('runtime-data-changed', () => readerController.handleDataChangedEvent(message));
    }
    if (isDatabaseBlockedEvent(message)) {
      showDatabaseRecovery(options.documentRef, 'blocked', options.browserApi.i18n.getMessage('databaseBlocked'), {
        code: 'DB_UPGRADE_BLOCKED',
        getMessage: options.browserApi.i18n.getMessage,
        onRetry: async () => {
          await readerController.reloadReaderData?.(true);
        },
      });
    }
    if (isDatabaseReloadRequiredEvent(message)) {
      showDatabaseRecovery(
        options.documentRef,
        'reload-required',
        options.browserApi.i18n.getMessage('databaseReloadRequired'),
        {
          code: 'DB_VERSION_ERROR',
          getMessage: options.browserApi.i18n.getMessage,
          onRetry: async () => {
            await readerController.reloadReaderData?.(true);
          },
        },
      );
    }
    return false;
  });
}

/**
 * @typedef {object} DatabaseRecoveryOptions
 * @property {string} code
 * @property {(key: string) => string} getMessage
 * @property {() => Promise<void> | void} [onRetry]
 */

/**
 * @param {Document} documentRef
 * @param {'blocked' | 'reload-required' | 'startup'} state
 * @param {string} message
 * @param {DatabaseRecoveryOptions} options
 */
export function showDatabaseRecovery(documentRef, state, message, options) {
  documentRef.documentElement.dataset.databaseRecovery = state;
  documentRef.documentElement.dataset.databaseRecoveryCode = options.code;
  setText(documentRef, '[data-rssavis-status]', message);
  const panel = cloneRecoveryPanel(documentRef);
  panel.dataset.databaseRecoveryPanel = '';
  panel.dataset.errorCode = options.code;
  setText(panel, '[data-database-recovery-heading]', options.getMessage('databaseRecoveryHeading'));
  setText(panel, '[data-database-recovery-message]', message);
  setText(panel, '[data-database-recovery-code]', options.code);
  setText(panel, '[data-database-recovery-retry]', options.getMessage('databaseRecoveryRetry'));
  setText(panel, '[data-database-recovery-reload]', options.getMessage('databaseRecoveryReload'));
  setText(panel, '[data-database-recovery-close]', options.getMessage('databaseRecoveryClose'));
  attachRecoveryActions(documentRef, panel, options);
  documentRef.querySelector('[data-database-recovery-panel]')?.remove();
  const readerMain = documentRef.querySelector('[data-reader-main]');
  if (isHtmlElement(readerMain)) readerMain.prepend(panel);
  const empty = documentRef.querySelector('[data-reader-empty]');
  if (isHtmlElement(empty)) empty.hidden = true;
  focusRecoveryPanel(panel);
  const subtitle = documentRef.querySelector('[data-headerbar-subtitle]');
  if (isHtmlElement(subtitle)) {
    subtitle.removeAttribute('data-i18n');
    subtitle.textContent = message;
  }
}

/**
 * @param {Document} documentRef
 * @returns {HTMLElement}
 */
function cloneRecoveryPanel(documentRef) {
  return cloneTemplate(documentRef, 'data-database-recovery-template', '[data-database-recovery-panel]');
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} panel
 * @param {DatabaseRecoveryOptions} options
 */
function attachRecoveryActions(documentRef, panel, options) {
  panel.querySelector('[data-database-recovery-retry]')?.addEventListener('click', () => {
    void options.onRetry?.();
  });
  panel.querySelector('[data-database-recovery-reload]')?.addEventListener('click', () => {
    documentRef.defaultView?.location.reload();
  });
  panel.querySelector('[data-database-recovery-close]')?.addEventListener('click', () => {
    panel.remove();
  });
}

/**
 * @param {HTMLElement} panel
 */
function focusRecoveryPanel(panel) {
  const target = panel.querySelector('[data-database-recovery-retry]') ?? panel.querySelector('h2');
  if (isHtmlElement(target) && typeof target.focus === 'function') target.focus({ preventScroll: true });
}

/**
 * @param {ParentNode} documentRef
 * @param {string} selector
 * @param {string} message
 */
function setText(documentRef, selector, message) {
  const element = documentRef.querySelector(selector);
  if (isHtmlElement(element)) element.textContent = message;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isDataChangedEvent(value) {
  return eventType(value) === CHANGE_EVENT_TYPES.DATA_CHANGED;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isDatabaseBlockedEvent(value) {
  return eventType(value) === CHANGE_EVENT_TYPES.DATABASE_BLOCKED;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isDatabaseReloadRequiredEvent(value) {
  return eventType(value) === CHANGE_EVENT_TYPES.DATABASE_RELOAD_REQUIRED;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function eventType(value) {
  return typeof value === 'object' && value !== null && 'type' in value
    ? /** @type {{type: unknown}} */ (value).type
    : null;
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}
