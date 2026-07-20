// @ts-check

import { recordReaderContextActive } from './api-client.js';
import { setupDatabaseRecoveryEvents } from './database-recovery.js';
import { createEventBoundary, reportEventError } from './event-boundary.js';
import { isAppMode } from './app-shell-utils.js';
import { closeDialog, handleKeyboardShortcut, showDialog } from './keyboard-shortcuts.js';
import { createManagementController } from './management-controller.js';
import { bindNewArticlesBannerPointerBehavior } from './new-articles-banner.js';
import { createPrimaryMenu } from './primary-menu.js';
import { openAboutDialog, openShortcutsDialog } from './secondary-dialogs.js';
import { createSidebarResizer } from './sidebar-resize.js';
import {
  closeCurrentSidebar,
  isSidebarNavigationClick,
  setupSidebarDialogEvents,
  toggleCurrentSidebar,
} from './sidebar-shell.js';

/**
 * @typedef {Awaited<ReturnType<ReturnType<typeof import('./state-store.js').createUiStateStore>['read']>>} UiStateRecord
 */

/**
 * @param {import('./app-shell.js').AppShellOptions} options
 * @param {{getSnapshot(): ReturnType<typeof import('./reader-state.js').emptySnapshot>}} snapshotActions
 * @param {ReturnType<typeof import('./theme-manager.js').createThemeManager>} themeManager
 * @param {ReturnType<typeof import('./router.js').createRouter>} router
 * @param {() => ReturnType<typeof setupPrimaryMenu> | null} menuRef
 * @param {{getState(): UiStateRecord | null, isSearchRoute(): boolean, onSettingsChanged(mutation: {settings: Record<string, unknown>, effects: string[]}): Promise<void>, searchReturnMode(): 'reader' | 'settings', writeState(patch: Partial<UiStateRecord>): Promise<UiStateRecord>}} actions
 * @param {ReturnType<typeof import('./reader-controller.js').createReaderController>} readerController
 */
