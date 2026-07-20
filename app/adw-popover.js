// @ts-check

const POPOVER_ARROW_SIZE_PX = 10;

/**
 * @typedef {object} AdwPopoverOptions
 * @property {HTMLElement} popover
 * @property {string} anchorAttribute
 * @property {(trigger: HTMLElement, context?: unknown) => void} [onOpen]
 * @property {() => void} [onClose]
 * @property {boolean} [focusFirst]
 */

/**
 * @typedef {object} AdwPopoverController
 * @property {(trigger: HTMLElement, context?: unknown) => boolean} openForTrigger
 * @property {(trigger: HTMLElement, context?: unknown) => void} toggleForTrigger
 * @property {(closeOptions?: {restoreFocus?: boolean}) => void} close
 * @property {() => boolean} isOpen
 * @property {() => HTMLElement | null} getActiveTrigger
 */

/**
 * @param {Document} documentRef
 * @param {AdwPopoverOptions} options
 * @returns {AdwPopoverController}
 */
export function createAdwPopover(documentRef, options) {
  const home = {
    nextSibling: options.popover.nextSibling,
    parent: options.popover.parentNode,
  };
  /** @type {HTMLElement | null} */
  let activeTrigger = null;
  let justDismissed = false;

  /**
   * @param {HTMLElement} trigger
   * @param {unknown} [context]
   */
  const openForTrigger = (trigger, context) => {
    if (activeTrigger && activeTrigger !== trigger) activeTrigger.removeAttribute(options.anchorAttribute);
    placePopoverForTrigger(options.popover, trigger, home);
    activeTrigger = trigger;
    trigger.setAttribute(options.anchorAttribute, 'true');
    options.popover.hidden = false;
    if (typeof options.popover.showPopover === 'function' && !matchesPopoverOpen(options.popover)) {
      options.popover.showPopover();
    }
    options.popover.dataset.open = 'true';
    justDismissed = false;
    setAppShellPopoverOpen(documentRef, true);
    syncPlacement(options.popover, trigger);
    syncArrowInlineEnd(options.popover, trigger);
    options.onOpen?.(trigger, context);
    if (options.focusFirst !== false) focusFirstControl(options.popover);
    return true;
  };

  /** @param {{restoreFocus?: boolean}} [closeOptions] */
  const close = (closeOptions = {}) => {
    if (!isOpen() && !activeTrigger) return;
    const trigger = activeTrigger;
    if (typeof options.popover.hidePopover === 'function' && matchesPopoverOpen(options.popover)) {
      options.popover.hidePopover();
    }
    options.popover.hidden = true;
    options.popover.dataset.open = 'false';
    setAppShellPopoverOpen(documentRef, false);
    delete options.popover.dataset.menuPlacement;
    options.onClose?.();
    if (trigger) trigger.removeAttribute(options.anchorAttribute);
    activeTrigger = null;
    restorePopoverHome(options.popover, home);
    if (closeOptions.restoreFocus !== false) trigger?.focus();
  };

  /**
   * @param {HTMLElement} trigger
   * @param {unknown} [context]
   */
  const toggleForTrigger = (trigger, context) => {
    if (isOpen() && activeTrigger === trigger) {
      close();
      return;
    }
    openForTrigger(trigger, context);
  };

  const isOpen = () => options.popover.dataset.open === 'true';
  const getActiveTrigger = () => activeTrigger;

  /** @param {KeyboardEvent} event */
  const leavesPopover = (event) => {
    const controls = focusableControls(options.popover);
    if (controls.length === 0) return false;
    const active = documentRef.activeElement;
    return event.shiftKey ? active === controls[0] : active === controls[controls.length - 1];
  };

  /** @param {Event} event */
  const isOutsideDismiss = (event) => {
    if (!isOpen()) return false;
    const target = event.target;
    if (!isNode(target)) return false;
    return !(options.popover.contains(target) || activeTrigger?.contains(target));
  };

  options.popover.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab' && leavesPopover(event)) {
      event.preventDefault();
      close({ restoreFocus: true });
    }
  });
  // GTK-grab: a real pointer press behind an open popover dismisses it and is swallowed
  // (stopPropagation/preventDefault) so the background never activates; the trailing click of
  // that same press is de-duplicated via justDismissed. A lone click with no preceding
  // pointerdown (synthetic only — real clicks always follow a pointerdown) closes without
  // swallowing, so sibling triggers can still retarget the shared popover.
  documentRef.addEventListener(
    'pointerdown',
    (event) => {
      if (!isOutsideDismiss(event)) return;
      close();
      event.stopPropagation();
      event.preventDefault();
      justDismissed = true;
    },
    true,
  );
  documentRef.addEventListener(
    'click',
    (event) => {
      if (justDismissed) {
        justDismissed = false;
        event.stopPropagation();
        event.preventDefault();
        return;
      }
      if (isOutsideDismiss(event)) close();
    },
    true,
  );

  return { close, getActiveTrigger, isOpen, openForTrigger, toggleForTrigger };
}

