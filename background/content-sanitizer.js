// @ts-check

import { hasTextContent, MAX_BLOCK_DEPTH, validateContentBlocks } from '../domain/article-content-blocks.js';
import { boundedResolvedUrl, createSanitizeContext, takeSourceNode } from './content-sanitizer-context.js';
import { appendInlineText, collectBoundedText, finalizeInline, pushNode, takeText } from './content-sanitizer-text.js';

/** @typedef {import('../domain/article-content-blocks.js').Block} Block */
/** @typedef {import('../domain/article-content-blocks.js').Inline} Inline */
/** @typedef {import('./content-sanitizer-context.js').SanitizeContext} SanitizeContext */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

// Removed entirely (element and its text): executable, embedded, or foreign
// content. `svg`/`math` are foreign-content mutation-XSS vectors, so — matching
// the plain-text extractor's FORBIDDEN_ELEMENTS — their text is dropped too.
const DROPPED = new Set('script style noscript template svg math iframe object embed form'.split(' '));
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const CODE_TAGS = new Set(['code', 'kbd', 'samp']);
// Inline wrappers that carry no output node of their own: their children are
// flattened into the surrounding inline run.
const INLINE_TAGS = new Set(
  'span abbr cite q time var mark small sub sup u s strike ins del bdi bdo wbr dfn big tt font label ruby data output'.split(
    ' ',
  ),
);

/**
 * Converts an already-parsed, inert DOM node into an allowlisted `Block[]`.
 * Pure: no DOMParser, no HTML string, no innerHTML, no script eval, no I/O.
 * Never throws on pathological input — returns the best bounded model.
 * @param {Node | null | undefined} node
 * @param {string} [baseUrl]
 * @param {(el: Element, raw: string) => string} [resolveUrl] per-node URL resolver
 *   (Atom passes an xml:base-aware closure); defaults to resolving against baseUrl
 * @returns {Block[]}
 */
export function sanitizeContent(node, baseUrl = '', resolveUrl) {
  // Tests lock the validator pass as a no-op on the raw producer output.
  return validateContentBlocks(buildContentBlocks(node, baseUrl, resolveUrl));
}

/**
 * Raw producer output BEFORE the validator pass — exported for the round-trip
 * contract test only; production callers use sanitizeContent.
 * @param {Node | null | undefined} node @param {string} [baseUrl]
 * @param {(el: Element, raw: string) => string} [resolveUrl] @returns {Block[]}
 */
export function buildContentBlocks(node, baseUrl = '', resolveUrl) {
  if (!node) return [];
  /** @type {Block[]} */
  const out = [];
  const ctx = createSanitizeContext(baseUrl, resolveUrl);
  appendBlocks(node, out, ctx, 0);
  return out;
}

/**
 * Emits blocks from `parent`; `depth` is the output list depth (top = 0).
 * Lists at the maximum depth are conservatively dropped.
 * @param {Node} parent @param {Block[]} out @param {SanitizeContext} ctx @param {number} depth
 */
