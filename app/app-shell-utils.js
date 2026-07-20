// @ts-check

/**
 * @param {unknown} value
 * @returns {value is 'reader' | 'settings' | 'help'}
 */
export function isAppMode(value) {
  return value === 'reader' || value === 'settings' || value === 'help';
}

/**
 * @param {unknown} value
 * @returns {value is 'compact' | 'normal' | 'large'}
 */
export function isArticleView(value) {
  return value === 'compact' || value === 'normal' || value === 'large';
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
export function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}

/**
 * @param {Document} documentRef
 * @param {unknown} value
 * @returns {value is HTMLButtonElement}
 */
export function isButtonElement(documentRef, value) {
  const view = documentRef.defaultView;
  return view !== null && value instanceof view.HTMLButtonElement;
}

/**
 * @param {string} language
 * @returns {'da' | 'en'}
 */
export function supportedLanguage(language) {
  return language.toLowerCase().startsWith('da') ? 'da' : 'en';
}
