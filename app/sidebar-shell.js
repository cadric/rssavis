// @ts-check
import { setAttributeIfChanged, setHiddenIfChanged } from './keyed-dom.js';
/**
 * @typedef {object} SidebarActions
 * @property {() => {mode: string, readerSidebarOpen: boolean, settingsSidebarOpen: boolean} | null} getState
 * @property {(patch: {readerSidebarOpen?: boolean, settingsSidebarOpen?: boolean}) => Promise<{mode: string, readerSidebarOpen: boolean, settingsSidebarOpen: boolean}>} writeState
 */

const SIDEBAR_MODAL_QUERY = '(max-width: 899px)';
const SIDEBAR_CLOSE_TIMEOUT_MS = 300;
const SIDEBAR_MODES = /** @type {const} */ (['reader', 'settings']);
/** @type {WeakMap<HTMLDialogElement, Set<() => void>>} */
const sidebarCloseCallbacks = new WeakMap();
const sidebarFocusReturn = new WeakMap();

/**
 * @param {Document} documentRef
 * @param {SidebarActions} actions
 * @param {(query: string) => MediaQueryList} matchMedia
 * @param {EventTarget | null} [trigger]
 */
export async function toggleCurrentSidebar(documentRef, actions, matchMedia, trigger = null) {
  const current = actions.getState();
  if (!current || (current.mode !== 'settings' && current.mode !== 'reader')) return;
  const dialog = sidebarDialogForMode(documentRef, current.mode);
  if (isNarrowSidebar(matchMedia)) {
    if (dialog?.open && dialog.dataset.modal === 'true') {
      await closeCurrentSidebar(documentRef, actions);
      return;
    }
    const patch = current.mode === 'settings' ? { settingsSidebarOpen: true } : { readerSidebarOpen: true };
    await actions.writeState(patch);
    const opener = isHtmlElement(trigger) ? trigger : focusToolbarSidebarToggle(documentRef, false);
    openSidebarModal(documentRef, current.mode, opener);
    return;
  }
  const nextOpen = current.mode === 'settings' ? !current.settingsSidebarOpen : !current.readerSidebarOpen;
  const next = await actions.writeState(patchForMode(current.mode, nextOpen));
  if ((next.mode === 'settings' && !next.settingsSidebarOpen) || (next.mode === 'reader' && !next.readerSidebarOpen)) {
    focusToolbarSidebarToggle(documentRef);
  }
}

/**
 * @param {Document} documentRef
 * @param {SidebarActions} actions
 * @param {{restoreFocus?: boolean}} [options]
 */
export async function closeCurrentSidebar(documentRef, actions, options = {}) {
  const current = actions.getState();
  if (!current || (current.mode !== 'settings' && current.mode !== 'reader')) return;
  const restoreFocus = options.restoreFocus !== false;
  const patch = current.mode === 'settings' ? { settingsSidebarOpen: false } : { readerSidebarOpen: false };
  await actions.writeState(patch);
  if (!restoreFocus) {
    await new Promise((resolve) =>
      closeSidebarDialog(documentRef, current.mode, () => resolve(undefined)) ? null : resolve(undefined),
    );
    return;
  }
  if (!closeSidebarDialog(documentRef, current.mode, () => focusToolbarSidebarToggle(documentRef))) {
    focusToolbarSidebarToggle(documentRef);
  }
}

/**
 * @param {Document} documentRef
 * @param {{mode: string, readerSidebarOpen: boolean, settingsSidebarOpen: boolean}} state
 * @param {(query: string) => MediaQueryList} matchMedia
 */
export function syncSidebarDialogs(documentRef, state, matchMedia) {
  const appShell = documentRef.querySelector('[data-app-shell]');
  if (isHtmlElement(appShell)) setAttributeIfChanged(appShell, 'data-sidebar-open', String(activeSidebarOpen(state)));
  const narrow = isNarrowSidebar(matchMedia);
  for (const mode of SIDEBAR_MODES) {
    const region = sidebarRegionForMode(documentRef, mode);
    const dialog = sidebarDialogForMode(documentRef, mode);
    const content = sidebarContentForMode(documentRef, mode);
    if (!region || !dialog || !content) continue;
    const routeActive = state.mode === mode;
    const shouldOpen = routeActive && activeSidebarOpen(state);
    setAttributeIfChanged(region, 'data-open', String(shouldOpen));
    if (!routeActive) {
      setHiddenIfChanged(region, true);
      closeDialogWithoutFocus(dialog);
      setHiddenIfChanged(dialog, true);
      if (content.parentElement !== region) region.append(content);
      continue;
    }
    if (narrow) {
      setHiddenIfChanged(region, true);
      setHiddenIfChanged(dialog, false);
      if (content.parentElement !== dialog) dialog.append(content);
      if (!shouldOpen || dialog.dataset.modal !== 'true') {
        closeDialogWithoutFocus(dialog);
      }
      continue;
    }
    setHiddenIfChanged(region, false);
    if (content.parentElement !== region) region.append(content);
    closeDialogWithoutFocus(dialog);
    setHiddenIfChanged(dialog, true);
  }
}

