// @ts-check

import { MAX_TEXT_LENGTH } from '../domain/article-content-blocks.js';
import { takeSourceNode } from './content-sanitizer-context.js';

/** @typedef {import('../domain/article-content-blocks.js').Inline} Inline */
/** @typedef {import('./content-sanitizer-context.js').SanitizeContext} SanitizeContext */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const MAX_RAW_SLICE = MAX_TEXT_LENGTH * 2;

/** @param {Inline[]} out @param {string} rawValue @param {SanitizeContext} ctx */
export function appendInlineText(out, rawValue, ctx) {
  if (ctx.textBudget <= 0 || !rawValue) return;
  const bounded = rawValue.length > MAX_RAW_SLICE ? rawValue.slice(0, MAX_RAW_SLICE) : rawValue;
  const collapsed = bounded.replace(/\s+/gu, ' ');
  if (!collapsed) return;
  const text = takeText(collapsed, ctx);
  if (text) pushNode(out, { type: 'text', text }, ctx);
}

/** @param {string} value @param {SanitizeContext} ctx @returns {string} */
export function takeText(value, ctx) {
  if (ctx.textBudget <= 0 || !value) return '';
  const taken = boundedCodePoints(value, ctx.textBudget);
  ctx.textBudget -= taken.count;
  return taken.text;
}

/**
 * Concatenates text of a subtree, skipping dropped elements, bounded by the
 * remaining text budget and the shared source-node budget. Iterative so a
 * depth bomb cannot overflow the stack, and never enqueues beyond the budget.
 * @param {Node} root @param {SanitizeContext} ctx @param {ReadonlySet<string>} droppedTags @returns {string}
 */
export function collectBoundedText(root, ctx, droppedTags) {
  const limit = ctx.textBudget;
  if (limit <= 0) return '';
  /** @type {string[]} */
  const parts = [];
  let remaining = limit;
  /** @type {Node[]} */
  const stack = [];
  pushChildren(root);
  while (stack.length && remaining > 0) {
    const node = stack.pop();
    if (!node) break;
    if (node.nodeType === TEXT_NODE) {
      const taken = boundedCodePoints(node.nodeValue ?? '', remaining);
      if (taken.text) parts.push(taken.text);
      remaining -= taken.count;
    } else if (node.nodeType === ELEMENT_NODE && !droppedTags.has(localName(/** @type {Element} */ (node)))) {
      pushChildren(node);
    }
  }
  return parts.join('');

  /** @param {Node} parent */
  function pushChildren(parent) {
    const children = parent.childNodes;
    /** @type {Node[]} */
    const kept = [];
    for (let index = 0; index < children.length; index += 1) {
      if (!takeSourceNode(ctx)) break; // budget check BEFORE children[index]
      kept.push(children[index]);
    }
    for (let index = kept.length - 1; index >= 0; index -= 1) stack.push(kept[index]);
  }
}

/**
 * Takes at most `limit` Unicode code points after first bounding the UTF-16
 * input window. Lone surrogate units are replaced so no malformed string can
 * cross the sanitizer boundary.
 * @param {string} value @param {number} limit @returns {{count: number, text: string}}
 */
function boundedCodePoints(value, limit) {
  const window = value.length > limit * 2 ? value.slice(0, limit * 2) : value;
  /** @type {string[]} */
  const points = [];
  for (const point of window) {
    if (points.length >= limit) break;
    const unit = point.charCodeAt(0);
    points.push(point.length === 1 && unit >= 0xd800 && unit <= 0xdfff ? '\ufffd' : point);
  }
  return { count: points.length, text: points.join('') };
}

/**
 * Trims leading/trailing whitespace-only text nodes and edge breaks. Always
 * returns a fresh array so callers may safely reuse (and clear) the buffer.
 * @param {Inline[]} nodes @returns {Inline[]}
 */
export function finalizeInline(nodes) {
  const blank = (/** @type {Inline} */ n) => n.type === 'break' || (n.type === 'text' && n.text.trim() === '');
  let start = 0;
  let end = nodes.length;
  while (start < end && blank(nodes[start])) start += 1;
  while (end > start && blank(nodes[end - 1])) end -= 1;
  return nodes.slice(start, end);
}

/**
 * @template T
 * @param {T[]} out @param {T} node @param {SanitizeContext} ctx @returns {boolean}
 */
export function pushNode(out, node, ctx) {
  if (ctx.nodeBudget <= 0) return false;
  ctx.nodeBudget -= 1;
  out.push(node);
  return true;
}

/** @param {Element} el @returns {string} */
function localName(el) {
  return el.localName.toLowerCase();
}
