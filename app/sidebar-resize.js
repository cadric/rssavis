// @ts-check

const DEFAULT_SIDEBAR_WIDTH = 278;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_STORED_SIDEBAR_WIDTH = 1200;
const SIDEBAR_WIDTH_STEP = 16;

/**
 * @typedef {Awaited<ReturnType<ReturnType<typeof import('./state-store.js').createUiStateStore>['read']>>} UiStateRecord
 * @typedef {object} SidebarResizerOptions
 * @property {Document} documentRef
 * @property {Window} windowRef
 * @property {{getState(): UiStateRecord | null, writeState(patch: Partial<UiStateRecord>): Promise<UiStateRecord>}} actions
 * @property {(operation: string, task: () => unknown) => void} runAsync
 */

/**
 * @param {SidebarResizerOptions} options
 */
export function createSidebarResizer(options) {
  const resizers = [...options.documentRef.querySelectorAll('[data-sidebar-resizer]')].filter(isHtmlElement);
  if (resizers.length === 0) return nullSidebarResizer();
  let currentWidth = applyWidth(options, resizers, options.actions.getState()?.sidebarWidthPx ?? DEFAULT_SIDEBAR_WIDTH);

  const persistCurrentWidth = () => options.actions.writeState({ sidebarWidthPx: currentWidth });

  options.windowRef.addEventListener('resize', () => {
    currentWidth = applyWidth(options, resizers, currentWidth);
  });

  return {
    /**
     * @param {PointerEvent} event
     */
    handlePointerDown(event) {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = isHtmlElement(event.currentTarget) ? event.currentTarget : resizers[0];
      const startX = event.clientX;
      const startWidth = currentWidth;
      const appShell = options.documentRef.querySelector('[data-app-shell]');
      if ('setPointerCapture' in handle) handle.setPointerCapture(event.pointerId);
      // Freeze the A4 width transitions for the duration of the live drag so the grey edge
      // tracks the pointer instantly instead of easing behind the accent handle.
      if (appShell) appShell.setAttribute('data-sidebar-resizing', '');

      /** @param {PointerEvent} moveEvent */
      const handlePointerMove = (moveEvent) => {
        currentWidth = applyWidth(options, resizers, startWidth + moveEvent.clientX - startX);
      };
      /** @param {PointerEvent} endEvent */
      const handlePointerEnd = (endEvent) => {
        options.windowRef.removeEventListener('pointermove', handlePointerMove);
        options.windowRef.removeEventListener('pointerup', handlePointerEnd);
        options.windowRef.removeEventListener('pointercancel', handlePointerEnd);
        if ('releasePointerCapture' in handle) handle.releasePointerCapture(endEvent.pointerId);
        if (appShell) appShell.removeAttribute('data-sidebar-resizing');
        options.runAsync('sidebar-resize', persistCurrentWidth);
      };
      options.windowRef.addEventListener('pointermove', handlePointerMove);
      options.windowRef.addEventListener('pointerup', handlePointerEnd);
      options.windowRef.addEventListener('pointercancel', handlePointerEnd);
    },
    /**
     * @param {KeyboardEvent} event
     */
    async handleKeydown(event) {
      const next = nextKeyboardWidth(event.key, currentWidth, liveMax(options.windowRef));
      if (next == null) return;
      event.preventDefault();
      currentWidth = applyWidth(options, resizers, next);
      await persistCurrentWidth();
    },
    /**
     * @param {number} width
     */
    applyWidth(width) {
      currentWidth = applyWidth(options, resizers, width);
      return currentWidth;
    },
  };
}

/**
 * @param {Window} windowRef
 */
function liveMax(windowRef) {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_STORED_SIDEBAR_WIDTH, Math.round(windowRef.innerWidth * 0.4)));
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function clampWidth(value, max) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_SIDEBAR_WIDTH;
  return Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, numeric));
}

/**
 * @param {SidebarResizerOptions} options
 * @param {HTMLElement[]} resizers
 * @param {unknown} width
 */
function applyWidth(options, resizers, width) {
  const max = liveMax(options.windowRef);
  const clamped = clampWidth(width, max);
  options.documentRef.documentElement.style.setProperty('--rs-sidebar-width', `${clamped}px`);
  for (const resizer of resizers) {
    resizer.setAttribute('aria-valuemin', String(MIN_SIDEBAR_WIDTH));
    resizer.setAttribute('aria-valuemax', String(max));
    resizer.setAttribute('aria-valuenow', String(clamped));
  }
  return clamped;
}

/**
 * @param {string} key
 * @param {number} current
 * @param {number} max
 */
function nextKeyboardWidth(key, current, max) {
  if (key === 'ArrowLeft') return current - SIDEBAR_WIDTH_STEP;
  if (key === 'ArrowRight') return current + SIDEBAR_WIDTH_STEP;
  if (key === 'Home') return MIN_SIDEBAR_WIDTH;
  if (key === 'End') return max;
  return null;
}

function nullSidebarResizer() {
  return {
    /** @param {number} width */
    applyWidth: (width) => width,
    /** @param {KeyboardEvent} _event */
    handleKeydown: async (_event) => {},
    /** @param {PointerEvent} _event */
    handlePointerDown: (_event) => {},
  };
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}
