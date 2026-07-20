// @ts-check

import { setupAddFeedForm } from './dialogs.js';
import { applyState } from './app-render.js';
import {
  scheduleReaderContextActivity,
  setupPrimaryMenu,
  setupShellEvents,
  syncThemeInputs,
} from './app-shell-events.js';
import { createAppI18n } from './i18n.js';
import { SETTINGS_EFFECTS, normalizeSettingsEffects } from '../shared/settings-effects.js';
import { renderShortcutKeys } from './keyboard-shortcuts.js';
import { createReaderController } from './reader-controller.js';
import { emptyArticleState, emptySnapshot } from './reader-state.js';
import { normalizeReaderSettings } from './reader-settings.js';
import { createRouter } from './router.js';
import { openAboutDialog, openShortcutsDialog } from './secondary-dialogs.js';
import { focusActiveMain } from './sidebar-shell.js';
import { createUiStateStore } from './state-store.js';
import { createThemeManager } from './theme-manager.js';
import { createTabIdentity } from './tab-identity.js';
import { announceStatus } from './toasts.js';
import { createViewOptionsMenu } from './view-options-menu.js';

/**
 * @typedef {object} AppShellBrowser
 * @property {{getUILanguage(): string, getMessage(key: string, substitutions?: string | number | Array<string | number>): string, formatDate?(value: number | Date): string, formatNumber?(value: number): string}} i18n
 * @property {{request(permissions: {origins: string[]}): Promise<boolean>}} permissions
 * @property {{sendMessage(message: unknown): Promise<unknown>, getManifest(): {version?: string}, onMessage?: {addListener(listener: (message: unknown) => unknown): void}}} runtime
 * @typedef {object} StorageArea
 * @property {(keys: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @typedef {object} AppShellOptions
 * @property {AppShellBrowser} browserApi
 * @property {Document} documentRef
 * @property {(query: string) => MediaQueryList} matchMedia
 * @property {StorageArea} storageArea
 * @property {Window} windowRef
 * @param {AppShellOptions} options
 */
