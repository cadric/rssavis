// @ts-check

import { tryNormalizeHttpUrl } from '../domain/urls.js';
import { cloneTemplate, queryRequired } from './templates.js';

/** @type {WeakMap<Document, number>} */
const destinationSequence = new WeakMap();

/** @param {HTMLElement} wrapper @param {HTMLElement} tooltip */
function bindDestinationTooltip(wrapper, tooltip) {
  let pointerWithin = false;
  let focusWithin = false;
  const clearDismissalWhenInactive = () => {
    if (!pointerWithin && !focusWithin) wrapper.removeAttribute('data-destination-dismissed');
  };
  wrapper.addEventListener('pointerenter', () => {
    pointerWithin = true;
    positionDestinationTooltip(tooltip);
  });
  wrapper.addEventListener('pointerleave', () => {
    pointerWithin = false;
    clearDismissalWhenInactive();
  });
  wrapper.addEventListener('focusin', () => {
    focusWithin = true;
    positionDestinationTooltip(tooltip);
  });
  wrapper.addEventListener('focusout', (event) => {
    const view = wrapper.ownerDocument.defaultView;
    focusWithin = Boolean(view && event.relatedTarget instanceof view.Node && wrapper.contains(event.relatedTarget));
    clearDismissalWhenInactive();
  });
  wrapper.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    wrapper.setAttribute('data-destination-dismissed', '');
    event.preventDefault();
  });
}

/** @param {HTMLElement} tooltip */
function positionDestinationTooltip(tooltip) {
  const view = tooltip.ownerDocument.defaultView;
  if (!view || !Number.isFinite(view.innerWidth) || view.innerWidth <= 0) return;
  tooltip.style.setProperty('--rs-article-destination-translation', '0px');
  const rect = tooltip.getBoundingClientRect();
  const rootFontSize = Number.parseFloat(view.getComputedStyle(tooltip.ownerDocument.documentElement).fontSize);
  const margin = Number.isFinite(rootFontSize) && rootFontSize > 0 ? rootFontSize : 16;
  if (![rect.left, rect.right, rect.width].every(Number.isFinite)) return;
  const inlineEndTranslation = Math.min(0, view.innerWidth - margin - rect.right);
  const translation = Math.max(inlineEndTranslation, margin - rect.left);
  const clamped = Math.max(-view.innerWidth, Math.min(view.innerWidth, translation));
  tooltip.style.setProperty('--rs-article-destination-translation', `${Math.round(clamped * 100) / 100}px`);
}

/**
 * Wraps an article anchor with the shared, app-owned destination tooltip.
 * The validated external URL is descriptive text only; the anchor keeps its
 * internal SEC-004 bridge href.
 * @param {Document} documentRef
 * @param {HTMLAnchorElement} anchor
 * @param {string} destination
 * @returns {HTMLElement}
 */
export function wrapArticleDestination(documentRef, anchor, destination) {
  const safeDestination = tryNormalizeHttpUrl(destination);
  if (!safeDestination) return anchor;
  const wrapper = cloneTemplate(documentRef, 'data-article-destination-template', '[data-article-destination]');
  const slot = queryRequired(wrapper, '[data-article-destination-link-slot]');
  const tooltip = queryRequired(wrapper, '[data-article-destination-tooltip]');
  const label = queryRequired(documentRef, '[data-article-destination-label]').textContent?.trim() ?? '';
  const nextSequence = (destinationSequence.get(documentRef) ?? 0) + 1;
  destinationSequence.set(documentRef, nextSequence);
  tooltip.id = `article-destination-${nextSequence}`;
  tooltip.textContent = label ? `${label}: ${safeDestination}` : safeDestination;
  const describedBy = anchor.getAttribute('aria-describedby');
  anchor.setAttribute('aria-describedby', describedBy ? `${describedBy} ${tooltip.id}` : tooltip.id);
  const parent = anchor.parentNode;
  if (parent) parent.insertBefore(wrapper, anchor);
  slot.replaceWith(anchor);
  bindDestinationTooltip(wrapper, tooltip);
  return wrapper;
}