/**
 * @param {Document} documentRef
 * @param {SidebarActions} actions
 * @param {(query: string) => MediaQueryList} matchMedia
 * @param {(operation: string, task: () => unknown) => void} runEvent
 */
export function setupSidebarDialogEvents(documentRef, actions, matchMedia, runEvent) {
  for (const dialog of documentRef.querySelectorAll('[data-sidebar-drawer]')) {
    if (!isDialogElement(documentRef, dialog)) continue;
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog || !isNarrowSidebar(matchMedia)) return;
      runEvent('sidebar-backdrop-close', () => closeCurrentSidebar(documentRef, actions));
    });
    dialog.addEventListener('close', () => {
      if (dialog.dataset.modal !== 'true') return;
      setAttributeIfChanged(dialog, 'data-modal', 'false');
      runEvent('sidebar-native-close', async () => {
        const current = actions.getState();
        if (current && current.mode === modeForSidebar(dialog) && activeSidebarOpen(current)) {
          await actions.writeState(patchForMode(current.mode, false));
        }
        focusSidebarReturn(documentRef, dialog);
      });
    });
  }
  const media = matchMedia(SIDEBAR_MODAL_QUERY);
  media.addEventListener?.('change', (event) => {
    if (!('matches' in event)) return;
    runEvent('sidebar-responsive-sync', () => syncCurrentSidebarPresentation(documentRef, actions, matchMedia));
  });
}

/**
 * @param {MouseEvent} event
 */
export function isSidebarNavigationClick(event) {
  const target = isHtmlElement(event.target) ? event.target : null;
  if (!target) return false;
  const readerScope = target.closest('[data-reader-sidebar] [data-scope-key]');
  return Boolean(
    (readerScope && !readerScope.hasAttribute('data-category-toggle')) ||
    target.closest('[data-settings-sidebar] [data-settings-section-link]') ||
    target.closest('[data-settings-sidebar] [data-route-link]'),
  );
}

/**
 * @param {Document} documentRef
 */
export function focusActiveMain(documentRef) {
  const main = documentRef.querySelector('main:not([hidden])');
  if (isHtmlElement(main) && 'focus' in main && typeof main.focus === 'function') main.focus({ focusVisible: false });
}

/**
 * @param {Document} documentRef
 * @param {boolean} focus
 */
function focusToolbarSidebarToggle(documentRef, focus = true) {
  const toggle = documentRef.querySelector('.headerbar-start [data-sidebar-toggle]');
  if (focus && isHtmlElement(toggle) && 'focus' in toggle && typeof toggle.focus === 'function') toggle.focus();
  return isHtmlElement(toggle) ? toggle : null;
}

/**
 * @param {Document} documentRef
 * @param {'reader' | 'settings'} mode
 * @param {HTMLElement | null} opener
 */
function openSidebarModal(documentRef, mode, opener) {
  const dialog = sidebarDialogForMode(documentRef, mode);
  if (!dialog) return;
  if (opener) sidebarFocusReturn.set(dialog, opener);
  setHiddenIfChanged(dialog, false);
  if (dialog.open && dialog.dataset.modal !== 'true') closeDialogWithoutFocus(dialog);
  setAttributeIfChanged(dialog, 'data-modal', 'true');
  setAttributeIfChanged(dialog, 'data-open', 'true');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  focusInitialSidebarControl(dialog);
}

/**
 * @param {Document} documentRef
 * @param {SidebarActions} actions
 * @param {(query: string) => MediaQueryList} matchMedia
 */
function syncCurrentSidebarPresentation(documentRef, actions, matchMedia) {
  const current = actions.getState();
  if (!current || (current.mode !== 'settings' && current.mode !== 'reader')) return;
  syncSidebarDialogs(documentRef, current, matchMedia);
}

/**
 * @param {Document} documentRef
 * @param {string} mode
 * @param {(() => void) | null} [afterClose]
 */
function closeSidebarDialog(documentRef, mode, afterClose = null) {
  const dialog = sidebarDialogForMode(documentRef, mode);
  if (!dialog) return false;
  closeDialogWithoutFocus(dialog, afterClose);
  return true;
}

/**
 * @param {HTMLDialogElement} dialog
 * @param {(() => void) | null} [afterClose]
 */
function closeDialogWithoutFocus(dialog, afterClose = null) {
  setAttributeIfChanged(dialog, 'data-open', 'false');
  addSidebarCloseCallback(dialog, afterClose);
  if (dialog.dataset.closing === 'true') return;
  if (!dialog.open) {
    dialog.removeAttribute('open');
    setAttributeIfChanged(dialog, 'data-modal', 'false');
    delete dialog.dataset.closing;
    runSidebarCloseCallbacks(dialog);
    return;
  }
  const animated = shouldDelaySidebarClose(dialog);
  if (animated) {
    setAttributeIfChanged(dialog, 'data-closing', 'true');
    finishSidebarCloseAfterTransition(dialog);
    return;
  }
  setAttributeIfChanged(dialog, 'data-modal', 'false');
  finishSidebarClose(dialog);
}

