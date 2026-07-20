// @ts-check

/**
 * @param {Document} documentRef
 * @param {string} id
 * @returns {HTMLTemplateElement}
 */
export function getRequiredTemplate(documentRef, id) {
  const view = requireView(documentRef);
  const selector = templateSelector(id);
  const template = documentRef.querySelector(selector);
  if (!(template instanceof view.HTMLTemplateElement)) throw new Error(`Missing template: ${selector}`);
  return template;
}

/**
 * @param {Document} documentRef
 * @param {string} id
 * @param {string} [elementSelector]
 * @returns {HTMLElement}
 */
export function cloneTemplate(documentRef, id, elementSelector = '') {
  const view = requireView(documentRef);
  const selector = templateSelector(id);
  const element = getRequiredTemplate(documentRef, id).content.firstElementChild?.cloneNode(true);
  if (!(element instanceof view.HTMLElement)) throw new Error(`Template ${selector} did not contain an HTML element.`);
  if (elementSelector && !element.matches(elementSelector)) {
    throw new Error(`Template ${selector} did not contain ${elementSelector}.`);
  }
  return element;
}

/**
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {HTMLElement}
 */
export function queryRequired(root, selector) {
  const element = root.querySelector(selector);
  if (isElementNode(element)) return /** @type {HTMLElement} */ (element);
  throw new Error(`Required template node missing: ${selector}`);
}

/**
 * @param {string} id
 */
function templateSelector(id) {
  return id.startsWith('[') ? id : `[${id}]`;
}

/**
 * @param {Document} documentRef
 */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isElementNode(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}