export function setupShellEvents(options, snapshotActions, themeManager, router, menuRef, actions, readerController) {
  bindNewArticlesBannerPointerBehavior(options.documentRef);
  const managementController = createManagementController({
    getSnapshot: snapshotActions.getSnapshot,
    getState: actions.getState,
    options,
    onSettingsChanged: actions.onSettingsChanged,
    runWithRefreshHold: (operation) => readerController.runWithRefreshHold(operation),
    writeState: actions.writeState,
  });
  const runEvent = createEventBoundary(options);
  let visibilityWasHidden = options.documentRef.hidden === true;
  const resizer = createSidebarResizer({
    actions: {
      getState: actions.getState,
      writeState: actions.writeState,
    },
    documentRef: options.documentRef,
    runAsync: runEvent,
    windowRef: options.windowRef,
  });
  for (const resizerElement of options.documentRef.querySelectorAll('[data-sidebar-resizer]')) {
    if (!isHtmlElement(resizerElement)) continue;
    resizerElement.addEventListener('pointerdown', (event) => resizer.handlePointerDown(event));
    resizerElement.addEventListener('keydown', (event) => {
      runEvent('sidebar-resize', () => resizer.handleKeydown(event));
    });
  }
  setupSidebarDialogEvents(options.documentRef, actions, options.matchMedia, runEvent);
  for (const button of options.documentRef.querySelectorAll('[data-sidebar-toggle]')) {
    button.addEventListener('click', (event) => {
      runEvent('sidebar-toggle', () =>
        toggleCurrentSidebar(options.documentRef, actions, options.matchMedia, event.currentTarget),
      );
    });
  }
  options.documentRef.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (managementController.handleKeydown(event)) {
      event.preventDefault();
      return;
    }
    if (
      handleKeyboardShortcut(event, {
        documentRef: options.documentRef,
        getMode: () => actions.getState()?.mode ?? null,
        openPrimaryMenu: () => menuRef()?.open(),
        openShortcutsDialog: () =>
          openShortcutsDialog({ documentRef: options.documentRef, windowRef: options.windowRef }),
        readerController,
        router,
        runAsync: runEvent,
        windowRef: options.windowRef,
      })
    ) {
      return;
    }
    if (event.key !== 'Escape') return;
    if (options.documentRef.querySelector('[data-add-feed-dialog][open]')) return;
    if (focusedModalSidebar(options.documentRef)) {
      event.preventDefault();
      runEvent('escape-close-sidebar', () => closeCurrentSidebar(options.documentRef, actions));
      return;
    }
    if (actions.isSearchRoute() && actions.getState()?.mode === 'reader') {
      event.preventDefault();
      runEvent('escape-search-route', () => router.navigate(actions.searchReturnMode()));
      return;
    }
    if (readerController.handleKeydown(event)) {
      event.preventDefault();
      return;
    }
    runEvent('escape-close-sidebar', () => closeCurrentSidebar(options.documentRef, actions));
  });
  for (const button of options.documentRef.querySelectorAll('[data-add-feed-open]')) {
    button.addEventListener('click', () => showDialog(options.documentRef, '[data-add-feed-dialog]'));
  }
  for (const closeButton of options.documentRef.querySelectorAll('[data-add-feed-close]')) {
    closeButton.addEventListener('click', () => closeDialog(options.documentRef, '[data-add-feed-dialog]'));
  }
  options.documentRef.querySelector('[data-add-feed-dialog]')?.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog(options.documentRef, '[data-add-feed-dialog]');
  });
  for (const button of options.documentRef.querySelectorAll('[data-route-link]')) {
    button.addEventListener('click', () => {
      const route = button.getAttribute('data-route-link');
      if (isAppMode(route)) runEvent('route-link', () => router.navigate(route));
      menuRef()?.close();
    });
  }
  setupThemeInputs(options, themeManager, menuRef, runEvent);
  options.windowRef.addEventListener('focus', () => {
    scheduleReaderContextActivity(options);
  });
  options.documentRef.addEventListener('click', (event) => {
    runEvent('document-click', () =>
      handleDocumentClick(
        event,
        managementController,
        options,
        readerController,
        menuRef,
        router,
        runEvent,
        actions,
        options.matchMedia,
      ),
    );
  });
  options.documentRef.addEventListener('contextmenu', (event) => {
    runEvent('sidebar-feed-contextmenu', () => managementController.handleContextMenu(event));
  });
  options.documentRef.addEventListener('input', (event) => {
    readerController.handleInput(event);
  });
  options.documentRef.addEventListener('change', (event) => {
    runEvent('app-change', async () => {
      await managementController.handleChange(event);
    });
  });
  options.documentRef.addEventListener('submit', (event) => {
    if (readerController.handleSubmit(event)) return;
    runEvent('management-submit', () => managementController.handleSubmit(event));
  });
  for (const type of ['dragstart', 'dragover', 'dragleave', 'drop', 'dragend']) {
    options.documentRef.addEventListener(type, (event) => {
      managementController.handleDrag(/** @type {DragEvent} */ (event));
    });
  }
  options.documentRef.addEventListener('visibilitychange', () => {
    if (options.documentRef.hidden) {
      visibilityWasHidden = true;
      return;
    }
    if (!options.documentRef.hidden) {
      if (!visibilityWasHidden) return;
      visibilityWasHidden = false;
      scheduleReaderContextActivity(options);
      runEvent('visibility-reload', () => readerController.reloadReaderAfterVisibility());
    }
  });
  setupDatabaseRecoveryEvents(options, readerController);
  return managementController;
}

/**
 * @param {import('./app-shell.js').AppShellOptions} options
 */
export function scheduleReaderContextActivity(options) {
  void recordReaderContextActive(options.browserApi).catch((error) =>
    reportEventError(options, error, 'reader-context-activity'),
  );
}

/**
 * @param {Document} documentRef
 */
