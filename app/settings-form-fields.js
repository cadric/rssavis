// @ts-check

import { cloneTemplate, queryRequired } from './templates.js';

/** @type {Readonly<Record<string, string | number | boolean>>} */
export const DEFAULT_SETTINGS = Object.freeze({
  accentColor: 'blue',
  articlesPerPage: 100,
  colorScheme: 'system',
  defaultArticleView: 'normal',
  feedTimeoutSeconds: 30,
  imageLoading: 'on-expand',
  keepStarredOnPurge: true,
  keepUnreadOnPurge: true,
  language: 'auto',
  lazyLoadImages: true,
  markReadOnExpand: true,
  markReadOnOpen: true,
  markReadOnScroll: false,
  openLinksMode: 'background-tab',
  purgeMaxAgeDays: 90,
  purgeMaxArticles: 10000,
  refreshIntervalMinutes: 30,
});

/**
 * @param {HTMLFormElement} form
 * @param {...Node} nodes
 */
export function appendFormFields(form, ...nodes) {
  const list = form.querySelector('[data-settings-list]');
  if (list) list.append(...nodes);
}

/**
 * @param {Document} documentRef
 * @param {string} id
 * @param {string} name
 * @param {string} labelText
 * @param {number} min
 * @param {number} max
 * @param {string} [subtitleText]
 * @param {{decreaseLabel: string, increaseLabel: string}} [spinLabels]
 */
export function numberField(documentRef, id, name, labelText, min, max, subtitleText = '', spinLabels) {
  const field = cloneTemplate(documentRef, 'data-settings-spin-row-template', '.settings-row');
  const label = queryRequired(field, 'label');
  const input = /** @type {HTMLInputElement} */ (queryRequired(field, 'input'));
  const error = queryRequired(field, '.field-error');
  const decrement = /** @type {HTMLButtonElement} */ (queryRequired(field, '[data-settings-spin-decrement]'));
  const increment = /** @type {HTMLButtonElement} */ (queryRequired(field, '[data-settings-spin-increment]'));
  field.dataset.settingName = name;
  label.setAttribute('for', id);
  label.textContent = labelText;
  decrement.setAttribute('aria-label', spinLabels?.decreaseLabel ?? '');
  increment.setAttribute('aria-label', spinLabels?.increaseLabel ?? '');
  input.id = id;
  input.name = name;
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  input.required = true;
  input.value = String(DEFAULT_SETTINGS[name] ?? min);
  error.id = `${id}-error`;
  error.dataset.fieldErrorFor = id;
  input.setAttribute('aria-describedby', error.id);
  applySubtitle(field, id, subtitleText, input);
  decrement.addEventListener('click', () => stepNumberInput(input, -1));
  increment.addEventListener('click', () => stepNumberInput(input, 1));
  input.addEventListener('input', () => syncSpinRow(field));
  input.addEventListener('change', () => syncSpinRow(field));
  syncSpinRow(field);
  return field;
}

/**
 * @param {Document} documentRef
 * @param {string} id
 * @param {string} name
 * @param {string} labelText
 * @param {Array<[string, string]>} values
 * @param {string} [subtitleText]
 */
