// @ts-check

import { httpsOnlyUrl } from './urls.js';

/**
 * Maximum block+inline nesting the article model may carry. Beyond it the
 * sanitizer flattens deeper content to text and the read-side validator drops
 * deeper nodes. Shared so producer and validator agree on the bound.
 */
export const MAX_BLOCK_DEPTH = 8;

/** Maximum number of emitted block/inline nodes across the whole model. */
export const MAX_BLOCK_NODES = 4000;

/** Maximum characters a NORMALIZED image/link URL may carry. */
export const MAX_URL_LENGTH = 2048;

/** Maximum raw URL UTF-16 code units accepted before normalization work. */
export const MAX_RAW_URL_LENGTH = 8192;

/** Shared total text budget (code points) across text/code/alt — mirrors TEXT_LIMITS.body. */
export const MAX_TEXT_LENGTH = 32768;

/** Maximum parsed-XHTML DOM nodes inspected by the producer. */
export const MAX_CONTENT_SOURCE_NODES = 4000;

/** Maximum untrusted block/inline/list-item candidates inspected on read. */
export const MAX_VALIDATOR_CANDIDATE_VISITS = 8000;

/**
 * @typedef {{type: 'text', text: string}
 *   | {type: 'strong', children: Inline[]}
 *   | {type: 'em', children: Inline[]}
 *   | {type: 'link', href: string, children: Inline[]}
 *   | {type: 'code', text: string}
 *   | {type: 'break'}} Inline
 */

/**
 * @typedef {{type: 'paragraph', children: Inline[]}
 *   | {type: 'heading', level: 2 | 3 | 4, children: Inline[]}
 *   | {type: 'list', ordered: boolean, items: Inline[][]}
 *   | {type: 'blockquote', children: Block[]}
 *   | {type: 'code', text: string}
 *   | {type: 'figure', src: string, alt: string, caption?: Inline[]}
 *   | {type: 'rule'}} Block
 */

/**
 * @typedef {{remaining: number, visitsRemaining: number, textRemaining: number}} Budget
 */

/**
 * Read-side defensive re-validation of an untrusted `Block[]` (e.g. loaded from
 * IndexedDB or received over a message channel). Rebuilds each node from only
 * the allowlisted fields, dropping anything malformed, off-allowlist, deeper
 * than {@link MAX_BLOCK_DEPTH}, or beyond {@link MAX_BLOCK_NODES}. Candidate
 * reads, total text, and URL work are bounded by the shared budgets. Pure;
 * never throws; returns `[]` for a non-array.
 *
 * @param {unknown} value
 * @returns {Block[]}
 */
export function validateContentBlocks(value) {
  if (!Array.isArray(value)) return [];
  return validateBlocks(value, 0, {
    remaining: MAX_BLOCK_NODES,
    visitsRemaining: MAX_VALIDATOR_CANDIDATE_VISITS,
    textRemaining: MAX_TEXT_LENGTH,
  });
}

/**
 * True when the inline run carries readable text (a link or paragraph of only
 * line breaks has no accessible name / visible content).
 * @param {Inline[]} nodes
 * @returns {boolean}
 */
export function hasTextContent(nodes) {
  return nodes.some((node) => {
    if (node.type === 'text' || node.type === 'code') return node.text.trim() !== '';
    if (node.type === 'strong' || node.type === 'em' || node.type === 'link') return hasTextContent(node.children);
    return false;
  });
}

/**
 * @param {unknown[]} items
 * @param {number} depth
 * @param {Budget} budget
 * @returns {Block[]}
 */