export function setupPrimaryMenu(documentRef) {
  const triggers = [...documentRef.querySelectorAll('[data-primary-menu-button]')].filter(isHtmlElement);
  if (triggers.length === 0) throw new Error('RSSavis shell node missing: [data-primary-menu-button]');
  const popover = requireHtmlElement(documentRef, '[data-primary-menu]');
  return createPrimaryMenu({ documentRef, popover, triggers });
}

/**
 * @param {Document} documentRef
 * @param {{colorScheme: string}} theme
 */
export function syncThemeInputs(documentRef, theme) {
  for (const input of documentRef.querySelectorAll('[data-color-scheme-input]')) {
    if (isInputElement(input)) input.checked = input.value === theme.colorScheme;
  }
}

/**
 * @param {MouseEvent} event
 * @param {ReturnType<typeof createManagementController>} managementController
 * @param {import('./app-shell.js').AppShellOptions} options
 * @param {ReturnType<typeof import('./reader-controller.js').createReaderController>} readerController
 * @param {() => ReturnType<typeof setupPrimaryMenu> | null} menuRef
 * @param {ReturnType<typeof import('./router.js').createRouter>} router
 * @param {(operation: string, task: () => unknown) => void} runEvent
 * @param {{getState(): UiStateRecord | null, searchReturnMode(): 'reader' | 'settings', writeState(patch: Partial<UiStateRecord>): Promise<UiStateRecord>}} actions
 * @param {(query: string) => MediaQueryList} matchMedia
 */
async function handleDocumentClick(
  event,
  managementController,
  options,
  readerController,
  menuRef,
  router,
  runEvent,
  actions,
  matchMedia,
) {
  const closeSidebarAfterNavigation = isSidebarNavigationClick(event);
  if (handleSearchOpen(event, router, runEvent, actions, matchMedia)) return;
  if (handleSearchClose(event, router, runEvent, actions)) return;
  if (handleMenuAction(event, options, readerController, menuRef, router, runEvent, actions)) return;
  if (await managementController.handleClick(event)) return;
  await readerController.handleClick(event);
  if (closeSidebarAfterNavigation && matchMedia('(max-width: 899px)').matches) {
    const target = isHtmlElement(event.target) ? event.target : null;
    if (target) runEvent('sidebar-navigation-close', () => closeCurrentSidebar(target.ownerDocument, actions));
  }
}

/**
 * Keeps the visible Close action and Escape on the same router-owned return
 * path, including a search opened from Preferences.
 * @param {MouseEvent} event
 * @param {ReturnType<typeof import('./router.js').createRouter>} router
 * @param {(operation: string, task: () => unknown) => void} runEvent
 * @param {{searchReturnMode(): 'reader' | 'settings'}} actions
 */
function handleSearchClose(event, router, runEvent, actions) {
  const target = isHtmlElement(event.target) ? event.target.closest('[data-search-close]') : null;
  if (!isHtmlElement(target)) return false;
  runEvent('reader-search-close', () => router.navigate(actions.searchReturnMode()));
  return true;
}

/**
 * @param {MouseEvent} event
 * @param {ReturnType<typeof import('./router.js').createRouter>} router
 * @param {(operation: string, task: () => unknown) => void} runEvent
 * @param {{getState(): UiStateRecord | null, writeState(patch: Partial<UiStateRecord>): Promise<UiStateRecord>}} actions
 * @param {(query: string) => MediaQueryList} matchMedia
 */
function handleSearchOpen(event, router, runEvent, actions, matchMedia) {
  const target = isHtmlElement(event.target) ? event.target.closest('[data-search-open]') : null;
  if (!isHtmlElement(target)) return false;
  runEvent('sidebar-search', async () => {
    if (matchMedia('(max-width: 899px)').matches) {
      await closeCurrentSidebar(target.ownerDocument, actions, { restoreFocus: false });
    }
    await router.navigateSearch(searchOrigin(actions.getState()?.mode));
  });
  return true;
}

