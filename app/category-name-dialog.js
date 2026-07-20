// @ts-check

/**
 * @param {{documentRef: Document, mode: 'create' | 'rename', id?: string, currentTitle?: string}} input
 */
export function openCategoryNameDialog(input) {
  const dialog = htmlElement(input.documentRef, input.documentRef.querySelector('[data-category-name-dialog]'));
  const form = htmlElement(input.documentRef, dialog.querySelector('form'));
  const heading = htmlElement(input.documentRef, dialog.querySelector('[data-category-name-heading]'));
  const submit = htmlButton(input.documentRef, dialog.querySelector('[data-category-name-submit]'));
  const title = htmlInput(input.documentRef, dialog.querySelector('[name="title"]'));
  if (input.mode === 'create') {
    form.setAttribute('data-category-create-form', '');
    form.removeAttribute('data-category-rename-form');
    heading.textContent = message('categoryAdd');
    submit.textContent = message('categoryCreate');
    title.value = '';
  } else {
    form.setAttribute('data-category-rename-form', input.id ?? '');
    form.removeAttribute('data-category-create-form');
    heading.textContent = message('categoryRenameTitle');
    submit.textContent = message('categoryRename');
    title.value = input.currentTitle ?? '';
  }
  clearFormErrors(form);
  dialog.hidden = false;
  if ('showModal' in dialog && typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  title.focus();
}

/**
 * @param {Document} documentRef
 */
export function closeCategoryNameDialog(documentRef) {
  const dialog = htmlElement(documentRef, documentRef.querySelector('[data-category-name-dialog]'));
  if ('close' in dialog && typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  dialog.hidden = true;
}

/**
 * @param {HTMLElement} form
 */
function clearFormErrors(form) {
  const summary = htmlElement(form.ownerDocument, form.querySelector('[data-management-error-summary]'));
  summary.hidden = true;
  summary.textContent = '';
  for (const field of form.querySelectorAll('input')) field.removeAttribute('aria-invalid');
  for (const error of form.querySelectorAll('.field-error')) error.textContent = '';
}

/**
 * @param {string} key
 */
function message(key) {
  const browserApi = /** @type {{browser?: {i18n?: {getMessage?(key: string): string}}}} */ (
    /** @type {unknown} */ (globalThis)
  ).browser;
  return browserApi?.i18n?.getMessage?.(key) ?? key;
}

/**
 * @param {Document} documentRef
 * @param {Element | null} element
 * @returns {HTMLElement}
 */
function htmlElement(documentRef, element) {
  if (element instanceof requireView(documentRef).HTMLElement) return element;
  throw new Error('RSSavis Category dialog is missing.');
}

/**
 * @param {Document} documentRef
 * @param {Element | null} element
 */
function htmlButton(documentRef, element) {
  if (element instanceof requireView(documentRef).HTMLButtonElement) return element;
  throw new Error('RSSavis Category dialog button is missing.');
}

/**
 * @param {Document} documentRef
 * @param {Element | null} element
 */
function htmlInput(documentRef, element) {
  if (element instanceof requireView(documentRef).HTMLInputElement) return element;
  throw new Error('RSSavis Category dialog input is missing.');
}

/**
 * @param {Document} documentRef
 */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}
