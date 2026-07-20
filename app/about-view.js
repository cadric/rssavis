// @ts-check

import { cloneTemplate, queryRequired } from './templates.js';

/**
 * @param {Document} documentRef
 * @param {(key: string, substitutions?: string | string[]) => string} getMessage
 * @param {string} version
 * @param {string} [headingId]
 */
export function renderAboutView(documentRef, getMessage, version, headingId = 'static-main-title') {
  const section = shell(documentRef, 'about', getMessage('aboutTitle'), headingId);
  const header = cloneTemplate(documentRef, 'data-static-body-template', '.static-copy');
  header.className = 'about-header';
  header.append(
    cloneTemplate(documentRef, 'data-about-icon-template', '.about-icon'),
    queryRequired(section, '[data-static-title]'),
  );
  const tagline = cloneTemplate(documentRef, 'data-static-paragraph-template', 'p');
  tagline.className = 'about-tagline';
  tagline.textContent = getMessage('extensionDescription');
  const versionLine = cloneTemplate(documentRef, 'data-static-paragraph-template', 'p');
  versionLine.className = 'about-version-pill';
  versionLine.textContent = getMessage('aboutVersion', version);
  header.append(tagline, versionLine);
  section.append(
    header,
    staticCard(
      documentRef,
      aboutGroup(documentRef, getMessage('aboutPrivacyTitle'), getMessage('aboutPrivacyBody')),
      aboutGroup(documentRef, getMessage('aboutPermissionsTitle'), getMessage('aboutPermissionsBody')),
      aboutGroup(documentRef, getMessage('aboutCreditsTitle'), getMessage('aboutCreditsBody')),
      aboutGroup(documentRef, getMessage('aboutLegalTitle'), getMessage('aboutLegalBody')),
    ),
    copyrightLine(documentRef, getMessage('aboutCopyright')),
  );
  return section;
}

/**
 * @param {Document} documentRef
 * @param {...HTMLElement} bodies
 */
function staticCard(documentRef, ...bodies) {
  const card = cloneTemplate(documentRef, 'data-static-body-template', '.static-copy');
  card.className = 'static-card';
  card.append(...bodies);
  return card;
}

/**
 * @param {Document} documentRef
 * @param {string} title
 * @param {string} body
 */
function aboutGroup(documentRef, title, body) {
  const group = cloneTemplate(documentRef, 'data-static-group-template', '.static-copy');
  const heading = queryRequired(group, '[data-static-group-title]');
  heading.textContent = title;
  const paragraph = queryRequired(group, '[data-static-group-body]');
  paragraph.textContent = body;
  return group;
}

/**
 * @param {Document} documentRef
 * @param {string} text
 */
function copyrightLine(documentRef, text) {
  const paragraph = cloneTemplate(documentRef, 'data-static-paragraph-template', 'p');
  paragraph.className = 'about-copyright';
  paragraph.textContent = text;
  return paragraph;
}

/**
 * @param {Document} documentRef
 * @param {string} page
 * @param {string} title
 * @param {string} headingId
 */
function shell(documentRef, page, title, headingId) {
  const section = cloneTemplate(documentRef, 'data-static-document-template', '.static-document');
  section.dataset.staticPage = page;
  section.setAttribute('aria-labelledby', headingId);
  const heading = queryRequired(section, '[data-static-title]');
  heading.id = headingId;
  heading.textContent = title;
  return section;
}
