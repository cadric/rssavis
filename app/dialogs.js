// @ts-check

import { AppError, ERROR_CODES, toSafeError } from '../domain/errors.js';
import { originPatternForUrl } from '../domain/urls.js';
import { addFeedWithPermission } from './api-client.js';
import { renderFormErrors } from './form-errors.js';
import { closeDialog } from './keyboard-shortcuts.js';
import { cloneTemplate, queryRequired } from './templates.js';
import { showToast } from './toasts.js';

/**
 * @typedef {object} AddFeedBrowser
 * @property {{getMessage(key: string, substitutions?: string | string[]): string}} i18n
 * @property {{request(permissions: {origins: string[]}): Promise<boolean>}} permissions
 * @property {{sendMessage(message: unknown): Promise<unknown>}} runtime
 *
 * @typedef {object} SetupAddFeedFormOptions
 * @property {Document} documentRef
 * @property {AddFeedBrowser} browserApi
 */

/**
 * @param {SetupAddFeedFormOptions} options
 */
export function setupAddFeedForm(options) {
  localizeDocument(options.documentRef, options.browserApi);
  const form = options.documentRef.querySelector('[data-add-feed-form]');
  if (!isElementNamed(form, 'form')) {
    throw new Error('RSSavis Add Feed form is missing.');
  }
  const addFeedForm = /** @type {HTMLFormElement} */ (form);
  addFeedForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitAddFeed(addFeedForm, options);
  });
}

/**
 * @param {Document} documentRef
 * @param {Pick<AddFeedBrowser, 'i18n'>} browserApi
 */
export function localizeDocument(documentRef, browserApi) {
  for (const element of documentRef.querySelectorAll('[data-i18n]')) {
    const key = element.getAttribute('data-i18n') ?? '';
    setLocalizedText(element, browserApi.i18n.getMessage(key));
  }
  for (const element of documentRef.querySelectorAll('[data-i18n-aria-label]')) {
    const key = element.getAttribute('data-i18n-aria-label') ?? '';
    setLocalizedAttribute(element, 'aria-label', browserApi.i18n.getMessage(key));
  }
  for (const element of documentRef.querySelectorAll('[data-i18n-title]')) {
    const key = element.getAttribute('data-i18n-title') ?? '';
    setLocalizedAttribute(element, 'title', browserApi.i18n.getMessage(key));
  }
  for (const element of documentRef.querySelectorAll('[data-i18n-placeholder]')) {
    const key = element.getAttribute('data-i18n-placeholder') ?? '';
    setLocalizedAttribute(element, 'placeholder', browserApi.i18n.getMessage(key));
  }
}

