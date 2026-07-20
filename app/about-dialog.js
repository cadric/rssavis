// @ts-check

import { cloneTemplate, queryRequired } from './templates.js';
import { createAboutResourceGroup } from './about-resources.js';

const HEADING_ID = 'about-dialog-heading';

/** @type {WeakSet<HTMLElement>} */
const navigationBoundContainers = new WeakSet();
/** @type {WeakMap<HTMLElement, AboutDialogActions>} */
const navigationActions = new WeakMap();

/**
 * @typedef {import('./about-resources.js').AboutResource} AboutResource
 * @typedef {{openResource(resource: AboutResource, button: HTMLButtonElement): Promise<void>}} AboutDialogActions
 */

/**
 * Builds the AdwAboutDialog content: a main page (icon, title, version pill and
 * the "Details"/"Legal" rows) plus two hidden subpages that hold the prose.
 * All DOM is cloned from static templates (R37 static-template contract).
 * @param {Document} documentRef
 * @param {(key: string, substitutions?: string | string[]) => string} getMessage
 * @param {string} version
 * @returns {DocumentFragment}
 */
export function renderAboutDialogContent(documentRef, getMessage, version) {
  const fragment = documentRef.createDocumentFragment();
  fragment.append(
    mainPage(documentRef, getMessage, version),
    subpage(
      documentRef,
      'details',
      getMessage('dialogBack'),
      aboutGroup(documentRef, getMessage('aboutPrivacyTitle'), getMessage('aboutPrivacyBody')),
      aboutGroup(documentRef, getMessage('aboutPermissionsTitle'), getMessage('aboutPermissionsBody')),
      aboutGroup(documentRef, getMessage('aboutCreditsTitle'), getMessage('aboutCreditsBody')),
      createAboutResourceGroup(documentRef, [
        { label: getMessage('aboutSourceCode'), resource: 'source' },
        { label: getMessage('aboutReportSecurityIssue'), resource: 'security' },
      ]),
    ),
    subpage(
      documentRef,
      'legal',
      getMessage('dialogBack'),
      aboutGroup(documentRef, getMessage('aboutLegalTitle'), getMessage('aboutLegalBody')),
      createAboutResourceGroup(documentRef, [{ label: getMessage('aboutViewFullLicense'), resource: 'license' }]),
    ),
  );
  return fragment;
}

/**
 * Delegates row/back clicks to subpage navigation. Idempotent per content node.
 * @param {HTMLElement} content
 * @param {AboutDialogActions} actions
 */
export function bindAboutDialogNavigation(content, actions) {
  navigationActions.set(content, actions);
  if (navigationBoundContainers.has(content)) return;
  navigationBoundContainers.add(content);
  content.addEventListener('click', (event) => handleNavigationClick(content, event));
}

/**
 * @param {Document} documentRef
 * @param {(key: string, substitutions?: string | string[]) => string} getMessage
 * @param {string} version
 */
function mainPage(documentRef, getMessage, version) {
  const page = cloneTemplate(documentRef, 'data-static-body-template', '.static-copy');
  page.dataset.aboutPage = 'main';

  const header = cloneTemplate(documentRef, 'data-static-body-template', '.static-copy');
  header.className = 'about-header';
  header.append(
    cloneTemplate(documentRef, 'data-about-icon-template', '.about-icon'),
    heading(documentRef, getMessage('aboutTitle')),
    paragraph(documentRef, 'about-tagline', getMessage('extensionDescription')),
    paragraph(documentRef, 'about-version-pill', getMessage('aboutVersion', version)),
  );

  const rows = cloneTemplate(documentRef, 'data-static-body-template', '.static-copy');
  rows.className = 'about-dialog-rows';
  rows.append(
    row(documentRef, 'details', getMessage('aboutDetails')),
    row(documentRef, 'legal', getMessage('aboutLegalTitle')),
  );

  page.append(header, rows, paragraph(documentRef, 'about-copyright', getMessage('aboutCopyright')));
  return page;
}

/**
 * @param {Document} documentRef
 * @param {string} text
 */
function heading(documentRef, text) {
  const source = cloneTemplate(documentRef, 'data-static-document-template', '.static-document');
  const title = queryRequired(source, '[data-static-title]');
  title.id = HEADING_ID;
  title.dataset.dialogInitialFocus = '';
  title.tabIndex = -1;
  title.removeAttribute('data-static-title');
  title.textContent = text;
  return title;
}

