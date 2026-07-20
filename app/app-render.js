// @ts-check

import { displayTitle } from '../domain/feed-title.js';
import { overlayCurrentFeedMetadata } from './article-feed-metadata.js';
import { localizeDocument } from './dialogs.js';
import { renderHeaderbar, scopeTitle } from './headerbar.js';
import { renderNewArticlesBanner } from './new-articles-banner.js';
import { renderPermissionBanner } from './permission-banner.js';
import { supportedLanguage } from './app-shell-utils.js';
import { renderReaderView } from './reader-view.js';
import { renderSettingsView } from './settings-view.js';
import { renderSidebar } from './sidebar.js';
import { syncSidebarDialogs } from './sidebar-shell.js';
import { renderStaticView } from './static-router.js';

/**
 * @param {import('./app-shell.js').AppShellOptions} options
 * @param {Awaited<ReturnType<ReturnType<typeof import('./state-store.js').createUiStateStore>['read']>>} state
 * @param {ReturnType<typeof import('./reader-state.js').emptySnapshot>} snapshot
 * @param {ReturnType<typeof import('./reader-state.js').emptyArticleState>} articleState
 */
export function applyState(options, state, snapshot, articleState) {
  const { browserApi, documentRef } = options;
  const readerActive = state.mode === 'reader';
  const settingsActive = state.mode === 'settings';
  const staticActive = state.mode === 'help';
  setHidden(documentRef, '[data-reader-main]', !readerActive);
  setHidden(documentRef, '[data-settings-main]', !settingsActive);
  setHidden(documentRef, '[data-static-main]', !staticActive);
  syncSearchVisibility(documentRef, readerActive && articleState.searchActive === true);
  renderHeaderbar(documentRef, state, snapshot, browserApi.i18n);
  syncHeaderbarResponsiveControls(options, readerActive);
  syncSidebarDialogs(documentRef, state, options.matchMedia);
  syncSidebarToggleCopy(documentRef);
  if (readerActive) {
    renderSidebar(documentRef, state, snapshot, browserApi.i18n, articleState.settings);
    renderReaderView(
      documentRef,
      state,
      {
        ...articleState,
        items: overlayCurrentFeedMetadata(articleState.items, snapshot.feeds ?? []),
      },
      {
        activeScopeLabel: scopeTitle(state.activeScope, snapshot, browserApi.i18n),
        feedTitleById: feedDisplayTitleMap(snapshot.feeds ?? []),
        getMessage: (key) => browserApi.i18n.getMessage(key),
        hasFeeds: snapshot.feeds.length > 0,
        locale: supportedLanguage(browserApi.i18n.getUILanguage()),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      },
    );
    renderPermissionBanner(documentRef, state, snapshot, browserApi.i18n);
    renderNewArticlesBanner(documentRef, articleState, browserApi.i18n);
  } else {
    setHidden(documentRef, '[data-permission-banner]', true);
    setHidden(documentRef, '[data-new-articles-banner]', true);
  }
  if (settingsActive) renderSettingsView(documentRef, state, snapshot, browserApi.i18n);
  if (state.mode === 'help') renderStaticView(options, state.mode);
  localizeDocument(documentRef, browserApi);
}

/** @param {Array<{id: string, customTitle?: string, title?: string}>} feeds */
function feedDisplayTitleMap(feeds) {
  /** @type {Map<string, string>} */
  const titles = new Map();
  for (const feed of feeds) {
    const title = displayTitle(feed);
    if (feed.id && title) titles.set(feed.id, title);
  }
  return titles;
}

/** @param {Document} documentRef */
function syncSidebarToggleCopy(documentRef) {
  const toggle = documentRef.querySelector('.headerbar-start [data-sidebar-toggle]');
  if (!isHtmlElement(toggle)) return;
  const open = Boolean(
    documentRef.querySelector(
      'aside[data-sidebar-region]:not([hidden])[data-open="true"], dialog[data-sidebar-drawer][data-open="true"][data-modal="true"]',
    ),
  );
  const key = open ? 'closeSidebar' : 'openSidebar';
  toggle.dataset.i18nTitle = key;
  const label = toggle.querySelector('.visually-hidden');
  if (isHtmlElement(label)) label.dataset.i18n = key;
}

/**
 * @param {Document} documentRef
 * @param {string} selector
 * @param {boolean} hidden
 */
function setHidden(documentRef, selector, hidden) {
  const element = documentRef.querySelector(selector);
  if (isHtmlElement(element)) element.hidden = hidden;
}

/**
 * @param {Document} documentRef
 * @param {boolean} visible
 */
function syncSearchVisibility(documentRef, visible) {
  setHidden(documentRef, '[data-headerbar-slot="search"]', !visible);
  setHidden(documentRef, '[data-reader-search]', !visible);
}

/**
 * @param {import('./app-shell.js').AppShellOptions} options
 * @param {boolean} readerActive
 */
function syncHeaderbarResponsiveControls(options, readerActive) {
  const viewOptionsButton = options.documentRef.querySelector('[data-view-options-button]');
  if (isButtonElement(viewOptionsButton)) viewOptionsButton.disabled = !readerActive;
  for (const button of options.documentRef.querySelectorAll('button[data-article-filter], button[data-article-view]')) {
    if (isButtonElement(button)) button.disabled = !readerActive;
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
 * @returns {value is HTMLButtonElement}
 */
function isButtonElement(value) {
  return isHtmlElement(value) && 'disabled' in value;
}
