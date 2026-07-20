// @ts-check

import { sectionShell, stringValue } from './management-shared.js';
import { cloneTemplate, queryRequired } from './templates.js';

/**
 * @typedef {object} ManagementI18n
 * @property {(key: string, substitutions?: string | number | Array<string | number>) => string} getMessage
 */

/**
 * @param {Document} documentRef
 * @param {{categories: Array<Record<string, unknown>>, defaultCategoryId?: string, feeds: Array<Record<string, unknown>>}} snapshot
 * @param {ManagementI18n} i18n
 */
export function renderCategoriesSection(documentRef, snapshot, i18n) {
  const getMessage = i18n.getMessage;
  const section = sectionShell(documentRef, {
    action: { dataset: { categoryAction: 'create', categoryId: '' }, label: getMessage('categoryAdd') },
    subtitle: getMessage('settingsCategoriesSubtitle'),
    title: getMessage('settingsCategories'),
  });
  const list = documentRef.createElement('div');
  list.className = 'settings-list';
  for (const category of snapshot.categories) list.append(categoryRow(documentRef, snapshot, category, i18n));
  section.append(list);
  return section;
}

/**
 * @param {Document} documentRef
 * @param {{defaultCategoryId?: string, feeds: Array<Record<string, unknown>>}} snapshot
 * @param {Record<string, unknown>} category
 * @param {ManagementI18n} i18n
 */
function categoryRow(documentRef, snapshot, category, i18n) {
  const getMessage = i18n.getMessage;
  const id = stringValue(category.id);
  const title = stringValue(category.title);
  const row = cloneTemplate(documentRef, 'data-category-row-template', '[data-category-row]');
  row.dataset.categoryId = id;
  const grip = /** @type {HTMLButtonElement} */ (queryRequired(row, '[data-category-grip]'));
  grip.dataset.categoryId = id;
  setButtonLabel(grip, getMessage('categoryGrip', [title]));
  queryRequired(row, '[data-category-row-title]').textContent = title;
  queryRequired(row, '[data-category-row-count]').textContent = getMessage('categoryFeedCount', [
    feedCountForCategory(snapshot.feeds, id),
  ]);
  const rename = /** @type {HTMLButtonElement} */ (queryRequired(row, '[data-category-action="rename"]'));
  rename.dataset.categoryId = id;
  setButtonLabel(rename, getMessage('categoryRenameTitle'));
  const deleteButton = /** @type {HTMLButtonElement} */ (queryRequired(row, '[data-category-action="delete"]'));
  deleteButton.dataset.categoryId = id;
  deleteButton.disabled = id === stringValue(snapshot.defaultCategoryId);
  setButtonLabel(deleteButton, getMessage('categoryDelete'));
  return row;
}

/**
 * @param {Array<Record<string, unknown>>} feeds
 * @param {string} categoryId
 */
function feedCountForCategory(feeds, categoryId) {
  return feeds.filter((feed) => stringValue(feed.categoryId) === categoryId).length;
}

/**
 * @param {HTMLButtonElement} button
 * @param {string} label
 */
function setButtonLabel(button, label) {
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
}
