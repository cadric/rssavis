// @ts-check

import { cloneTemplate } from './templates.js';

/**
 * @typedef {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} FormControl
 * @typedef {object} FormFieldError
 * @property {FormControl} control
 * @property {HTMLElement | null} errorElement
 * @property {string} message
 *
 * @typedef {object} FormErrorRenderOptions
 * @property {FormFieldError[]} fields
 * @property {HTMLElement | null} summary
 * @property {string} summaryMessage
 */

/**
 * @param {FormErrorRenderOptions} options
 */
export function renderFormErrors(options) {
  const hasErrors = options.fields.some((field) => field.message);
  for (const field of options.fields) renderFieldError(field);
  renderErrorSummary(options.summary, hasErrors ? options.summaryMessage : '');
  if (hasErrors) focusSummary(options.summary);
  return !hasErrors;
}

/**
 * @param {Document} documentRef
 * @param {string} id
 * @param {string} datasetKey
 */
export function createErrorSummary(documentRef, id, datasetKey) {
  const summary = cloneTemplate(documentRef, 'data-error-summary-template', 'div');
  summary.id = id;
  summary.dataset[datasetKey] = '';
  summary.hidden = true;
  summary.setAttribute('role', 'alert');
  return summary;
}

/**
 * @param {Document} documentRef
 * @param {string} id
 */
export function createFieldError(documentRef, id) {
  const error = cloneTemplate(documentRef, 'data-field-error-template', '.field-error');
  error.id = `${id}-error`;
  error.className = 'field-error';
  error.dataset.fieldErrorFor = id;
  return error;
}

/**
 * @param {FormFieldError} field
 */
function renderFieldError(field) {
  field.control.setAttribute('aria-invalid', field.message ? 'true' : 'false');
  if (!field.errorElement) return;
  field.errorElement.textContent = field.message;
  if (field.errorElement.id) addDescribedBy(field.control, field.errorElement.id);
}

/**
 * @param {HTMLElement | null} summary
 * @param {string} message
 */
function renderErrorSummary(summary, message) {
  if (!summary) return;
  summary.hidden = !message;
  summary.textContent = message;
  summary.setAttribute('tabindex', '-1');
  if (!summary.hasAttribute('role')) summary.setAttribute('role', 'alert');
}

/**
 * @param {HTMLElement | null} summary
 */
function focusSummary(summary) {
  if (!summary) return;
  try {
    summary.focus({ preventScroll: true });
  } catch (error) {
    if (!isExpectedPreventScrollFocusError(error)) throw error;
    summary.focus();
  }
}

/**
 * @param {unknown} error
 */
function isExpectedPreventScrollFocusError(error) {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && (error.name === 'NotSupportedError' || error.name === 'InvalidStateError'))
  );
}

/**
 * @param {Element} element
 * @param {string} id
 */
function addDescribedBy(element, id) {
  const ids = new Set((element.getAttribute('aria-describedby') ?? '').split(/\s+/u).filter(Boolean));
  ids.add(id);
  element.setAttribute('aria-describedby', [...ids].join(' '));
}
