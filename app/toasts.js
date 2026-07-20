// @ts-check

import { cloneTemplate } from './templates.js';

const TOAST_AUTO_DISMISS_MS = 5000;
/** @type {WeakMap<Document, ToastState>} */
const toastStates = new WeakMap();

/**
 * @typedef {object} ToastActionInput
 * @property {string} message
 * @property {string} [actionLabel]
 * @property {() => void} [onAction]
 * @property {ToastDuration} [duration]
 * @typedef {{mode: 'auto', milliseconds?: number}} ToastDuration
 * @typedef {{mode: 'auto', milliseconds: number}} NormalizedToastDuration
 * @typedef {object} ToastItem
 * @property {string} message
 * @property {string} actionLabel
 * @property {(() => void) | null} onAction
 * @property {NormalizedToastDuration} duration
 * @typedef {{current: ToastItem | null, queue: ToastItem[], timer: ReturnType<Window['setTimeout']> | null, remainingMs: number, startedAtMs: number | null, pausedReasons: Set<'pointer' | 'focus'>}} ToastState
 */

/**
 * @param {Document} documentRef
 * @param {string | ToastActionInput} message
 */
export function showToast(documentRef, message) {
  const item = normalizeToast(message);
  announceStatus(documentRef, item.message);
  const state = toastState(documentRef);
  state.queue.push(item);
  if (!state.current) showNextToast(documentRef, state);
}

/**
 * @param {Document} documentRef
 * @param {string} message
 */
export function announceStatus(documentRef, message) {
  const status = documentRef.querySelector('[data-rssavis-status]');
  if (isHtmlElement(documentRef, status) && status.textContent !== message) status.textContent = message;
}

/**
 * @param {Document} documentRef
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLElement;
}

/**
 * @param {string | ToastActionInput} input
 * @returns {ToastItem}
 */
function normalizeToast(input) {
  if (typeof input === 'string') {
    return {
      actionLabel: '',
      duration: { mode: 'auto', milliseconds: TOAST_AUTO_DISMISS_MS },
      message: input,
      onAction: null,
    };
  }
  return {
    actionLabel: input.actionLabel ?? '',
    duration: normalizeDuration(input.duration),
    message: input.message,
    onAction: input.onAction ?? null,
  };
}

/**
 * @param {ToastDuration | undefined} duration
 * @returns {NormalizedToastDuration}
 */
function normalizeDuration(duration) {
  const milliseconds = duration?.mode === 'auto' ? duration.milliseconds : undefined;
  return {
    mode: 'auto',
    milliseconds:
      typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds > 0
        ? milliseconds
        : TOAST_AUTO_DISMISS_MS,
  };
}

/**
 * @param {Document} documentRef
 */
function toastState(documentRef) {
  const existing = toastStates.get(documentRef);
  if (existing) return existing;
  /** @type {ToastState} */
  const state = {
    current: null,
    pausedReasons: new Set(),
    queue: [],
    remainingMs: 0,
    startedAtMs: null,
    timer: null,
  };
  toastStates.set(documentRef, state);
  return state;
}

/**
 * @param {Document} documentRef
 * @param {ToastState} state
 */
function showNextToast(documentRef, state) {
  resetToastClock(documentRef, state);
  const stack = documentRef.querySelector('[data-toast-stack]');
  if (!isHtmlElement(documentRef, stack)) return;
  const item = state.queue.shift() ?? null;
  state.current = item;
  if (!item) {
    stack.replaceChildren();
    return;
  }
  const toast = cloneTemplate(documentRef, 'data-toast-template', '.toast');
  renderToast(documentRef, toast, item, () => dismissCurrentToast(documentRef));
  bindToastPauses(documentRef, toast, state);
  stack.replaceChildren(toast);
  state.remainingMs = item.duration.milliseconds;
  scheduleToastTimer(documentRef, state);
}

/**
 * @param {Document} documentRef
 */
function dismissCurrentToast(documentRef) {
  const state = toastState(documentRef);
  state.current = null;
  showNextToast(documentRef, state);
}

