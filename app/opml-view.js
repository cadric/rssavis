// @ts-check

import { cloneTemplate, queryRequired } from './templates.js';

/**
 * @param {Document} documentRef
 * @param {(key: string) => string} getMessage
 */
export function renderImportSection(documentRef, getMessage) {
  const section = cloneTemplate(documentRef, 'data-opml-import-section-template', '.settings-section');
  section.setAttribute('aria-labelledby', 'settings-main-title');
  const heading = queryRequired(section, '[data-settings-management-title]');
  heading.id = 'settings-main-title';
  heading.dataset.settingsManagementTitle = '';
  heading.textContent = getMessage('settingsImport');
  queryRequired(section, '[data-opml-help]').textContent = getMessage('opmlHelp');
  queryRequired(section, '[data-opml-file-label]').textContent = getMessage('opmlFileLabel');
  const previewButton = /** @type {HTMLButtonElement} */ (queryRequired(section, '[data-opml-preview-submit]'));
  previewButton.textContent = getMessage('opmlPreview');
  const commit = /** @type {HTMLButtonElement} */ (queryRequired(section, '[data-opml-commit]'));
  commit.textContent = getMessage('opmlCommit');
  commit.disabled = true;
  queryRequired(section, '[data-opml-export-title]').textContent = getMessage('opmlExport');
  queryRequired(section, '[data-opml-export-subtitle]').textContent = getMessage('opmlExportSubtitle');
  const exportButton = /** @type {HTMLButtonElement} */ (queryRequired(section, '[data-opml-export]'));
  exportButton.textContent = getMessage('opmlExport');

  return section;
}