export function comboField(documentRef, id, name, labelText, values, subtitleText = '') {
  const field = cloneTemplate(documentRef, 'data-settings-combo-row-template', '.settings-row');
  const title = queryRequired(field, '[data-settings-combo-title]');
  const trigger = queryRequired(field, '[data-settings-combo-trigger]');
  const valueNode = queryRequired(field, '[data-settings-combo-value]');
  const select = /** @type {HTMLSelectElement} */ (queryRequired(field, 'select'));
  field.dataset.settingName = name;
  title.id = `${id}-label`;
  title.textContent = labelText;
  valueNode.id = `${id}-value`;
  select.id = id;
  select.name = name;
  select.hidden = true;
  for (const [value, text] of values) {
    const option = documentRef.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = String(DEFAULT_SETTINGS[name] ?? values[0]?.[0] ?? '');
  valueNode.textContent = select.selectedOptions[0]?.textContent ?? '';
  trigger.setAttribute('aria-labelledby', `${title.id} ${valueNode.id}`);
  applySubtitle(field, id, subtitleText, trigger);
  return field;
}

/**
 * @param {Document} documentRef
 * @param {string} id
 * @param {string} name
 * @param {string} legendText
 * @param {Array<[string, string]>} values
 */
export function accentSwatchField(documentRef, id, name, legendText, values) {
  const group = cloneTemplate(documentRef, 'data-settings-accent-swatch-row-template', 'fieldset');
  const legend = queryRequired(group, 'legend');
  const options = queryRequired(group, '[data-accent-swatch-options]');
  const prototype = queryRequired(options, 'label');
  const defaultValue = String(DEFAULT_SETTINGS[name] ?? values[0]?.[0] ?? '');
  group.dataset.settingName = name;
  legend.id = `${id}-legend`;
  legend.textContent = legendText;
  prototype.remove();
  for (const [value, text] of values) {
    const label = /** @type {HTMLElement} */ (prototype.cloneNode(true));
    const input = /** @type {HTMLInputElement} */ (queryRequired(label, 'input'));
    const circle = queryRequired(label, '.accent-swatch-circle');
    const textNode = queryRequired(label, '.visually-hidden');
    const optionId = `${id}-${value}`;
    label.setAttribute('for', optionId);
    label.setAttribute('title', text);
    input.id = optionId;
    input.name = name;
    input.type = 'radio';
    input.value = value;
    input.checked = value === defaultValue;
    circle.dataset.accent = value;
    textNode.textContent = text;
    options.append(label);
  }
  return group;
}

/**
 * @param {Document} documentRef
 * @param {string} id
 * @param {string} name
 * @param {string} labelText
 * @param {string} [subtitleText]
 */
export function checkboxField(documentRef, id, name, labelText, subtitleText = '') {
  const label = cloneTemplate(documentRef, 'data-settings-checkbox-row-template', 'label');
  const input = /** @type {HTMLInputElement} */ (queryRequired(label, 'input'));
  const textNode = queryRequired(label, '.settings-row-title');
  input.id = id;
  input.name = name;
  input.type = 'checkbox';
  input.checked = DEFAULT_SETTINGS[name] === true;
  textNode.textContent = labelText;
  applySubtitle(label, id, subtitleText, input);
  return label;
}

/**
 * @param {Document} documentRef
 * @param {string} id
 * @param {string} labelText
 * @param {string} [valueText]
 * @param {string} [subtitleText]
 */
export function staticTextField(documentRef, id, labelText, valueText = '', subtitleText = '') {
  const row = cloneTemplate(documentRef, 'data-settings-static-row-template', '.settings-row');
  const title = queryRequired(row, '.settings-row-title');
  const value = queryRequired(row, '.settings-row-value');
  title.textContent = labelText;
  value.textContent = valueText;
  value.hidden = !valueText;
  applySubtitle(row, id, subtitleText);
  return row;
}

/**
 * @param {Document} documentRef
 * @param {string} label
 */
export function submitButton(documentRef, label) {
  const button = /** @type {HTMLButtonElement} */ (cloneTemplate(documentRef, 'data-text-button-template', 'button'));
  button.type = 'submit';
  button.className = 'text-button';
  button.textContent = label;
  return button;
}

/**
 * @param {Document} documentRef
 * @param {string} label
 * @param {string} key
 */
export function actionButton(documentRef, label, key) {
  const button = submitButton(documentRef, label);
  button.type = 'button';
  button.dataset[key] = '';
  return button;
}

/**
 * @param {Document} documentRef
 * @param {string} text
 */
export function note(documentRef, text) {
  const item = cloneTemplate(documentRef, 'data-settings-note-template', '.settings-note');
  item.textContent = text;
  return item;
}

/** @param {Document} documentRef */
export function syncSpinRows(documentRef) {
  for (const row of documentRef.querySelectorAll('[data-settings-spin-row]')) syncSpinRow(row);
}

/**
 * @param {HTMLInputElement} input
 * @param {-1 | 1} direction
 */
function stepNumberInput(input, direction) {
  const before = input.value;
  if (direction < 0) input.stepDown();
  else input.stepUp();
  syncSpinRow(input.closest('[data-settings-spin-row]'));
  if (input.value === before) return;
  const view = input.ownerDocument.defaultView;
  input.dispatchEvent(new (view?.Event ?? Event)('change', { bubbles: true }));
}

/** @param {Element | null} row */
function syncSpinRow(row) {
  if (!row) return;
  const input = row.querySelector('input[type="number"]');
  const decrement = row.querySelector('[data-settings-spin-decrement]');
  const increment = row.querySelector('[data-settings-spin-increment]');
  if (!isInput(input)) return;
  if (!isButton(decrement)) return;
  if (!isButton(increment)) return;
  const value = Number(input.value);
  decrement.disabled = Number.isFinite(value) && input.min !== '' && value <= Number(input.min);
  increment.disabled = Number.isFinite(value) && input.max !== '' && value >= Number(input.max);
}

/**
 * @param {Element} row
 * @param {string} id
 * @param {string} subtitleText
 * @param {Element} [describedElement]
 */
function applySubtitle(row, id, subtitleText, describedElement) {
  const subtitle = row.querySelector('.settings-row-subtitle');
  if (!subtitle) return;
  if (!subtitleText) {
    subtitle.removeAttribute('id');
    subtitle.textContent = '';
    if ('hidden' in subtitle) subtitle.hidden = true;
    return;
  }
  subtitle.id = `${id}-description`;
  subtitle.textContent = subtitleText;
  if ('hidden' in subtitle) subtitle.hidden = false;
  if (describedElement) addDescribedBy(describedElement, subtitle.id);
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

/**
 * @param {unknown} value
 * @returns {value is HTMLButtonElement}
 */
function isButton(value) {
  return isElement(value) && 'disabled' in value;
}

/**
 * @param {number} bytes
 * @param {(value: number) => string} [formatNumber]
 */
export function formatBytes(bytes, formatNumber = defaultFormatNumber) {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes))} B`;
  const mib = bytes / 1024 / 1024;
  const rounded = mib >= 10 ? Math.round(mib) : Number(mib.toFixed(1));
  return `${formatNumber(rounded)} MiB`;
}

/** @param {number} value */
function defaultFormatNumber(value) {
  return new Intl.NumberFormat('en').format(value);
}

/**
 * @param {unknown} value
 */
export function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * @param {unknown} value
 * @returns {value is Element}
 */
export function isElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
export function isHtmlElement(value) {
  return isElement(value) && 'hidden' in value;
}

/**
 * @param {unknown} value
 * @returns {value is HTMLInputElement}
 */
export function isInput(value) {
  return isElement(value) && 'checked' in value && 'type' in value && 'value' in value;
}

/**
 * @param {unknown} value
 * @returns {value is HTMLSelectElement}
 */
export function isSelect(value) {
  return isElement(value) && 'selectedIndex' in value && 'value' in value;
}