/**
 * @param {Document} documentRef
 * @param {ToastState} state
 */
function clearToastTimer(documentRef, state) {
  if (state.timer === null) return;
  requireView(documentRef).clearTimeout(state.timer);
  state.timer = null;
}

/**
 * @param {Document} documentRef
 * @param {ToastState} state
 */
function resetToastClock(documentRef, state) {
  clearToastTimer(documentRef, state);
  state.pausedReasons.clear();
  state.remainingMs = 0;
  state.startedAtMs = null;
}

/**
 * @param {Document} documentRef
 * @param {ToastState} state
 */
function scheduleToastTimer(documentRef, state) {
  if (!state.current || state.pausedReasons.size > 0) return;
  state.startedAtMs = Date.now();
  state.timer = requireView(documentRef).setTimeout(() => dismissCurrentToast(documentRef), state.remainingMs);
}

/**
 * @param {Document} documentRef
 * @param {ToastState} state
 * @param {'pointer' | 'focus'} reason
 */
function pauseToast(documentRef, state, reason) {
  if (!state.current || state.pausedReasons.has(reason)) return;
  if (state.pausedReasons.size === 0 && state.startedAtMs !== null) {
    state.remainingMs = Math.max(0, state.remainingMs - (Date.now() - state.startedAtMs));
    clearToastTimer(documentRef, state);
    state.startedAtMs = null;
  }
  state.pausedReasons.add(reason);
}

/**
 * @param {Document} documentRef
 * @param {ToastState} state
 * @param {'pointer' | 'focus'} reason
 */
function resumeToast(documentRef, state, reason) {
  state.pausedReasons.delete(reason);
  if (state.pausedReasons.size > 0 || !state.current) return;
  if (state.remainingMs <= 0) dismissCurrentToast(documentRef);
  else scheduleToastTimer(documentRef, state);
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} toast
 * @param {ToastState} state
 */
function bindToastPauses(documentRef, toast, state) {
  toast.addEventListener('pointerenter', () => pauseToast(documentRef, state, 'pointer'));
  toast.addEventListener('pointerleave', () => resumeToast(documentRef, state, 'pointer'));
  toast.addEventListener('focusin', () => pauseToast(documentRef, state, 'focus'));
  toast.addEventListener('focusout', (event) => {
    const related = event.relatedTarget;
    if (related instanceof requireView(documentRef).Node && toast.contains(related)) return;
    resumeToast(documentRef, state, 'focus');
  });
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} toast
 * @param {ToastItem} item
 * @param {() => void} dismiss
 */
function renderToast(documentRef, toast, item, dismiss) {
  const message = toast.querySelector('[data-toast-message]');
  if (isHtmlElement(documentRef, message)) message.textContent = item.message;
  const label = toastDismissLabel(documentRef);
  const dismissButton = toast.querySelector('[data-toast-dismiss]');
  if (isHtmlElement(documentRef, dismissButton)) {
    dismissButton.setAttribute('aria-label', label);
    dismissButton.setAttribute('title', label);
    const dismissText = dismissButton.querySelector('[data-toast-dismiss-text]');
    if (isHtmlElement(documentRef, dismissText)) dismissText.textContent = label;
    dismissButton.addEventListener('click', dismiss);
  }
  const action = toast.querySelector('[data-toast-action]');
  if (!isHtmlElement(documentRef, action)) return;
  if (!item.actionLabel || !item.onAction) {
    action.hidden = true;
    return;
  }
  action.hidden = false;
  action.textContent = item.actionLabel;
  action.addEventListener('click', () => {
    try {
      item.onAction?.();
    } finally {
      dismiss();
    }
  });
}

/**
 * @param {Document} documentRef
 */
function toastDismissLabel(documentRef) {
  const label = documentRef.querySelector('[data-toast-dismiss-label]')?.textContent?.trim();
  if (!label) throw new Error('Missing localized toast dismiss label.');
  return label;
}

/**
 * @param {Document} documentRef
 */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}
