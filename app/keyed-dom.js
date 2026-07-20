// @ts-check

/**
 * Reuses keyed direct children, updates them in place, and only inserts,
 * moves or removes nodes when the ordered key set actually changes.
 * @template T
 * @param {HTMLElement} parent
 * @param {T[]} desired
 * @param {(node: HTMLElement) => string} nodeKey
 * @param {(item: T) => string} itemKey
 * @param {(item: T) => HTMLElement} create
 * @param {(node: HTMLElement, item: T) => void} update
 */
export function reconcileKeyedChildren(parent, desired, nodeKey, itemKey, create, update) {
  const existing = new Map();
  for (const child of parent.children) {
    if (isHtmlElement(child)) {
      const key = nodeKey(child);
      if (key) existing.set(key, child);
    }
  }
  const retained = new Set();
  for (let index = 0; index < desired.length; index += 1) {
    const item = desired[index];
    const key = itemKey(item);
    const node = existing.get(key) ?? create(item);
    retained.add(node);
    update(node, item);
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null);
  }
  for (const child of [...parent.children]) {
    if (isHtmlElement(child) && !retained.has(child)) child.remove();
  }
}

/** @param {Element} element @param {string} name @param {string} value */
export function setAttributeIfChanged(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** @param {HTMLElement} element @param {boolean} hidden */
export function setHiddenIfChanged(element, hidden) {
  if (element.hidden !== hidden) element.hidden = hidden;
}

/** @param {unknown} value @returns {value is HTMLElement} */
function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}
