// @ts-check

const FORBIDDEN_ELEMENTS = new Set(['math', 'noscript', 'script', 'style', 'svg', 'template']);
const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

/**
 * Parses an HTML string into an inert `<body>` element using the single
 * DOMParser call this module owns (JS-008). The document is never scripted and
 * never adopted into the visible app DOM; callers only read the returned node.
 * Returns `null` for empty input.
 *
 * @param {string} htmlString
 * @returns {HTMLElement | null}
 */
export function htmlToInertBody(htmlString) {
  if (!htmlString) return null;
  return new DOMParser().parseFromString(htmlString, 'text/html').body;
}

/**
 * @param {string} value
 * @param {number} maxCodePoints
 */
export function htmlStringToPlainText(value, maxCodePoints) {
  if (!value) return '';
  return nodeToPlainText(htmlToInertBody(value), maxCodePoints);
}

/**
 * @param {Node | null | undefined} node
 * @param {number} maxCodePoints
 */
export function nodeToPlainText(node, maxCodePoints) {
  if (!node) return '';
  const state = { text: '' };
  walkNode(node, state);
  return limitPlainText(finalizePlainText(state.text), maxCodePoints);
}

/**
 * @param {Node} node
 * @param {{text: string}} state
 */
function walkNode(node, state) {
  if (node.nodeType === 3) {
    appendText(state, node.nodeValue ?? '');
    return;
  }
  if (node.nodeType !== 1) {
    for (const child of node.childNodes) walkNode(child, state);
    return;
  }
  const element = /** @type {Element} */ (node);
  const localName = element.localName.toLowerCase();
  if (FORBIDDEN_ELEMENTS.has(localName)) return;
  if (localName === 'br') {
    appendBreak(state, 1);
    return;
  }
  const isListItem = localName === 'li';
  const isBlock = BLOCK_ELEMENTS.has(localName);
  if (isBlock || isListItem) appendBreak(state, isListItem ? 1 : 2);
  for (const child of element.childNodes) walkNode(child, state);
  if (isBlock || isListItem) appendBreak(state, isListItem ? 1 : 2);
}

/**
 * @param {{text: string}} state
 * @param {string} value
 */
function appendText(state, value) {
  const collapsed = value.replace(/\s+/gu, ' ');
  if (!collapsed.trim()) {
    if (state.text && !/[ \n]$/u.test(state.text)) state.text += ' ';
    return;
  }
  let next = collapsed;
  if (!state.text || state.text.endsWith('\n')) next = next.trimStart();
  if (state.text.endsWith(' ') || state.text.endsWith('\n')) next = next.replace(/^ /u, '');
  state.text += next;
}

/**
 * @param {{text: string}} state
 * @param {1 | 2} count
 */
function appendBreak(state, count) {
  state.text = state.text.replace(/[ \t]+$/u, '');
  if (!state.text) return;
  const trailing = state.text.match(/\n+$/u)?.[0].length ?? 0;
  if (trailing < count) state.text += '\n'.repeat(count - trailing);
}

/**
 * @param {string} value
 */
function finalizePlainText(value) {
  return value
    .normalize('NFC')
    .replace(/[ \t]*\n[ \t]*/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/[ \t]+/gu, ' ')
    .trim();
}

/**
 * @param {string} value
 * @param {number} maxCodePoints
 */
function limitPlainText(value, maxCodePoints) {
  const codePoints = [...value];
  return codePoints.length > maxCodePoints ? codePoints.slice(0, maxCodePoints).join('').trim() : value;
}
