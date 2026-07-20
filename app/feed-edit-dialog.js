// @ts-check

/**
 * @typedef {import('./api-client.js').BootstrapSnapshot} BootstrapSnapshot
 */

/**
 * @param {{documentRef: Document, snapshot: BootstrapSnapshot, feedId: string}} input
 */
export function openFeedEditDialog(input) {
  const dialog = htmlElement(input.documentRef, input.documentRef.querySelector('[data-feed-edit-dialog]'));
  const form = htmlElement(input.documentRef, dialog.querySelector('[data-feed-edit-form]'));
  const feed = input.snapshot.feeds.find((item) => item.id === input.feedId);
  if (!feed) return;
  form.setAttribute('data-feed-edit-form', input.feedId);
  setInputValue(form, 'title', feed.customTitle);
  setInputValue(form, 'url', feed.url);
  setCheckboxValue(form, 'mainStreamState', feed.mainStreamState === 1);
  setCheckboxValue(form, 'keepReadOnPurge', feed.keepReadOnPurge === 1);
  setSelectValue(form, 'iconSource', feed.iconSource || 'auto');
  setRadioValue(form, 'iconColor', feed.iconColor);
  renderCategoryOptions(input.documentRef, form, input.snapshot.categories, feed.categoryId);
  clearFormErrors(form);
  dialog.hidden = false;
  if ('showModal' in dialog && typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  inputElement(form, 'title')?.focus();
}

/**
 * @param {Document} documentRef
 */
export function closeFeedEditDialog(documentRef) {
  const dialog = htmlElement(documentRef, documentRef.querySelector('[data-feed-edit-dialog]'));
  if ('close' in dialog && typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  dialog.hidden = true;
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} form
 * @param {BootstrapSnapshot['categories']} categories
 * @param {string} selectedCategoryId
 */
function renderCategoryOptions(documentRef, form, categories, selectedCategoryId) {
  const select = selectElement(form, 'categoryId');
  if (!select) return;
  select.textContent = '';
  for (const category of categories) {
    const option = documentRef.createElement('option');
    option.value = category.id;
    option.textContent = category.title;
    option.selected = category.id === selectedCategoryId;
    select.append(option);
  }
}

/**
 * @param {HTMLElement} form
 */
function clearFormErrors(form) {
  const summary = htmlElement(form.ownerDocument, form.querySelector('[data-management-error-summary]'));
  summary.hidden = true;
  summary.textContent = '';
  for (const field of form.querySelectorAll('input, select')) field.removeAttribute('aria-invalid');
  for (const error of form.querySelectorAll('.field-error')) error.textContent = '';
}

/**
 * @param {HTMLElement} form
 * @param {string} name
 * @param {string} value
 */
function setInputValue(form, name, value) {
  const input = inputElement(form, name);
  if (input) input.value = value;
}

/**
 * @param {HTMLElement} form
 * @param {string} name
 * @param {boolean} checked
 */
function setCheckboxValue(form, name, checked) {
  const input = inputElement(form, name);
  if (input) input.checked = checked;
}

/**
 * @param {HTMLElement} form
 * @param {string} name
 * @param {string} value
 */
function setSelectValue(form, name, value) {
  const select = selectElement(form, name);
  if (select) select.value = typeof value === 'string' ? value : '';
}

/**
 * Checks the swatch radio matching the stored value; any other value (including
 * the empty automatic default) resolves to the radio whose value equals it.
 * @param {HTMLElement} form
 * @param {string} name
 * @param {string} value
 */
function setRadioValue(form, name, value) {
  for (const radio of form.querySelectorAll(`[name="${name}"]`)) {
    if (radio instanceof requireView(form.ownerDocument).HTMLInputElement) radio.checked = radio.value === value;
  }
}

/**
 * @param {HTMLElement} form
 * @param {string} name
 */
function inputElement(form, name) {
  const element = form.querySelector(`[name="${name}"]`);
  return element instanceof requireView(form.ownerDocument).HTMLInputElement ? element : null;
}

/**
 * @param {HTMLElement} form
 * @param {string} name
 */
function selectElement(form, name) {
  const element = form.querySelector(`[name="${name}"]`);
  return element instanceof requireView(form.ownerDocument).HTMLSelectElement ? element : null;
}

/**
 * @param {Document} documentRef
 * @param {Element | null} element
 * @returns {HTMLElement}
 */
function htmlElement(documentRef, element) {
  if (element instanceof requireView(documentRef).HTMLElement) return element;
  throw new Error('RSSavis Feed Edit dialog is missing.');
}

/**
 * @param {Document} documentRef
 */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}
