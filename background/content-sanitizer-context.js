// @ts-check

import {
  MAX_BLOCK_NODES,
  MAX_CONTENT_SOURCE_NODES,
  MAX_RAW_URL_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_URL_LENGTH,
} from '../domain/article-content-blocks.js';
import { httpsOnlyUrl } from '../domain/urls.js';

/**
 * Shared sanitizer work-and-output budgets. `nodeBudget`/`textBudget` bound the
 * emitted model; `sourceNodeBudget` bounds how many parsed DOM nodes may even
 * be inspected, independently of what is emitted.
 *
 * @typedef {{
 *   baseUrl: string,
 *   nodeBudget: number,
 *   sourceNodeBudget: number,
 *   textBudget: number,
 *   resolveUrl: (el: Element, raw: string) => string,
 * }} SanitizeContext
 */

/**
 * @param {string} baseUrl
 * @param {(el: Element, raw: string) => string} [resolveUrl]
 * @returns {SanitizeContext}
 */
export function createSanitizeContext(baseUrl, resolveUrl) {
  return {
    baseUrl,
    nodeBudget: MAX_BLOCK_NODES,
    sourceNodeBudget: MAX_CONTENT_SOURCE_NODES,
    textBudget: MAX_TEXT_LENGTH,
    resolveUrl: resolveUrl ?? ((_element, raw) => httpsOnlyUrl(raw, baseUrl)),
  };
}

/**
 * Charges one parsed-DOM inspection. Callers must check this BEFORE reading
 * the next child/tag so even rejected nodes are bounded work.
 * @param {SanitizeContext} ctx
 * @returns {boolean}
 */
export function takeSourceNode(ctx) {
  if (ctx.sourceNodeBudget <= 0) return false;
  ctx.sourceNodeBudget -= 1;
  return true;
}

/**
 * Raw-work cap first, then per-node resolution, then https/length checks on
 * the NORMALIZED result (percent-encoding can grow a URL past the cap).
 * @param {Element} el @param {string} raw @param {SanitizeContext} ctx @returns {string}
 */
export function boundedResolvedUrl(el, raw, ctx) {
  if (!raw || raw.length > MAX_RAW_URL_LENGTH) return '';
  // Resolver output is still untrusted at this boundary: normalize/recheck it
  // so an injected/internal resolver can never bypass https-only.
  const url = httpsOnlyUrl(ctx.resolveUrl(el, raw));
  return url && url.length <= MAX_URL_LENGTH ? url : '';
}