/** @param {HTMLDialogElement} dialog @param {(() => void) | null} callback */
function addSidebarCloseCallback(dialog, callback) {
  if (!callback) return;
  const callbacks = sidebarCloseCallbacks.get(dialog) ?? new Set();
  callbacks.add(callback);
  sidebarCloseCallbacks.set(dialog, callbacks);
}

/** @param {HTMLDialogElement} dialog */
function runSidebarCloseCallbacks(dialog) {
  const callbacks = sidebarCloseCallbacks.get(dialog);
  if (!callbacks) return;
  sidebarCloseCallbacks.delete(dialog);
  for (const callback of callbacks) callback();
}

/** @param {HTMLDialogElement} dialog */
function shouldDelaySidebarClose(dialog) {
  if (dialog.dataset.modal !== 'true') return false;
  const matchMedia = dialog.ownerDocument.defaultView?.matchMedia;
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(prefers-reduced-motion: no-preference)').matches;
}

/** @param {HTMLDialogElement} dialog */
function finishSidebarCloseAfterTransition(dialog) {
  const view = requireView(dialog.ownerDocument);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    view.clearTimeout(timeout);
    dialog.removeEventListener('transitionend', onTransitionEnd);
    finishSidebarClose(dialog);
  };
  /** @type {(event: TransitionEvent) => void} */
  const onTransitionEnd = (event) => {
    if (event.target === dialog && event.propertyName === 'transform') finish();
  };
  const timeout = view.setTimeout(finish, SIDEBAR_CLOSE_TIMEOUT_MS);
  dialog.addEventListener('transitionend', onTransitionEnd);
}

/** @param {HTMLDialogElement} dialog */
function finishSidebarClose(dialog) {
  delete dialog.dataset.closing;
  setAttributeIfChanged(dialog, 'data-modal', 'false');
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  runSidebarCloseCallbacks(dialog);
}

/**
 * @param {HTMLDialogElement} dialog
 */
function focusInitialSidebarControl(dialog) {
  const target =
    dialog.querySelector('[data-scope-key][aria-current="page"], [data-settings-section-link][aria-current="page"]') ??
    dialog.querySelector('h2');
  if (isHtmlElement(target) && 'focus' in target && typeof target.focus === 'function') target.focus();
}

/**
 * @param {Document} documentRef
 * @param {HTMLDialogElement} dialog
 */
function focusSidebarReturn(documentRef, dialog) {
  const target = sidebarFocusReturn.get(dialog) ?? focusToolbarSidebarToggle(documentRef, false);
  if (isHtmlElement(target) && 'focus' in target && typeof target.focus === 'function') target.focus();
}

/**
 * @param {{mode: string, readerSidebarOpen: boolean, settingsSidebarOpen: boolean}} state
 */
function activeSidebarOpen(state) {
  if (state.mode === 'settings') return state.settingsSidebarOpen;
  if (state.mode === 'reader') return state.readerSidebarOpen;
  return false;
}

/**
 * @param {string} mode
 * @param {boolean} open
 */
function patchForMode(mode, open) {
  return mode === 'settings' ? { settingsSidebarOpen: open } : { readerSidebarOpen: open };
}

/**
 * @param {Document} documentRef
 * @param {string} mode
 * @returns {HTMLDialogElement | null}
 */
function sidebarDialogForMode(documentRef, mode) {
  const selector =
    mode === 'settings'
      ? 'dialog[data-sidebar-drawer][data-settings-sidebar]'
      : 'dialog[data-sidebar-drawer][data-reader-sidebar]';
  const dialog = documentRef.querySelector(selector);
  return isDialogElement(documentRef, dialog) ? dialog : null;
}

/**
 * @param {Document} documentRef
 * @param {string} mode
 * @returns {HTMLElement | null}
 */
function sidebarRegionForMode(documentRef, mode) {
  const selector =
    mode === 'settings'
      ? 'aside[data-sidebar-region][data-mode="settings"]'
      : 'aside[data-sidebar-region][data-mode="reader"]';
  const region = documentRef.querySelector(selector);
  return isHtmlElement(region) ? region : null;
}

/**
 * @param {Document} documentRef
 * @param {string} mode
 * @returns {HTMLElement | null}
 */
function sidebarContentForMode(documentRef, mode) {
  const selector =
    mode === 'settings' ? '[data-sidebar-content][data-mode="settings"]' : '[data-sidebar-content][data-mode="reader"]';
  const content = documentRef.querySelector(selector);
  return isHtmlElement(content) ? content : null;
}

/**
 * @param {HTMLDialogElement} dialog
 * @returns {'reader' | 'settings'}
 */
function modeForSidebar(dialog) {
  return dialog.hasAttribute('data-settings-sidebar') ? 'settings' : 'reader';
}

/**
 * @param {(query: string) => MediaQueryList} matchMedia
 */
function isNarrowSidebar(matchMedia) {
  return matchMedia(SIDEBAR_MODAL_QUERY).matches;
}

/**
 * @param {Document} documentRef
 * @param {unknown} value
 * @returns {value is HTMLDialogElement}
 */
function isDialogElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLDialogElement;
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}

/** @param {Document} documentRef */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}
