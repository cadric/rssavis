// @ts-check

import { AppError, ERROR_CODES } from '../domain/errors.js';
import { originPatternForUrl } from '../domain/urls.js';
import { renderFormErrors } from './form-errors.js';

/** @typedef {import('./management-controller.js').ManagementControllerInput} ManagementControllerInput */

/**
 * @param {ManagementControllerInput} input
 * @param {HTMLElement} form
 */
export function validateFeedForm(input, form) {
  // The feed title field edits the optional user `customTitle`; an empty value clears it and falls
  // back to the feed's remote title, so only the URL is required here.
  return renderFormErrors({
    fields: compactFields([urlField(input, form)]),
    summary: htmlElement(form.querySelector('[data-management-error-summary]')),
    summaryMessage: input.options.browserApi.i18n.getMessage('managementFormErrorSummary'),
  });
}

/**
 * @param {ManagementControllerInput} input
 * @param {HTMLElement} form
 */
export function validateCategoryTitleForm(input, form) {
  return renderFormErrors({
    fields: compactFields([requiredField(input, form, 'title', 'categoryNameRequired')]),
    summary: htmlElement(form.querySelector('[data-management-error-summary]')),
    summaryMessage: input.options.browserApi.i18n.getMessage('managementFormErrorSummary'),
  });
}

/**
 * @param {ManagementControllerInput} input
 * @param {HTMLElement} form
 * @param {string} name
 * @param {string} messageKey
 */
function requiredField(input, form, name, messageKey) {
  const control = formControl(form, name);
  if (!isInputLike(control)) return null;
  return fieldError(control, control.value.trim() ? '' : input.options.browserApi.i18n.getMessage(messageKey));
}

/**
 * @param {ManagementControllerInput} input
 * @param {HTMLElement} form
 */
function urlField(input, form) {
  const control = formControl(form, 'url');
  if (!isInputLike(control)) return null;
  const value = control.value.trim();
  if (!value) return fieldError(control, input.options.browserApi.i18n.getMessage('feedUrlRequired'));
  try {
    originPatternForUrl(value);
    return fieldError(control, '');
  } catch (error) {
    if (!isExpectedUrlValidationError(error)) throw error;
    return fieldError(control, input.options.browserApi.i18n.getMessage('feedUrlInvalid'));
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
 * @param {HTMLInputElement | HTMLSelectElement} control
 * @param {string} message
 */
function fieldError(control, message) {
  return { control, errorElement: control.ownerDocument.getElementById(`${control.id}-error`), message };
}

/**
 * @param {Array<import('./form-errors.js').FormFieldError | null>} fields
 * @returns {import('./form-errors.js').FormFieldError[]}
 */
function compactFields(fields) {
  /** @type {import('./form-errors.js').FormFieldError[]} */
  const output = [];
  for (const field of fields) {
    if (field) output.push(field);
  }
  return output;
}

/**
 * @param {HTMLElement} form
 * @param {string} name
 */
function formControl(form, name) {
  return form.querySelector(`[name="${name}"]`);
}

/**
 * @param {unknown} value
 * @returns {HTMLElement | null}
 */
function htmlElement(value) {
  return isHtmlElement(value) ? /** @type {HTMLElement} */ (value) : null;
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
 * @returns {value is HTMLInputElement | HTMLSelectElement}
 */
function isInputLike(value) {
  return isHtmlElement(value) && 'value' in value;
}