/**
 * @param {Document} documentRef
 * @param {string} className
 * @param {string} text
 */
function paragraph(documentRef, className, text) {
  const element = cloneTemplate(documentRef, 'data-static-paragraph-template', 'p');
  element.className = className;
  element.textContent = text;
  return element;
}

/**
 * @param {Document} documentRef
 * @param {'details' | 'legal'} target
 * @param {string} label
 */
function row(documentRef, target, label) {
  const button = cloneTemplate(documentRef, 'data-about-row-template', '.about-row');
  button.dataset.aboutSubpageOpen = target;
  queryRequired(button, '[data-about-row-label]').textContent = label;
  return button;
}

/**
 * @param {Document} documentRef
 * @param {'details' | 'legal'} page
 * @param {string} backLabel
 * @param {...HTMLElement} bodies
 */
function subpage(documentRef, page, backLabel, ...bodies) {
  const element = cloneTemplate(documentRef, 'data-about-subpage-template', '.about-subpage');
  element.dataset.aboutPage = page;
  queryRequired(element, '[data-about-subpage-back]').textContent = backLabel;
  queryRequired(element, '[data-about-subpage-body]').append(...bodies);
  return element;
}

/**
 * @param {Document} documentRef
 * @param {string} title
 * @param {string} body
 */
function aboutGroup(documentRef, title, body) {
  const group = cloneTemplate(documentRef, 'data-static-group-template', '.static-copy');
  queryRequired(group, '[data-static-group-title]').textContent = title;
  queryRequired(group, '[data-static-group-body]').textContent = body;
  return group;
}

/**
 * @param {HTMLElement} content
 * @param {Event} event
 */
function handleNavigationClick(content, event) {
  const view = content.ownerDocument.defaultView;
  const node = event.target;
  if (!view || !(node instanceof view.HTMLElement)) return;
  const resourceButton = node.closest('button[data-about-resource]');
  if (resourceButton instanceof view.HTMLButtonElement) {
    const resource = aboutResource(resourceButton.dataset.aboutResource);
    const actions = navigationActions.get(content);
    if (resource && actions) void actions.openResource(resource, resourceButton);
    return;
  }
  const opener = node.closest('[data-about-subpage-open]');
  if (opener instanceof view.HTMLElement) {
    openSubpage(content, opener);
    return;
  }
  const back = node.closest('[data-about-subpage-back]');
  if (back instanceof view.HTMLElement) closeSubpage(content, back);
}

/**
 * @param {string | undefined} value
 * @returns {AboutResource | null}
 */
function aboutResource(value) {
  return value === 'source' || value === 'license' || value === 'security' ? value : null;
}

/**
 * @param {HTMLElement} content
 * @param {HTMLElement} opener
 */
function openSubpage(content, opener) {
  const main = pageElement(content, 'main');
  const target = pageElement(content, String(opener.dataset.aboutSubpageOpen));
  if (!main || !target) return;
  main.hidden = true;
  target.hidden = false;
  focusElement(target.querySelector('[data-about-subpage-back]'));
}

/**
 * @param {HTMLElement} content
 * @param {HTMLElement} back
 */
function closeSubpage(content, back) {
  const view = content.ownerDocument.defaultView;
  const subpageElement = back.closest('[data-about-page]');
  const main = pageElement(content, 'main');
  if (!view || !(subpageElement instanceof view.HTMLElement) || !main) return;
  subpageElement.hidden = true;
  main.hidden = false;
  focusElement(content.querySelector(`[data-about-subpage-open="${subpageElement.dataset.aboutPage}"]`));
}

/**
 * @param {HTMLElement} content
 * @param {string} page
 * @returns {HTMLElement | null}
 */
function pageElement(content, page) {
  const view = content.ownerDocument.defaultView;
  const element = content.querySelector(`[data-about-page="${page}"]`);
  return view && element instanceof view.HTMLElement ? element : null;
}

/**
 * @param {Element | null} element
 */
function focusElement(element) {
  const view = element?.ownerDocument.defaultView;
  if (view && element instanceof view.HTMLElement) element.focus();
}
