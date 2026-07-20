// @ts-check

/**
 * @param {ParentNode} root
 * @param {string} selector
 * @param {{accessible: string, visible: string}} count
 */
export function setSidebarCount(root, selector, count) {
  const element = root.querySelector(selector);
  if (!element) return;
  setSidebarTextContent(element, count.visible);
  setSidebarAttribute(element, 'aria-hidden', 'true');
}

/** @param {HTMLButtonElement} button @param {string} label @param {{accessible: string}} count */
export function setSidebarButtonLabel(button, label, count) {
  setSidebarAttribute(button, 'aria-label', [label, count.accessible].filter(Boolean).join(' '));
}

/** @param {ParentNode} root @param {string} selector @param {string} text */
export function setSidebarText(root, selector, text) {
  const element = root.querySelector(selector);
  if (element) setSidebarTextContent(element, text);
}

/** @param {Element} element @param {string} name @param {string} value */
export function setSidebarAttribute(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** @param {Element} element @param {string} name */
export function removeSidebarAttribute(element, name) {
  if (element.hasAttribute(name)) element.removeAttribute(name);
}

/** @param {HTMLElement} element @param {boolean} hidden */
export function setSidebarHidden(element, hidden) {
  if (element.hidden !== hidden) element.hidden = hidden;
}

/** @param {Node} node @param {string} text */
function setSidebarTextContent(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/** @param {unknown} value */
export function sidebarString(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {{getMessage(key: string, substitutions?: string | number | Array<string | number>): string, formatNumber?(value: number): string}} i18n
 * @param {string} key
 * @param {string} phraseKey
 * @param {number} count
 */
export function formatSidebarCount(i18n, key, phraseKey, count) {
  if (count <= 0) return { accessible: '', visible: '' };
  const short = i18n.getMessage(key, count);
  const visible = i18n.formatNumber?.(count) ?? (numericPrefix(short) || new Intl.NumberFormat().format(count));
  const accessible = i18n.getMessage(phraseKey, count);
  return { accessible: accessible === phraseKey ? short : accessible, visible };
}

/** @param {string} value */
function numericPrefix(value) {
  return value.match(/^[\d.,\s]+/u)?.[0].trim() ?? '';
}

/**
 * @param {{getMessage(key: string, substitutions?: string | number | Array<string | number>): string, formatNumber?(value: number): string} | ((key: string, substitutions?: string | number | Array<string | number>) => string)} i18n
 */
export function normalizeSidebarI18n(i18n) {
  return typeof i18n === 'function' ? { getMessage: i18n } : i18n;
}

/** @param {Document} documentRef @param {string} selector */
export function requireSidebarElement(documentRef, selector) {
  const view = requireView(documentRef);
  const element = documentRef.querySelector(selector);
  if (element instanceof view.HTMLElement) return element;
  throw new Error(`RSSavis sidebar node missing: ${selector}`);
}

/** @param {Document} documentRef @param {unknown} value @returns {value is HTMLElement} */
export function isSidebarHtmlElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLElement;
}

/** @param {Document} documentRef @param {unknown} value @returns {value is HTMLButtonElement} */
export function isSidebarButtonElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLButtonElement;
}

/** @param {Document} documentRef */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}