/**
 * @param {MouseEvent} event
 * @param {import('./app-shell.js').AppShellOptions} options
 * @param {ReturnType<typeof import('./reader-controller.js').createReaderController>} readerController
 * @param {() => ReturnType<typeof setupPrimaryMenu> | null} menuRef
 * @param {ReturnType<typeof import('./router.js').createRouter>} router
 * @param {(operation: string, task: () => unknown) => void} runEvent
 * @param {{getState(): UiStateRecord | null}} actions
 */
function handleMenuAction(event, options, readerController, menuRef, router, runEvent, actions) {
  const target = isHtmlElement(event.target) ? event.target.closest('[data-menu-action]') : null;
  if (!isHtmlElement(target)) return false;
  const action = target.getAttribute('data-menu-action');
  if (action === 'search') runEvent('menu-search', () => router.navigateSearch(searchOrigin(actions.getState()?.mode)));
  else if (action === 'settings') runEvent('menu-settings', () => router.navigate('settings'));
  else if (action === 'help') runEvent('menu-help', () => router.navigate('help'));
  else if (action === 'about') {
    closePrimaryMenuForSecondaryDialog(options.documentRef, menuRef, target);
    runEvent('menu-about-dialog', () =>
      openAboutDialog({ browserApi: options.browserApi, documentRef: options.documentRef }),
    );
    return true;
  } else if (action === 'shortcuts') {
    closePrimaryMenuForSecondaryDialog(options.documentRef, menuRef, target);
    runEvent('menu-shortcuts-dialog', () =>
      openShortcutsDialog({ documentRef: options.documentRef, windowRef: options.windowRef }),
    );
    return true;
  } else return false;
  menuRef()?.close();
  return true;
}

/**
 * @param {Document} documentRef
 * @param {() => ReturnType<typeof setupPrimaryMenu> | null} menuRef
 * @param {HTMLElement} action
 */
function closePrimaryMenuForSecondaryDialog(documentRef, menuRef, action) {
  menuRef()?.close();
  if (documentRef.activeElement === action) focusVisiblePrimaryMenuTrigger(documentRef);
}

/** @param {Document} documentRef */
function focusVisiblePrimaryMenuTrigger(documentRef) {
  const trigger =
    [...documentRef.querySelectorAll('[data-primary-menu-button]')]
      .filter(isHtmlElement)
      .find((button) => !button.hidden && !button.closest('[hidden]')) ?? null;
  trigger?.focus();
}

/**
 * @param {string | undefined} mode
 * @returns {'reader' | 'settings'}
 */
function searchOrigin(mode) {
  return mode === 'settings' ? 'settings' : 'reader';
}

/**
 * @param {Document} documentRef
 */
function focusedModalSidebar(documentRef) {
  const active = documentRef.activeElement;
  return isHtmlElement(active) && Boolean(active.closest('dialog[data-sidebar-drawer][data-modal="true"]'));
}

/**
 * @param {import('./app-shell.js').AppShellOptions} options
 * @param {ReturnType<typeof import('./theme-manager.js').createThemeManager>} themeManager
 * @param {() => ReturnType<typeof setupPrimaryMenu> | null} menuRef
 * @param {(operation: string, task: () => unknown) => void} runEvent
 */
function setupThemeInputs(options, themeManager, menuRef, runEvent) {
  for (const input of options.documentRef.querySelectorAll('[data-color-scheme-input]')) {
    input.addEventListener('change', () => {
      const value = input.getAttribute('value');
      if (value === 'system' || value === 'light' || value === 'dark') {
        runEvent('theme-color-scheme', async () => {
          await themeManager.setColorScheme(value);
          syncThemeInputs(options.documentRef, themeManager.getTheme());
        });
      }
    });
  }
}

/**
 * @param {Document} documentRef
 * @param {string} selector
 */
function requireHtmlElement(documentRef, selector) {
  const element = documentRef.querySelector(selector);
  if (isHtmlElement(element)) return element;
  throw new Error(`RSSavis shell node missing: ${selector}`);
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
 * @returns {value is HTMLInputElement}
 */
function isInputElement(value) {
  return isHtmlElement(value) && 'checked' in value && 'value' in value;
}