function validateBlocks(items, depth, budget) {
  /** @type {Block[]} */
  const out = [];
  if (depth > MAX_BLOCK_DEPTH) return out;
  for (let index = 0; index < items.length; index += 1) {
    // Budget checks BEFORE items[index]: even reading an attacker-controlled
    // candidate is bounded work, and malformed candidates are not free.
    if (budget.remaining <= 0 || budget.visitsRemaining <= 0) break;
    budget.visitsRemaining -= 1;
    const block = validateBlock(items[index], depth, budget);
    if (block) out.push(block);
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @param {Budget} budget
 * @returns {Block | null}
 */
function validateBlock(value, depth, budget) {
  const node = asRecord(value);
  if (!node) return null;
  switch (node.type) {
    case 'paragraph': {
      const children = validateInlineList(node.children, depth + 1, budget);
      return children.length && hasTextContent(children) ? spend(budget, { type: 'paragraph', children }) : null;
    }
    case 'heading': {
      if (node.level !== 2 && node.level !== 3 && node.level !== 4) return null;
      const children = validateInlineList(node.children, depth + 1, budget);
      return children.length && hasTextContent(children)
        ? spend(budget, { type: 'heading', level: node.level, children })
        : null;
    }
    case 'list': {
      if (typeof node.ordered !== 'boolean' || !Array.isArray(node.items)) return null;
      /** @type {Inline[][]} */
      const items = [];
      const rawItems = node.items;
      for (let index = 0; index < rawItems.length; index += 1) {
        // A list-item array is itself an untrusted candidate: one visit each,
        // checked before rawItems[index] is read (never .map over it all).
        if (budget.remaining <= 0 || budget.visitsRemaining <= 0) break;
        budget.visitsRemaining -= 1;
        const item = validateInlineList(rawItems[index], depth + 1, budget);
        if (hasTextContent(item)) items.push(item);
      }
      return items.length ? spend(budget, { type: 'list', ordered: node.ordered, items }) : null;
    }
    case 'blockquote': {
      if (!Array.isArray(node.children)) return null;
      const children = validateBlocks(node.children, depth + 1, budget);
      return children.length ? spend(budget, { type: 'blockquote', children }) : null;
    }
    case 'code': {
      const text = takeBoundedText(node.text, budget);
      return text !== null && text.length > 0 ? spend(budget, { type: 'code', text }) : null;
    }
    case 'figure': {
      const src = boundedUrl(node.src);
      if (!src) return null;
      const alt = takeBoundedText(node.alt, budget) ?? '';
      const rawCaption = Array.isArray(node.caption) ? validateInlineList(node.caption, depth + 1, budget) : [];
      const caption = hasTextContent(rawCaption) ? rawCaption : [];
      return spend(budget, caption.length ? { type: 'figure', src, alt, caption } : { type: 'figure', src, alt });
    }
    case 'rule':
      return spend(budget, { type: 'rule' });
    default:
      return null;
  }
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @param {Budget} budget
 * @returns {Inline[]}
 */
function validateInlineList(value, depth, budget) {
  /** @type {Inline[]} */
  const out = [];
  if (!Array.isArray(value) || depth > MAX_BLOCK_DEPTH) return out;
  for (let index = 0; index < value.length; index += 1) {
    if (budget.remaining <= 0 || budget.visitsRemaining <= 0) break;
    budget.visitsRemaining -= 1;
    const inline = validateInline(value[index], depth, budget);
    if (inline) out.push(inline);
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @param {Budget} budget
 * @returns {Inline | null}
 */
function validateInline(value, depth, budget) {
  const node = asRecord(value);
  if (!node) return null;
  switch (node.type) {
    case 'text':
    case 'code': {
      const text = takeBoundedText(node.text, budget);
      return text !== null && text.length > 0 ? spend(budget, { type: node.type, text }) : null;
    }
    case 'break':
      return spend(budget, { type: 'break' });
    case 'strong':
    case 'em': {
      const children = validateInlineList(node.children, depth + 1, budget);
      return children.length ? spend(budget, { type: node.type, children }) : null;
    }
    case 'link': {
      const href = boundedUrl(node.href);
      if (!href) return null;
      const children = validateInlineList(node.children, depth + 1, budget);
      return children.length && hasTextContent(children) ? spend(budget, { type: 'link', href, children }) : null;
    }
    default:
      return null;
  }
}

/**
 * @template {Block | Inline} T
 * @param {Budget} budget
 * @param {T} node
 * @returns {T | null}
 */
function spend(budget, node) {
  if (budget.remaining <= 0) return null;
  budget.remaining -= 1;
  return node;
}

/**
 * Takes up to the remaining shared text budget from `value`.
 * @param {unknown} value
 * @param {Budget} budget
 * @returns {string | null} null for non-strings; '' when the budget is spent
 */
function takeBoundedText(value, budget) {
  if (typeof value !== 'string') return null;
  if (budget.textRemaining <= 0) return '';
  // At most two UTF-16 code units per code point: bound allocation before
  // spreading an untrusted persisted string.
  const window = value.length > budget.textRemaining * 2 ? value.slice(0, budget.textRemaining * 2) : value;
  const points = [...window];
  const taken = points.length > budget.textRemaining ? points.slice(0, budget.textRemaining) : points;
  budget.textRemaining -= taken.length;
  return taken.join('');
}

/**
 * Normalizes first, then length-checks: percent-encoding can grow a URL past
 * the cap even when the raw value is under it.
 * @param {unknown} value
 * @returns {string}
 */
function boundedUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_RAW_URL_LENGTH) return '';
  const url = httpsOnlyUrl(value);
  return url && url.length <= MAX_URL_LENGTH ? url : '';
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}