/**
 * Keep a popover descended from an open dialog whose modal inert subtree contains its trigger.
 * @param {HTMLElement} popover
 * @param {HTMLElement} trigger
 * @param {{nextSibling: ChildNode | null, parent: ParentNode | null}} home
 */
function placePopoverForTrigger(popover, trigger, home) {
  const dialog = trigger.closest('dialog[open]');
  const parent = dialog ?? home.parent;
  if (!parent || popover.parentNode === parent) return;
  moveOpenPopover(popover, () => parent.append(popover));
}

/**
 * @param {HTMLElement} popover
 * @param {{nextSibling: ChildNode | null, parent: ParentNode | null}} home
 */
function restorePopoverHome(popover, home) {
  if (!home.parent || popover.parentNode === home.parent) return;
  moveOpenPopover(popover, () => {
    if (home.nextSibling?.parentNode === home.parent) home.parent?.insertBefore(popover, home.nextSibling);
    else home.parent?.append(popover);
  });
}

/** @param {HTMLElement} popover @param {() => void} move */
function moveOpenPopover(popover, move) {
  const shown = matchesPopoverOpen(popover);
  if (shown && typeof popover.hidePopover === 'function') popover.hidePopover();
  move();
  if (shown && typeof popover.showPopover === 'function') popover.showPopover();
}

/**
 * @param {HTMLElement} popover
 * @returns {Element[]}
 */
function focusableControls(popover) {
  return [...popover.querySelectorAll('button, input, select, textarea, a[href]')].filter(isFocusableControl);
}

/**
 * @param {HTMLElement} popover
 */
function focusFirstControl(popover) {
  const control = focusableControls(popover)[0];
  if (control instanceof requireView(popover.ownerDocument).HTMLElement) control.focus();
}

/**
 * @param {Document} documentRef
 * @param {boolean} open
 */
function setAppShellPopoverOpen(documentRef, open) {
  const appShell = documentRef.querySelector('[data-app-shell]');
  if (open) appShell?.setAttribute('data-popover-open', 'true');
  else appShell?.removeAttribute('data-popover-open');
}

/**
 * @param {HTMLElement} popover
 * @param {HTMLElement} trigger
 */
function syncPlacement(popover, trigger) {
  const placement = trigger.getAttribute('data-menu-placement');
  if (placement === 'headerbar' || placement === 'sidebar') popover.dataset.menuPlacement = placement;
  else delete popover.dataset.menuPlacement;
}

/**
 * @param {HTMLElement} popover
 * @param {HTMLElement} trigger
 */
function syncArrowInlineEnd(popover, trigger) {
  const popoverRect = popover.getBoundingClientRect();
  const triggerRect = trigger.getBoundingClientRect();
  const width = finiteDimension(popoverRect.width);
  const triggerCenter = triggerRect.left + finiteDimension(triggerRect.width) / 2;
  const inlineEnd = width - (triggerCenter - popoverRect.left) - POPOVER_ARROW_SIZE_PX / 2;
  const clamped = Math.min(Math.max(inlineEnd, 12), Math.max(12, width - 12));
  if (Number.isFinite(clamped)) popover.style.setProperty('--rs-popover-arrow-inline-end', `${roundPixel(clamped)}px`);
}

/**
 * @param {Element} element
 */
function isFocusableControl(element) {
  if (!(element instanceof requireView(element.ownerDocument).HTMLElement)) return false;
  if (element.hidden || element.closest('[hidden], [aria-hidden="true"]')) return false;
  if (element.matches(':disabled, .visually-hidden')) return false;
  const style = requireView(element.ownerDocument).getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/**
 * @param {number} value
 */
function finiteDimension(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * @param {number} value
 */
function roundPixel(value) {
  return Math.round(value * 100) / 100;
}

/**
 * @param {HTMLElement} popover
 */
function matchesPopoverOpen(popover) {
  return popover.matches(':popover-open');
}

/**
 * @param {Document} documentRef
 */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}

/**
 * @param {unknown} value
 * @returns {value is Node}
 */
function isNode(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value;
}
