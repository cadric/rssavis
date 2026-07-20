// @ts-check

import { displayTitle } from '../domain/feed-title.js';
import { scopeCountDescriptor } from './scope-count.js';

/**
 * @param {Document} documentRef
 * @param {{mode: 'reader' | 'settings' | 'help', activeScope: import('../domain/scopes.js').Scope, activeSettingsSection?: string}} state
 * @param {{categories: Array<Record<string, unknown>>, feeds: Array<Record<string, unknown>>, systemStats: {all?: Record<string, unknown>, main?: Record<string, unknown>}}} snapshot
 * @param {{getMessage(key: string, substitutions?: string | number | Array<string | number>): string, getUILanguage(): string, formatNumber?(value: number): string}} i18n
 */
export function renderHeaderbar(documentRef, state, snapshot, i18n) {
  const title = documentRef.querySelector('[data-headerbar-title]');
  const subtitle = documentRef.querySelector('[data-headerbar-subtitle]');
  const readerActive = state.mode === 'reader';
  if (title) {
    if (state.mode === 'help') title.id = 'static-main-title';
    else if (readerActive) title.id = 'reader-main-title';
    else title.removeAttribute('id');
  }
  setHidden(
    documentRef,
    '.headerbar-start [data-sidebar-toggle]',
    state.mode !== 'reader' && state.mode !== 'settings',
  );
  setHidden(documentRef, '.headerbar-start [data-route-link="reader"]', readerActive);
  setHidden(documentRef, '[data-headerbar-reader-controls]', !readerActive);
  setHidden(documentRef, '[data-search-open]', !readerActive);
  setHidden(documentRef, '[data-primary-menu-button][data-menu-placement="sidebar"]', state.mode === 'help');
  setHidden(documentRef, '[data-primary-menu-button][data-menu-placement="headerbar"]', state.mode !== 'help');
  if (state.mode === 'settings') {
    if (title) {
      title.removeAttribute('data-i18n');
      title.textContent = i18n.getMessage(settingsSectionTitleKey(state.activeSettingsSection));
    }
    if (subtitle) {
      subtitle.removeAttribute('data-i18n');
      subtitle.textContent = '';
      if ('hidden' in subtitle) subtitle.hidden = true;
    }
    return;
  }
  if (state.mode !== 'reader') {
    if (title) {
      title.setAttribute('data-i18n', 'helpTitle');
      title.textContent = i18n.getMessage('helpTitle');
    }
    if (subtitle) {
      subtitle.removeAttribute('data-i18n');
      subtitle.textContent = '';
      if ('hidden' in subtitle) subtitle.hidden = true;
    }
    return;
  }
  if (title) {
    title.removeAttribute('data-i18n');
    title.textContent = scopeTitle(state.activeScope, snapshot, i18n);
  }
  if (subtitle) {
    if ('hidden' in subtitle) subtitle.hidden = false;
    const descriptor = scopeCountDescriptor(state.activeScope, snapshot);
    const formatted = formatNumber(i18n, descriptor.count);
    subtitle.removeAttribute('data-i18n');
    subtitle.textContent = i18n.getMessage(descriptor.phraseKey, descriptor.count);
    subtitle.setAttribute('aria-label', subtitle.textContent || formatted);
  }
}

/**
 * @param {string | undefined} section
 */
function settingsSectionTitleKey(section) {
  const keys = /** @type {Record<string, string>} */ ({
    appearance: 'settingsAppearance',
    categories: 'settingsCategories',
    feeds: 'settingsFeeds',
    general: 'settingsGeneral',
    import: 'settingsImport',
    reading: 'settingsReading',
    storage: 'settingsStorage',
  });
  return keys[section || 'appearance'] ?? 'settingsAppearance';
}

/**
 * @param {Document} documentRef
 * @param {string} selector
 * @param {boolean} hidden
 */
function setHidden(documentRef, selector, hidden) {
  for (const element of documentRef.querySelectorAll(selector)) {
    if ('hidden' in element) element.hidden = hidden;
  }
}

/**
 * @param {import('../domain/scopes.js').Scope} scope
 * @param {{categories: Array<Record<string, unknown>>, feeds: Array<Record<string, unknown>>}} snapshot
 * @param {{getMessage(key: string): string}} i18n
 */
export function scopeTitle(scope, snapshot, i18n) {
  if (scope.type === 'system') {
    const keys = /** @type {Record<string, string>} */ ({
      all: 'scopeAll',
      main: 'scopeMain',
      starred: 'scopeStarred',
      unread: 'scopeUnread',
    });
    return i18n.getMessage(keys[scope.id] ?? 'scopeAll');
  }
  const collection = scope.type === 'category' ? snapshot.categories : snapshot.feeds;
  const match = collection.find((item) => item.id === scope.id);
  if (!match) return i18n.getMessage('scopeAll');
  if (scope.type === 'feed') return displayTitle(match) || i18n.getMessage('scopeAll');
  return typeof match.title === 'string' ? match.title : i18n.getMessage('scopeAll');
}

/**
 * @param {{getUILanguage(): string}} i18n
 */
function localeFromI18n(i18n) {
  return i18n.getUILanguage().toLowerCase().startsWith('da') ? 'da' : 'en';
}

/**
 * @param {{getUILanguage(): string, formatNumber?(value: number): string}} i18n
 * @param {number} value
 */
function formatNumber(i18n, value) {
  return i18n.formatNumber ? i18n.formatNumber(value) : new Intl.NumberFormat(localeFromI18n(i18n)).format(value);
}
