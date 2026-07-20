// @ts-check

import { cloneTemplate, queryRequired } from './templates.js';

/**
 * @param {Document} documentRef
 * @param {(key: string) => string} getMessage
 */
export function renderHelpView(documentRef, getMessage) {
  const document = cloneTemplate(documentRef, 'data-help-document-template', '.help-document');
  queryRequired(document, '[data-help-intro]').textContent = getMessage('helpIntro');
  const groups = queryRequired(document, '[data-help-groups]');
  for (const [titleKey, bodyKey] of [
    ['helpFeedsTitle', 'helpFeeds'],
    ['helpPermissionsTitle', 'helpPermissions'],
    ['helpKeyboardTitle', 'helpKeyboard'],
  ]) {
    groups.append(helpGroup(documentRef, getMessage(titleKey), getMessage(bodyKey)));
  }
  return document;
}

/**
 * @param {Document} documentRef
 * @param {string} title
 * @param {string} body
 */
function helpGroup(documentRef, title, body) {
  const section = cloneTemplate(documentRef, 'data-help-group-template', '.help-group');
  queryRequired(section, '[data-help-group-title]').textContent = title;
  queryRequired(section, '[data-help-group-body]').textContent = body;
  return section;
}