export function createAppShell(options) {
  const appI18n = createAppI18n({
    browserI18n: options.browserApi.i18n,
    documentRef: options.documentRef,
    storageArea: options.storageArea,
  });
  const shellOptions = { ...options, browserApi: { ...options.browserApi, i18n: appI18n } };
  const stateStore = createUiStateStore(shellOptions.storageArea);
  const themeManager = createThemeManager({
    browserApi: shellOptions.browserApi,
    documentElement: shellOptions.documentRef.documentElement,
    localStorageArea: shellOptions.windowRef.localStorage,
    matchMedia: shellOptions.matchMedia,
  });
  /** @type {{close(options?: {restoreFocus?: boolean}): void, open(): boolean, toggle(): void} | null} */ let primaryMenu =
    null;
  /** @type {ReturnType<typeof createViewOptionsMenu> | null} */
  let viewOptionsMenu = null;
  /** @type {ReturnType<typeof setupShellEvents> | null} */
  let managementController = null;
  /** @type {Awaited<ReturnType<typeof stateStore.read>> | null} */ let state = null;
  let previousMode = '';
  let routeSearchActive = false;
  /** @type {'reader' | 'settings' | 'help'} */
  let pendingRouteMode = 'reader';
  /** @type {'reader' | 'settings'} */
  let routeSearchOrigin = 'reader';
  let snapshot = emptySnapshot();
  let articleState = emptyArticleState();
  const tabIdentity = createTabIdentity({ documentRef: shellOptions.documentRef, i18n: appI18n });
  const syncTabIdentity = () => tabIdentity.update(snapshot.systemStats.main.unreadCount);
  appI18n.subscribe(syncTabIdentity);

  const renderShell = () => {
    if (!state) return;
    const modeChanged = previousMode !== state.mode;
    if (modeChanged) viewOptionsMenu?.close({ restoreFocus: false });
    applyState(shellOptions, state, snapshot, articleState);
    syncTabIdentity();
    if (modeChanged) focusActiveMain(shellOptions.documentRef);
    previousMode = state.mode;
  };
  /**
   * @param {Partial<Awaited<ReturnType<typeof stateStore.read>>>} patch
   * @param {{applyIf?: () => boolean}} [options]
   */
  const writeState = async (patch, options = {}) => {
    const next = await stateStore.write(patch, options);
    if (options.applyIf && !options.applyIf()) return state ?? next;
    state = next;
    renderShell();
    return state;
  };
  /**
   * Commits a query identity and its cached first page in one render.
   * @param {Partial<Awaited<ReturnType<typeof stateStore.read>>>} patch
   * @param {ReturnType<typeof emptyArticleState> | ((state: Awaited<ReturnType<typeof stateStore.read>>) => ReturnType<typeof emptyArticleState>)} nextArticleState
   * @param {{applyIf?: () => boolean}} [options]
   */
  const writeReaderState = async (patch, nextArticleState, options = {}) => {
    const next = await stateStore.write(patch, options);
    if (options.applyIf && !options.applyIf()) return state ?? next;
    const resolvedArticleState = typeof nextArticleState === 'function' ? nextArticleState(next) : nextArticleState;
    state = next;
    articleState = resolvedArticleState;
    renderShell();
    return state;
  };
  /** @param {import('../domain/scopes.js').Scope} scope @param {{scrollTop: number, anchorArticleId?: string}} entry */
  const rememberScroll = async (scope, entry) => {
    state = await stateStore.rememberScroll(scope, entry);
    renderShell();
    return state;
  };
  const readerController = createReaderController({
    getArticleState: () => articleState,
    getSnapshot: () => snapshot,
    getState: () => state,
    isReaderContextAvailable: () => pendingRouteMode === 'reader' && !routeSearchActive,
    options: shellOptions,
    rememberScroll,
    setArticleState: (next) => {
      articleState = next;
      renderShell();
    },
    setSnapshot: (next) => {
      managementController?.prepareSnapshot(next);
      snapshot = next;
      renderShell();
    },
    writeReaderState,
    writeState,
  });
  const router = createRouter({
    windowRef: shellOptions.windowRef,
    onNavigate: async ({ legacyOverlay, mode, search, searchOrigin }) => {
      pendingRouteMode = mode;
      const closeRouteSearch = articleState.searchActive && !search;
      const searchFocusReturn = search ? activeHtmlElement(shellOptions.documentRef) : null;
      if (state?.mode === 'reader' && mode !== 'reader') {
        await readerController.rememberScroll();
      }
      routeSearchActive = search;
      if (search) routeSearchOrigin = searchOrigin === 'settings' ? 'settings' : 'reader';
      await writeState({ mode });
      if (mode === 'settings') await managementController?.refreshActiveSection();
      if (!search && closeRouteSearch) await readerController.closeSearch();
      if (mode === 'reader') {
        if (search) readerController.openSearch(searchFocusReturn);
        await readerController.resumeDeferredWork();
        readerController.restoreScroll();
      }
      if (legacyOverlay === 'about') {
        openAboutDialog({ browserApi: shellOptions.browserApi, documentRef: shellOptions.documentRef });
        shellOptions.windowRef.history.replaceState(null, '', '#/reader');
      } else if (legacyOverlay === 'shortcuts') {
        openShortcutsDialog({ documentRef: shellOptions.documentRef, windowRef: shellOptions.windowRef });
        shellOptions.windowRef.history.replaceState(null, '', '#/reader');
      }
    },
  });
  /**
   * @param {Record<string, unknown>} settings
   */
  const reloadReaderForSettings = async (settings) => {
    await readerController.applyReaderSettings(normalizeReaderSettings(settings));
  };

  return {
    async start() {
      await appI18n.start();
      setupAddFeedForm({ browserApi: shellOptions.browserApi, documentRef: shellOptions.documentRef });
      await themeManager.start();
      state = await stateStore.read();
      renderShortcutKeys(shellOptions.documentRef, shellOptions.windowRef);
      managementController = setupShellEvents(
        shellOptions,
        {
          getSnapshot: () => snapshot,
        },
        themeManager,
        router,
        () => primaryMenu,
        {
          getState: () => state,
          isSearchRoute: () => routeSearchActive,
          onSettingsChanged: async (mutation) => {
            const effects = normalizeSettingsEffects(mutation.effects);
            const settings = mutation.settings;
            if (effects.includes(SETTINGS_EFFECTS.THEME)) {
              themeManager.applySettings(settings);
              syncThemeInputs(shellOptions.documentRef, themeManager.getTheme());
            }
            if (effects.includes(SETTINGS_EFFECTS.LANGUAGE)) {
              await appI18n.setLanguage(settings.language);
              renderShell();
            }
            if (effects.includes(SETTINGS_EFFECTS.READER_SETTINGS)) await reloadReaderForSettings(settings);
          },
          searchReturnMode: () =>
            shellOptions.windowRef.location.hash === '#/search/settings' ? 'settings' : routeSearchOrigin,
          writeState,
        },
        readerController,
      );
      primaryMenu = setupPrimaryMenu(shellOptions.documentRef);
      viewOptionsMenu = createViewOptionsMenu(shellOptions.documentRef);
      await router.start(state.mode);
      scheduleReaderContextActivity(shellOptions);
      syncThemeInputs(shellOptions.documentRef, themeManager.getTheme());
      const readerLoaded = await readerController.reloadReaderData(false);
      await managementController.refreshActiveSection();
      if (readerLoaded && readerController.shouldAnnounceReadyStatus()) {
        announceStatus(shellOptions.documentRef, shellOptions.browserApi.i18n.getMessage('foundationLoaded'));
      }
    },
    /**
     * @param {'reader' | 'settings' | 'help'} mode
     */
    async navigate(mode) {
      await router.navigate(mode);
    },
  };
}

/**
 * @param {Document} documentRef
 */
function activeHtmlElement(documentRef) {
  return isHtmlElement(documentRef.activeElement) ? documentRef.activeElement : null;
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}
