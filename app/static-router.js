// @ts-check

import { renderHelpView } from './help-view.js';

/**
 * @param {{documentRef: Document, browserApi: {i18n: {getMessage(key: string, substitutions?: string | string[]): string}, runtime: {getManifest(): {version?: string}}}, windowRef: Window}} options
 * @param {'help'} mode
 */
export function renderStaticView(options, mode) {
  const main = options.documentRef.querySelector('[data-static-main]');
  if (!isHtmlElement(main)) return;
  const signature = `${mode}|${options.documentRef.documentElement.lang}|${options.documentRef.documentElement.dir}`;
  if (main.dataset.staticRenderSignature === signature && main.querySelector('.help-document')) return;
  const getMessage = options.browserApi.i18n.getMessage;
  const node = renderHelpView(options.documentRef, getMessage);
  main.replaceChildren(node);
  main.dataset.staticRenderSignature = signature;
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}