function appendBlocks(parent, out, ctx, depth) {
  if (ctx.nodeBudget <= 0 || ctx.sourceNodeBudget <= 0 || depth >= MAX_BLOCK_DEPTH) return;
  /** @type {Inline[]} */
  const pending = [];
  /** @type {Block[]} */
  const hoisted = [];
  const children = parent.childNodes;
  for (let index = 0; index < children.length; index += 1) {
    if (!takeSourceNode(ctx)) break; // budget check BEFORE children[index]
    const child = children[index];
    if (child.nodeType === TEXT_NODE) {
      appendInline(child, pending, ctx, depth + 1, hoisted, true);
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const el = /** @type {Element} */ (child);
    const tag = localName(el);
    if (DROPPED.has(tag)) continue;
    if (isInlineTag(tag) || tag === 'img') {
      appendInline(el, pending, ctx, depth + 1, hoisted, true);
      continue;
    }
    flushPending(out, pending, hoisted, ctx);
    emitBlockElement(tag, el, out, ctx, depth);
  }
  flushPending(out, pending, hoisted, ctx);
}

/** @param {string} tag @param {Element} el @param {Block[]} out @param {SanitizeContext} ctx @param {number} depth */
function emitBlockElement(tag, el, out, ctx, depth) {
  if (tag === 'p' || HEADINGS.has(tag)) return emitInlineBlock(tag, el, out, ctx, depth);
  if (tag === 'ul' || tag === 'ol') return emitList(el, tag === 'ol', out, ctx, depth);
  if (tag === 'blockquote') return emitBlockquote(el, out, ctx, depth);
  if (tag === 'pre') return emitPre(el, out, ctx);
  if (tag === 'figure') return emitFigure(el, out, ctx, depth);
  if (tag === 'hr') return void pushNode(out, { type: 'rule' }, ctx);
  // Unknown element (incl. tables): transparent block container — recurse at
  // the SAME model depth; only emitted containers consume depth.
  appendBlocks(el, out, ctx, depth);
}

/**
 * Shared p/h1..h6 path with inline-image hoisting and readable-text pruning.
 * @param {string} tag @param {Element} el @param {Block[]} out @param {SanitizeContext} ctx @param {number} depth
 */
function emitInlineBlock(tag, el, out, ctx, depth) {
  /** @type {Inline[]} */
  const inline = [];
  /** @type {Block[]} */
  const hoisted = [];
  appendInlineChildren(el, inline, ctx, depth + 1, hoisted);
  const children = finalizeInline(inline);
  if (children.length && hasTextContent(children)) {
    if (tag === 'p') pushNode(out, { type: 'paragraph', children }, ctx);
    else pushNode(out, { type: 'heading', level: headingLevel(tag), children }, ctx);
  }
  for (const block of hoisted) out.push(block);
}

/** @param {Block[]} out @param {Inline[]} inline @param {SanitizeContext} ctx */
function emitParagraph(out, inline, ctx) {
  const children = finalizeInline(inline);
  if (children.length && hasTextContent(children)) pushNode(out, { type: 'paragraph', children }, ctx);
}

/** @param {string} tag @returns {2 | 3 | 4} */
function headingLevel(tag) {
  if (tag === 'h1' || tag === 'h2') return 2;
  if (tag === 'h3') return 3;
  return 4;
}

/** @param {Element} el @param {boolean} ordered @param {Block[]} out @param {SanitizeContext} ctx @param {number} depth */
function emitList(el, ordered, out, ctx, depth) {
  /** @type {Inline[][]} */
  const items = [];
  /** @type {Block[]} */
  const hoisted = [];
  const children = el.childNodes;
  for (let index = 0; index < children.length; index += 1) {
    if (ctx.nodeBudget <= 0 || !takeSourceNode(ctx)) break;
    const child = children[index];
    if (child.nodeType !== ELEMENT_NODE) continue;
    const li = /** @type {Element} */ (child);
    if (localName(li) !== 'li') continue;
    /** @type {Inline[]} */
    const inline = [];
    appendInlineChildren(li, inline, ctx, depth + 1, hoisted);
    const item = finalizeInline(inline);
    if (item.length && hasTextContent(item)) items.push(item);
  }
  if (items.length) pushNode(out, { type: 'list', ordered, items }, ctx);
  for (const block of hoisted) out.push(block);
}

/** @param {Element} el @param {Block[]} out @param {SanitizeContext} ctx @param {number} depth */
function emitBlockquote(el, out, ctx, depth) {
  /** @type {Block[]} */
  const children = [];
  appendBlocks(el, children, ctx, depth + 1);
  if (children.length) pushNode(out, { type: 'blockquote', children }, ctx);
}

/** @param {Element} el @param {Block[]} out @param {SanitizeContext} ctx */
function emitPre(el, out, ctx) {
  const text = takeText(collectBoundedText(el, ctx, DROPPED), ctx);
  if (text.trim()) pushNode(out, { type: 'code', text }, ctx);
}

/** @param {Element} el @param {Block[]} out @param {SanitizeContext} ctx @param {number} depth */
function emitFigure(el, out, ctx, depth) {
  const scan = scanFigure(el, ctx);
  const primaryIndex = scan.images.findIndex((image) => image.src !== '');
  const beforeEnd = primaryIndex < 0 ? scan.images.length : primaryIndex;
  for (let index = 0; index < beforeEnd; index += 1) emitFigureAlt(out, scan.images[index].alt, ctx);
  if (primaryIndex < 0) {
    emitFigureCaptionText(scan.caption, out, ctx, depth);
    return;
  }
  const primary = scan.images[primaryIndex];
  const alt = takeText(primary.alt, ctx);
  /** @type {Inline[]} */
  const captionInline = [];
  // Captions never hoist: a caption image degrades to its alt text so it can
  // become neither the primary image nor a duplicate figure.
  if (scan.caption) appendInlineChildren(scan.caption, captionInline, ctx, depth + 1, null);
  const rawCaption = finalizeInline(captionInline);
  const caption = hasTextContent(rawCaption) ? rawCaption : [];
  /** @type {Block} */
  const node = caption.length
    ? { type: 'figure', src: primary.src, alt, caption }
    : { type: 'figure', src: primary.src, alt };
  pushNode(out, node, ctx);
  for (let index = primaryIndex + 1; index < scan.images.length; index += 1)
    emitFigureAlt(out, scan.images[index].alt, ctx);
}

/**
 * Scans non-caption figure descendants once in document order. Caption
 * descendants are handled later as inline caption text and never promoted.
 * @param {Element} figure @param {SanitizeContext} ctx
 * @returns {{caption: Element | null, images: Array<{src: string, alt: string}>}}
 */
function scanFigure(figure, ctx) {
  /** @type {Array<{src: string, alt: string}>} */
  const images = [];
  /** @type {Element | null} */
  let caption = null;
  /** @type {Element[]} */
  const stack = [];
  pushElementChildren(figure, stack, ctx);
  while (stack.length) {
    const el = stack.pop();
    if (!el) break;
    const tag = localName(el);
    if (DROPPED.has(tag)) continue;
    if (tag === 'figcaption') {
      caption ??= el;
      continue;
    }
    if (tag === 'img') {
      images.push({
        alt: el.getAttribute('alt') ?? '',
        src: boundedResolvedUrl(el, el.getAttribute('src') ?? '', ctx),
      });
      continue;
    }
    pushElementChildren(el, stack, ctx);
  }
  return { caption, images };
}

/** @param {Block[]} out @param {string} rawAlt @param {SanitizeContext} ctx */
function emitFigureAlt(out, rawAlt, ctx) {
  const alt = takeText(rawAlt, ctx);
  if (alt.trim()) pushAltParagraph(out, alt, ctx);
}

/** @param {Element | null} caption @param {Block[]} out @param {SanitizeContext} ctx @param {number} depth */
function emitFigureCaptionText(caption, out, ctx, depth) {
  if (!caption) return;
  /** @type {Inline[]} */
  const inline = [];
  appendInlineChildren(caption, inline, ctx, depth + 1, null);
  if (hasTextContent(inline)) emitParagraph(out, inline, ctx);
}

/**
 * Pushes children in document order, charging before each read.
 * @param {Node} parent @param {Element[]} stack @param {SanitizeContext} ctx
 */
function pushElementChildren(parent, stack, ctx) {
  const children = parent.childNodes;
  /** @type {Element[]} */
  const kept = [];
  for (let index = 0; index < children.length; index += 1) {
    if (!takeSourceNode(ctx)) break; // budget check BEFORE children[index]
    const child = children[index];
    if (child.nodeType === ELEMENT_NODE) kept.push(/** @type {Element} */ (child));
  }
  for (let index = kept.length - 1; index >= 0; index -= 1) stack.push(kept[index]);
}

/**
 * Emits inline nodes; `hoisted` receives sibling figures, while `null` makes
 * figcaption images degrade to alt text.
 * @param {Node} node @param {Inline[]} out @param {SanitizeContext} ctx
 * @param {number} depth @param {Block[] | null} hoisted @param {boolean} [alreadyVisited]
 */
function appendInline(node, out, ctx, depth, hoisted, alreadyVisited = false) {
  if (ctx.nodeBudget <= 0) return;
  if (!alreadyVisited && !takeSourceNode(ctx)) return;
  if (node.nodeType === TEXT_NODE) return appendInlineText(out, node.nodeValue ?? '', ctx);
  if (node.nodeType !== ELEMENT_NODE) return;
  const el = /** @type {Element} */ (node);
  const tag = localName(el);
  if (DROPPED.has(tag)) return;
  if (tag === 'br') return void pushNode(out, { type: 'break' }, ctx);
  if (tag === 'strong' || tag === 'b') return emitInlineContainer('strong', el, out, ctx, depth, hoisted);
  if (tag === 'em' || tag === 'i') return emitInlineContainer('em', el, out, ctx, depth, hoisted);
  if (CODE_TAGS.has(tag)) return emitInlineCode(el, out, ctx);
  if (tag === 'a') return emitLink(el, out, ctx, depth, hoisted);
  // The inline model has no image node, so hoist images as sibling figures
  // after the enclosing block.
  if (tag === 'img') {
    if (hoisted) return hoistImage(el, hoisted, ctx);
    return appendInlineText(out, el.getAttribute('alt') ?? '', ctx);
  }
  // span/unknown/block-in-inline: transparent — flatten children into the run.
  appendInlineChildren(el, out, ctx, depth, hoisted);
}

/** @param {Element} el @param {Inline[]} out @param {SanitizeContext} ctx @param {number} depth @param {Block[] | null} hoisted */
function appendInlineChildren(el, out, ctx, depth, hoisted) {
  if (depth > MAX_BLOCK_DEPTH) {
    appendInlineText(out, collectBoundedText(el, ctx, DROPPED), ctx);
    return;
  }
  const children = el.childNodes;
  for (let index = 0; index < children.length; index += 1) {
    if (!takeSourceNode(ctx)) break; // budget check BEFORE children[index]
    appendInline(children[index], out, ctx, depth, hoisted, true);
  }
}

/** @param {'strong' | 'em'} type @param {Element} el @param {Inline[]} out @param {SanitizeContext} ctx @param {number} depth @param {Block[] | null} hoisted */
function emitInlineContainer(type, el, out, ctx, depth, hoisted) {
  // A container at depth 8 would put its child list at depth 9: flatten.
  if (depth >= MAX_BLOCK_DEPTH) return appendInlineText(out, collectBoundedText(el, ctx, DROPPED), ctx);
  /** @type {Inline[]} */
  const kids = [];
  appendInlineChildren(el, kids, ctx, depth + 1, hoisted);
  const children = finalizeInline(kids);
  if (!children.length) return;
  /** @type {Inline} */
  const node = type === 'strong' ? { type: 'strong', children } : { type: 'em', children };
  pushNode(out, node, ctx);
}

/** @param {Element} el @param {Inline[]} out @param {SanitizeContext} ctx */
function emitInlineCode(el, out, ctx) {
  const text = takeText(collectBoundedText(el, ctx, DROPPED), ctx);
  if (text.trim()) pushNode(out, { type: 'code', text }, ctx);
}

/** @param {Element} el @param {Inline[]} out @param {SanitizeContext} ctx @param {number} depth @param {Block[] | null} hoisted */
function emitLink(el, out, ctx, depth, hoisted) {
  if (depth >= MAX_BLOCK_DEPTH) return appendInlineText(out, collectBoundedText(el, ctx, DROPPED), ctx);
  /** @type {Inline[]} */
  const kids = [];
  appendInlineChildren(el, kids, ctx, depth + 1, hoisted);
  const children = finalizeInline(kids);
  const href = boundedResolvedUrl(el, el.getAttribute('href') ?? '', ctx);
  if (href && hasTextContent(children)) {
    pushNode(out, { type: 'link', href, children }, ctx);
    return;
  }
  // Non-https href or no readable text: drop the wrapper, keep its children.
  for (const child of children) out.push(child);
}

/** @param {Element} el @param {Block[]} hoisted @param {SanitizeContext} ctx */
function hoistImage(el, hoisted, ctx) {
  const src = boundedResolvedUrl(el, el.getAttribute('src') ?? '', ctx);
  const alt = takeText(el.getAttribute('alt') ?? '', ctx);
  if (src) return void pushNode(hoisted, { type: 'figure', src, alt }, ctx);
  if (alt.trim()) pushAltParagraph(hoisted, alt, ctx);
}

/**
 * Reserves both the paragraph and text node before emitting either.
 * @param {Block[]} out @param {string} alt @param {SanitizeContext} ctx
 */
function pushAltParagraph(out, alt, ctx) {
  if (ctx.nodeBudget < 2) return;
  ctx.nodeBudget -= 2;
  out.push({ type: 'paragraph', children: [{ type: 'text', text: alt }] });
}

/**
 * Hoisted blocks were already counted against the node budget at hoist time —
 * they are not re-counted when drained here.
 * @param {Block[]} out @param {Inline[]} pending @param {Block[]} hoisted @param {SanitizeContext} ctx
 */
function flushPending(out, pending, hoisted, ctx) {
  if (pending.length) emitParagraph(out, pending, ctx);
  pending.length = 0;
  for (const block of hoisted) out.push(block);
  hoisted.length = 0;
}

/** @param {string} tag @returns {boolean} */
function isInlineTag(tag) {
  if (tag === 'strong' || tag === 'b' || tag === 'em' || tag === 'i' || tag === 'a' || tag === 'br') return true;
  return CODE_TAGS.has(tag) || INLINE_TAGS.has(tag);
}

/** @param {Element} el @returns {string} */
function localName(el) {
  return el.localName.toLowerCase();
}
