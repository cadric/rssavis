// @ts-check

/**
 * Dialog lifecycle conventions for B19-B27 Web-Adwaita surfaces:
 * callers pass already-localized copy, each surface owns a static <dialog>, the
 * cancel response is first in DOM order, destructive dialogs initially focus
 * Cancel, suggested dialogs initially focus the affirmative action, and focus
 * returns to the connected opener when the dialog resolves.
 *
 * B19 exports AlertDialog plus captureOpener. B20 secondary dialogs also reuse
 * trapDialogTab while keeping their own narrow openers.
 *
 * @typedef {object} AlertDialogOptions
 * @property {string} heading
 * @property {string} [body]
 * @property {string} affirmativeLabel
 * @property {string} cancelLabel
 * @property {boolean} [destructive]
 * @property {string} [typedConfirmValue]
 * @property {string} [typedConfirmLabel]
 *
 * @typedef {object} AlertDialogRequest
 * @property {Document} documentRef
 * @property {AlertDialogOptions} options
 * @property {{restore(): void}} opener
 * @property {(result: {confirmed: boolean}) => void} resolve
 * @property {(reason?: unknown) => void} reject
 */

/** @type {AlertDialogRequest[]} */
const queue = [];
let active = false;
let pumpScheduled = false;

/**
 * @param {Document} documentRef
 * @returns {{restore(): void}}
 */
export function captureOpener(documentRef) {
  const activeElement = documentRef.activeElement;
  const opener = isHtmlElement(documentRef, activeElement) ? activeElement : null;
  return {
    restore() {
      if (opener?.isConnected) opener.focus();
    },
  };
}

/**
 * @param {Document} documentRef
 * @param {AlertDialogOptions} options
 * @returns {Promise<{confirmed: boolean}>}
 */
export function openAlertDialog(documentRef, options) {
  return new Promise((resolve, reject) => {
    queue.push({ documentRef, opener: captureOpener(documentRef), options, reject, resolve });
    schedulePump();
  });
}

function schedulePump() {
  if (pumpScheduled) return;
  pumpScheduled = true;
  queueMicrotask(() => {
    pumpScheduled = false;
    pumpDialogQueue();
  });
}

function pumpDialogQueue() {
  if (active) return;
  const request = queue.shift();
  if (!request) return;
  active = true;
  try {
    openQueuedDialog(request);
  } catch (error) {
    active = false;
    request.reject(error);
    schedulePump();
  }
}

/** @param {AlertDialogRequest} request */
function openQueuedDialog(request) {
  const dialog = requiredElement(request.documentRef, '[data-adw-alert-dialog]');
  const heading = requiredElement(request.documentRef, '[data-adw-alert-heading]');
  const body = requiredElement(request.documentRef, '[data-adw-alert-body]');
  const typed = requiredElement(request.documentRef, '[data-adw-alert-typed]');
  const typedLabel = requiredElement(request.documentRef, '[data-adw-alert-typed-label]');
  const typedInput = requiredInput(request.documentRef, '[data-adw-alert-typed-input]');
  const cancel = requiredButton(request.documentRef, '[data-adw-alert-cancel]');
  const affirmative = requiredButton(request.documentRef, '[data-adw-alert-affirmative]');
  const requiresTyped = typeof request.options.typedConfirmValue === 'string';

  heading.textContent = request.options.heading;
  body.textContent = request.options.body ?? '';
  body.hidden = !request.options.body;
  typed.hidden = !requiresTyped;
  typedLabel.textContent = request.options.typedConfirmLabel ?? request.options.heading;
  typedInput.value = '';
  cancel.textContent = request.options.cancelLabel;
  affirmative.textContent = request.options.affirmativeLabel;
  dialog.dataset.dialogVariant = request.options.destructive === true ? 'destructive' : 'suggested';
  affirmative.classList.toggle('destructive', request.options.destructive === true);
  affirmative.classList.toggle('suggested', request.options.destructive !== true);
  syncTypedState(request.options, typedInput, affirmative);

  let resolved = false;
  /** @param {boolean} confirmed */
  const finish = (confirmed) => {
    if (resolved) return;
    resolved = true;
    typedInput.removeEventListener('input', handleInput);
    typedInput.removeEventListener('keydown', handleInputKeydown);
    cancel.removeEventListener('click', handleCancelClick);
    affirmative.removeEventListener('click', handleAffirmativeClick);
    dialog.removeEventListener('cancel', handleCancelEvent);
    dialog.removeEventListener('click', handleBackdropClick);
    dialog.removeEventListener('keydown', handleDialogKeydown);
    closeDialog(dialog);
    request.opener.restore();
    request.resolve({ confirmed });
    active = false;
    schedulePump();
  };
  const handleInput = () => syncTypedState(request.options, typedInput, affirmative);
  /** @param {KeyboardEvent} event */
  const handleInputKeydown = (event) => {
    if (event.key === 'Enter' && !affirmative.disabled) {
      event.preventDefault();
      finish(true);
    }
  };
  const handleCancelClick = () => finish(false);
  const handleAffirmativeClick = () => {
    if (!affirmative.disabled) finish(true);
  };
  /** @param {Event} event */
  const handleCancelEvent = (event) => {
    event.preventDefault();
    finish(false);
  };
  /** @param {MouseEvent} event */
  const handleBackdropClick = (event) => {
    if (event.target === dialog) finish(false);
  };
  /** @param {KeyboardEvent} event */
  const handleDialogKeydown = (event) => trapDialogTab(dialog, event);

  typedInput.addEventListener('input', handleInput);
  typedInput.addEventListener('keydown', handleInputKeydown);
  cancel.addEventListener('click', handleCancelClick);
  affirmative.addEventListener('click', handleAffirmativeClick);
  dialog.addEventListener('cancel', handleCancelEvent);
  dialog.addEventListener('click', handleBackdropClick);
  dialog.addEventListener('keydown', handleDialogKeydown);
  showDialog(dialog);
  (request.options.destructive ? cancel : affirmative).focus();
}