/** @param {Node} node @param {string} text */
function setLocalizedText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/** @param {Element} element @param {string} name @param {string} value */
function setLocalizedAttribute(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/**
 * @param {{documentRef: Document, browserApi: Pick<AddFeedBrowser, 'i18n'>, snapshot: {categories: Array<Record<string, unknown>>, feeds: Array<Record<string, unknown>>}, feedId: string}} input
 */
export function openMoveFeedDialog(input) {
  const dialog = htmlElement(input.documentRef, input.documentRef.querySelector('[data-move-feed-dialog]'));
  const form = htmlElement(input.documentRef, input.documentRef.querySelector('[data-move-feed-form]'));
  if (!dialog || !form) throw new Error('RSSavis Move Feed dialog is missing.');
  const feed = input.snapshot.feeds.find((item) => stringValue(item.id) === input.feedId);
  if (!feed) return;
  const categories = input.snapshot.categories;
  form.dataset.moveFeedForm = input.feedId;
  renderMoveCategoryOptions(input, form, categories, stringValue(feed.categoryId));
  updateMoveFeedText(input, form, feed);
  form.onchange = () => updateMoveFeedText(input, form, feed);
  dialog.hidden = false;
  if ('showModal' in dialog && typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  focusMoveFeedControl(form);
}

/**
 * @param {Document} documentRef
 */
export function closeMoveFeedDialog(documentRef) {
  const dialog = htmlElement(documentRef, documentRef.querySelector('[data-move-feed-dialog]'));
  if (!dialog) return;
  if ('close' in dialog && typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  dialog.hidden = true;
}

/**
 * @param {Document} documentRef
 */
export function selectedMoveFeedCategoryId(documentRef) {
  const form = htmlElement(documentRef, documentRef.querySelector('[data-move-feed-form]'));
  if (!form) return '';
  const view = form.ownerDocument.defaultView;
  const data = view ? new view.FormData(/** @type {HTMLFormElement} */ (form)) : null;
  if (!data) return '';
  const value = data.get('categoryId');
  return typeof value === 'string' ? value : '';
}

/**
 * @param {{documentRef: Document, browserApi: Pick<AddFeedBrowser, 'i18n'>, snapshot: {categories: Array<Record<string, unknown>>}}} input
 * @param {HTMLElement} form
 * @param {Array<Record<string, unknown>>} categories
 * @param {string} selectedCategoryId
 */
function renderMoveCategoryOptions(input, form, categories, selectedCategoryId) {
  const select = htmlElement(input.documentRef, form.querySelector('[data-move-feed-category-select]'));
  const radios = htmlElement(input.documentRef, form.querySelector('[data-move-feed-category-radios]'));
  if (!select || !radios) throw new Error('RSSavis Move Feed category controls are missing.');
  select.textContent = '';
  radios.textContent = '';
  const useSelect = categories.length > 5;
  select.hidden = !useSelect;
  select.toggleAttribute('disabled', !useSelect);
  radios.hidden = useSelect;
  if (useSelect) {
    for (const category of categories)
      select.append(moveCategoryOption(input.documentRef, category, selectedCategoryId));
    return;
  }
  for (const category of categories) radios.append(moveCategoryRadio(input.documentRef, category, selectedCategoryId));
}

/**
 * @param {{documentRef: Document, browserApi: Pick<AddFeedBrowser, 'i18n'>, snapshot: {categories: Array<Record<string, unknown>>}}} input
 * @param {HTMLElement} form
 * @param {Record<string, unknown>} feed
 */
function updateMoveFeedText(input, form, feed) {
  const targetId = selectedMoveFeedCategoryId(input.documentRef) || stringValue(feed.categoryId);
  const current = input.snapshot.categories.find(
    (category) => stringValue(category.id) === stringValue(feed.categoryId),
  );
  const target = input.snapshot.categories.find((category) => stringValue(category.id) === targetId);
  const currentText = htmlElement(input.documentRef, form.querySelector('[data-move-feed-current]'));
  const confirmText = htmlElement(input.documentRef, form.querySelector('[data-move-feed-confirmation]'));
  if (currentText) {
    currentText.textContent = input.browserApi.i18n.getMessage('feedMoveCurrentCategory', [
      stringValue(current?.title),
    ]);
  }
  if (confirmText) {
    confirmText.textContent = input.browserApi.i18n.getMessage('confirmMoveFeed', [
      stringValue(feed.title),
      stringValue(target?.title),
    ]);
  }
}

/**
 * @param {Document} documentRef
 * @param {Record<string, unknown>} category
 * @param {string} selectedCategoryId
 */
function moveCategoryOption(documentRef, category, selectedCategoryId) {
  const option = documentRef.createElement('option');
  option.value = stringValue(category.id);
  option.textContent = stringValue(category.title);
  option.selected = option.value === selectedCategoryId;
  return option;
}

/**
 * @param {Document} documentRef
 * @param {Record<string, unknown>} category
 * @param {string} selectedCategoryId
 */
function moveCategoryRadio(documentRef, category, selectedCategoryId) {
  const label = cloneTemplate(documentRef, 'data-move-category-radio-template', 'label');
  const input = /** @type {HTMLInputElement} */ (queryRequired(label, 'input'));
  const textNode = queryRequired(label, 'span');
  input.type = 'radio';
  input.name = 'categoryId';
  input.value = stringValue(category.id);
  input.checked = input.value === selectedCategoryId;
  textNode.textContent = ` ${stringValue(category.title)}`;
  return label;
}

/**
 * @param {HTMLElement} form
 */
function focusMoveFeedControl(form) {
  const target = form.querySelector('[name="categoryId"]:not([disabled])');
  if (isElementNamed(target, 'select') || isElementNamed(target, 'input')) {
    /** @type {HTMLElement} */ (target).focus();
  }
}

/**
 * @param {HTMLFormElement} form
 * @param {SetupAddFeedFormOptions} options
 */
async function submitAddFeed(form, options) {
  const fields = readAddFeedFields(form, options.documentRef);
  const validation = validateAddFeedFields(fields, options.browserApi);
  renderValidationErrors(options.documentRef, options.browserApi, validation.errors);
  if (validation.errors.length > 0) return;

  const status = options.documentRef.querySelector('[data-rssavis-status]');
  if (isHtmlElement(options.documentRef, status)) status.textContent = '';

  try {
    const response = await addFeedWithPermission(
      { url: fields.url.value, title: fields.title.value, customTitle: fields.title.value },
      options.browserApi,
    );
    if (isErrorResponse(response)) {
      renderOperationError(options.documentRef, options.browserApi, response.error.messageKey);
      return;
    }
    form.reset();
    closeDialog(options.documentRef, '[data-add-feed-dialog]');
    showToast(options.documentRef, options.browserApi.i18n.getMessage('addFeedToast'));
  } catch (error) {
    renderOperationError(options.documentRef, options.browserApi, toSafeError(error).messageKey);
  }
}

/**
 * @param {HTMLFormElement} form
 * @param {Document} documentRef
 */
function readAddFeedFields(form, documentRef) {
  void form;
  return {
    url: { element: fieldElement(documentRef, 'feed-url'), value: fieldElement(documentRef, 'feed-url').value.trim() },
    title: {
      element: fieldElement(documentRef, 'feed-title'),
      value: fieldElement(documentRef, 'feed-title').value.trim(),
    },
  };
}

/**
 * @param {Document} documentRef
 * @param {string} id
 * @returns {HTMLInputElement}
 */
function fieldElement(documentRef, id) {
  const element = documentRef.getElementById(id);
  if (!isElementNamed(element, 'input')) {
    throw new Error(`RSSavis field ${id} is missing.`);
  }
  return /** @type {HTMLInputElement} */ (element);
}

/**
 * @param {ReturnType<typeof readAddFeedFields>} fields
 * @param {Pick<AddFeedBrowser, 'i18n'>} browserApi
 */
function validateAddFeedFields(fields, browserApi) {
  /** @type {{field: 'url' | 'title', message: string}[]} */
  const errors = [];
  if (!fields.url.value) {
    errors.push({ field: 'url', message: browserApi.i18n.getMessage('addFeedUrlRequired') });
  } else {
    try {
      originPatternForUrl(fields.url.value);
    } catch (error) {
      if (!isExpectedUrlValidationError(error)) throw error;
      errors.push({ field: 'url', message: browserApi.i18n.getMessage('addFeedUrlInvalid') });
    }
  }
  if (!fields.title.value) errors.push({ field: 'title', message: browserApi.i18n.getMessage('addFeedTitleRequired') });
  return { errors };
}

/**
 * @param {Document} documentRef
 * @param {Pick<AddFeedBrowser, 'i18n'>} browserApi
 * @param {{field: 'url' | 'title', message: string}[]} errors
 */
function renderValidationErrors(documentRef, browserApi, errors) {
  const byField = new Map(errors.map((error) => [error.field, error.message]));
  renderFormErrors({
    fields: [
      fieldError(documentRef, 'url', byField.get('url') ?? ''),
      fieldError(documentRef, 'title', byField.get('title') ?? ''),
    ],
    summary: htmlElement(documentRef, documentRef.querySelector('[data-add-feed-error-summary]')),
    summaryMessage: browserApi.i18n.getMessage('addFeedErrorSummary'),
  });
}

/**
 * @param {Document} documentRef
 * @param {'url' | 'title'} field
 * @param {string} message
 */
function fieldError(documentRef, field, message) {
  const input = field === 'url' ? fieldElement(documentRef, 'feed-url') : fieldElement(documentRef, 'feed-title');
  const error = documentRef.querySelector(`[data-add-feed-field-error="${field}"]`);
  return { control: input, errorElement: htmlElement(documentRef, error), message };
}

/**
 * @param {Document} documentRef
 * @param {Pick<AddFeedBrowser, 'i18n'>} browserApi
 * @param {string} messageKey
 */
function renderOperationError(documentRef, browserApi, messageKey) {
  const summary = documentRef.querySelector('[data-add-feed-error-summary]');
  if (isHtmlElement(documentRef, summary)) {
    summary.setAttribute('tabindex', '-1');
    summary.hidden = false;
    summary.textContent = browserApi.i18n.getMessage(messageKey);
  }
}

/**
 * @param {unknown} error
 */
function isExpectedUrlValidationError(error) {
  return (
    error instanceof AppError &&
    (error.code === ERROR_CODES.VALIDATION_ERROR || error.code === ERROR_CODES.UNSUPPORTED_URL_SCHEME)
  );
}

/**
 * @param {unknown} value
 * @param {string} tagName
 */
function isElementNamed(value, tagName) {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tagName' in value &&
    typeof value.tagName === 'string' &&
    value.tagName.toLowerCase() === tagName
  );
}

/**
 * @param {Document} documentRef
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(documentRef, value) {
  void documentRef;
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}

/**
 * @param {unknown} value
 */
function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {Document} documentRef
 * @param {unknown} value
 * @returns {HTMLElement | null}
 */
function htmlElement(documentRef, value) {
  return isHtmlElement(documentRef, value) ? /** @type {HTMLElement} */ (value) : null;
}

/**
 * @param {unknown} response
 * @returns {response is {ok: false, error: {messageKey: string}}}
 */
function isErrorResponse(response) {
  return typeof response === 'object' && response !== null && 'ok' in response && response.ok === false;
}
