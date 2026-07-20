// @ts-check

import { cloneTemplate, queryRequired } from './templates.js';

/**
 * @typedef {object} ManagementSectionAction
 * @property {string} label
 * @property {Record<string, string>} dataset
 */

/**
 * @param {Document} documentRef
 * @param {{title: string, subtitle?: string, action?: ManagementSectionAction}} options
 */
export function sectionShell(documentRef, options) {
  const section = cloneTemplate(documentRef, 'data-settings-section-template', '.settings-section');
  section.setAttribute('aria-labelledby', 'settings-main-title');
  const heading = queryRequired(section, '[data-settings-management-title]');
  setHeading(heading, options.title);
  if (options.subtitle || options.action) {
    const header = cloneTemplate(documentRef, 'data-management-header-template', '.management-section-header');
    setHeading(queryRequired(header, '[data-settings-management-title]'), options.title);
    const subtitle = queryRequired(header, '[data-management-section-subtitle]');
    subtitle.hidden = !options.subtitle;
    subtitle.textContent = options.subtitle ?? '';
    const action = /** @type {HTMLButtonElement} */ (queryRequired(header, '[data-management-header-action]'));
    action.hidden = !options.action;
    if (options.action) {
      action.textContent = options.action.label;
      for (const [key, value] of Object.entries(options.action.dataset)) action.dataset[key] = value;
    }
    heading.replaceWith(header);
  }
  return section;
}

/** @param {Document} documentRef
 * @param {string} text */
export function note(documentRef, text) {
  const item = cloneTemplate(documentRef, 'data-settings-note-template', '.settings-note');
  item.textContent = text;
  return item;
}

/** @param {unknown} value */
export function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

/** @param {unknown} value */
export function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {HTMLElement} heading
 * @param {string} title
 */
function setHeading(heading, title) {
  heading.id = 'settings-main-title';
  heading.dataset.settingsManagementTitle = '';
  heading.tabIndex = -1;
  heading.textContent = title;
}