/**
 * @param {HTMLElement} dialog
 * @param {KeyboardEvent} event
 */
export function trapDialogTab(dialog, event) {
  if (event.key !== 'Tab') return;
  const controls = focusableControls(dialog);
  if (controls.length === 0) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  const activeElement = dialog.ownerDocument.activeElement;
  const activeControl = isHtmlElement(dialog.ownerDocument, activeElement) ? activeElement : null;
  if (event.shiftKey && activeControl === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && activeControl === last) {
    event.preventDefault();
    first.focus();
  } else if (!activeControl || !controls.includes(activeControl)) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * @param {HTMLElement} dialog
 * @returns {HTMLElement[]}
 */
function focusableControls(dialog) {
  /** @type {HTMLElement[]} */
  const controls = [];
  for (const element of dialog.querySelectorAll('button, input')) {
    if (!isHtmlElement(dialog.ownerDocument, element)) continue;
    if (element.hidden || element.closest('[hidden]')) continue;
    if ('disabled' in element && element.disabled === true) continue;
    controls.push(element);
  }
  return controls;
}

/**
 * @param {AlertDialogOptions} options
 * @param {HTMLInputElement} input
 * @param {HTMLButtonElement} affirmative
 */
function syncTypedState(options, input, affirmative) {
  affirmative.disabled = typeof options.typedConfirmValue === 'string' && input.value !== options.typedConfirmValue;
}

/** @param {HTMLElement} dialog */
function showDialog(dialog) {
  dialog.hidden = false;
  if ('showModal' in dialog && typeof dialog.showModal === 'function') {
    dialog.showModal();
    return;
  }
  dialog.setAttribute('open', '');
}

/** @param {HTMLElement} dialog */
function closeDialog(dialog) {
  if ('close' in dialog && typeof dialog.close === 'function' && dialog.hasAttribute('open')) {
    dialog.close();
  } else {
    dialog.removeAttribute('open');
  }
  dialog.hidden = true;
}

/**
 * @param {Document} documentRef
 * @param {string} selector
 * @returns {HTMLElement}
 */
function requiredElement(documentRef, selector) {
  const element = documentRef.querySelector(selector);
  if (!isHtmlElement(documentRef, element)) throw new Error(`RSSavis AlertDialog is missing ${selector}.`);
  return element;
}

/**
 * @param {Document} documentRef
 * @param {string} selector
 */
function requiredInput(documentRef, selector) {
  const element = requiredElement(documentRef, selector);
  const inputCtor = documentRef.defaultView?.HTMLInputElement;
  if (!inputCtor || !(element instanceof inputCtor)) throw new Error(`RSSavis AlertDialog is missing ${selector}.`);
  return element;
}

/**
 * @param {Document} documentRef
 * @param {string} selector
 */
function requiredButton(documentRef, selector) {
  const element = requiredElement(documentRef, selector);
  const buttonCtor = documentRef.defaultView?.HTMLButtonElement;
  if (!buttonCtor || !(element instanceof buttonCtor)) throw new Error(`RSSavis AlertDialog is missing ${selector}.`);
  return element;
}

/**
 * @param {Document} documentRef
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(documentRef, value) {
  const htmlElement = documentRef.defaultView?.HTMLElement;
  return Boolean(htmlElement && value instanceof htmlElement);
}
