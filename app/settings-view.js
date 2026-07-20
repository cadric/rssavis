// @ts-check

import { renderCategoriesSection } from './category-list-view.js';
import { renderFeedsSection } from './feed-list-view.js';
import { renderImportSection } from './opml-view.js';
import {
  renderAppearanceSection,
  renderGeneralSection,
  renderReadingSection,
  renderStorageSection,
} from './settings-sections.js';

const DYNAMIC_SECTIONS = new Set(['appearance', 'general', 'reading', 'feeds', 'categories', 'storage', 'import']);
/** @type {WeakMap<HTMLElement, string>} */
const renderSignatures = new WeakMap();

/**
 * @typedef {object} SettingsFocusTarget
 * @property {number} controlIndex
 * @property {string} relativeSelector
 * @property {number} rowIndex
 * @property {string} rowSelector
 * @property {string} selector
 */

/**
 * @param {Document} documentRef
 * @param {{activeSettingsSection: string}} state
 * @param {{categories: Array<Record<string, unknown>>, deletingFeeds?: Array<Record<string, unknown>>, feeds: Array<Record<string, unknown>>}} snapshot
 * @param {{getMessage(key: string, substitutions?: string | number | Array<string | number>): string, formatDate?(value: number | Date): string, formatNumber?(value: number): string}} i18n
 */
export function renderSettingsView(documentRef, state, snapshot, i18n) {
  for (const link of documentRef.querySelectorAll('[data-settings-section-link]')) {
    const selected = link.getAttribute('data-settings-section-link') === state.activeSettingsSection;
    link.setAttribute('aria-current', selected ? 'page' : 'false');
  }
  const appearance = documentRef.querySelector('[data-settings-appearance-section]');
  const dynamic = documentRef.querySelector('[data-settings-management-section]');
  if (!isHtmlElement(documentRef, appearance) || !isHtmlElement(documentRef, dynamic)) return;
  const showDynamic = DYNAMIC_SECTIONS.has(state.activeSettingsSection);
  setAppearanceHeading(appearance, showDynamic);
  appearance.hidden = showDynamic;
  dynamic.hidden = !showDynamic;
  if (!showDynamic) {
    if (dynamic.childElementCount > 0) dynamic.replaceChildren();
    renderSignatures.delete(dynamic);
    return;
  }
  const signature = settingsRenderSignature(documentRef, state.activeSettingsSection, snapshot);
  if (renderSignatures.get(dynamic) === signature && dynamic.childElementCount > 0) return;
  const active = documentRef.activeElement;
  const focusTarget =
    isHtmlElement(documentRef, active) && dynamic.contains(active) ? captureSettingsFocus(dynamic, active) : null;
  dynamic.replaceChildren(renderDynamicSection(documentRef, state.activeSettingsSection, snapshot, i18n));
  renderSignatures.set(dynamic, signature);
  restoreSettingsFocus(documentRef, dynamic, state.activeSettingsSection, focusTarget);
}

/** @param {HTMLElement} dynamic @param {HTMLElement} active @returns {SettingsFocusTarget | null} */
function captureSettingsFocus(dynamic, active) {
  const selector = settingsFocusSelector(active);
  if (!selector) return null;
  const row = active.closest('[data-feed-row], [data-category-row]');
  const rowSelector = row?.matches('[data-feed-row]')
    ? '[data-feed-row]'
    : row?.matches('[data-category-row]')
      ? '[data-category-row]'
      : '';
  const rows = rowSelector ? [...dynamic.querySelectorAll(rowSelector)] : [];
  const controls = isHtmlElement(dynamic.ownerDocument, row) ? settingsFocusableControls(row) : [];
  return {
    controlIndex: Math.max(0, controls.indexOf(active)),
    relativeSelector: settingsFocusRelativeSelector(active),
    rowIndex: Math.max(0, row ? rows.indexOf(row) : 0),
    rowSelector,
    selector,
  };
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} dynamic
 * @param {string} section
 * @param {SettingsFocusTarget | null} target
 */
function restoreSettingsFocus(documentRef, dynamic, section, target) {
  if (!target) return;
  if (focusSettingsCandidate(documentRef, dynamic.querySelector(target.selector))) return;
  if (target.rowSelector) {
    const rows = [...dynamic.querySelectorAll(target.rowSelector)];
    const row = rows[Math.min(target.rowIndex, rows.length - 1)] ?? null;
    if (row) {
      if (target.relativeSelector && focusSettingsCandidate(documentRef, row.querySelector(target.relativeSelector)))
        return;
      const controls = settingsFocusableControls(row);
      if (focusSettingsCandidate(documentRef, controls[Math.min(target.controlIndex, controls.length - 1)] ?? null))
        return;
    }
  }
  if (focusSettingsCandidate(documentRef, dynamic.querySelector('[data-settings-management-title]'))) return;
  const sectionLink = documentRef.querySelector(`[data-settings-section-link="${cssEscape(section)}"]`);
  if (focusSettingsCandidate(documentRef, sectionLink)) return;
  focusSettingsCandidate(documentRef, documentRef.querySelector('[data-settings-main]'));
}

/** @param {HTMLElement} active */
function settingsFocusSelector(active) {
  if (active.id) return `#${cssEscape(active.id)}`;
  const feedRow = active.closest('[data-feed-row][data-feed-id]');
  const feedId = feedRow?.getAttribute('data-feed-id') ?? '';
  if (feedId && active.hasAttribute('data-feed-grip'))
    return `[data-feed-row][data-feed-id="${cssEscape(feedId)}"] [data-feed-grip]`;
  if (feedId && active.hasAttribute('data-feed-menu-trigger'))
    return `[data-feed-row][data-feed-id="${cssEscape(feedId)}"] [data-feed-menu-trigger]`;
  const categoryRow = active.closest('[data-category-row][data-category-id]');
  const categoryId = categoryRow?.getAttribute('data-category-id') ?? '';
  if (categoryId && active.hasAttribute('data-category-grip'))
    return `[data-category-row][data-category-id="${cssEscape(categoryId)}"] [data-category-grip]`;
  const categoryAction = active.getAttribute('data-category-action') ?? '';
  if (categoryId && categoryAction)
    return `[data-category-row][data-category-id="${cssEscape(categoryId)}"] [data-category-action="${cssEscape(categoryAction)}"]`;
  if (categoryAction) return `[data-category-action="${cssEscape(categoryAction)}"]`;
  return '';
}

/** @param {HTMLElement} active */
function settingsFocusRelativeSelector(active) {
  if (active.closest('[data-feed-row]') && active.hasAttribute('data-feed-grip')) return '[data-feed-grip]';
  if (active.closest('[data-feed-row]') && active.hasAttribute('data-feed-menu-trigger'))
    return '[data-feed-menu-trigger]';
  if (active.closest('[data-category-row]') && active.hasAttribute('data-category-grip')) return '[data-category-grip]';
  const categoryAction = active.getAttribute('data-category-action') ?? '';
  return categoryAction ? `[data-category-action="${cssEscape(categoryAction)}"]` : '';
}

/** @param {Element} root */
function settingsFocusableControls(root) {
  return [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')].filter((element) =>
    isSettingsFocusable(root.ownerDocument, element),
  );
}

/** @param {Document} documentRef @param {Element | null | undefined} target */
function focusSettingsCandidate(documentRef, target) {
  if (!isSettingsFocusable(documentRef, target)) return false;
  target.focus();
  return documentRef.activeElement === target;
}

/** @param {Document} documentRef @param {Element | null | undefined} target @returns {target is HTMLElement} */
function isSettingsFocusable(documentRef, target) {
  if (!isHtmlElement(documentRef, target) || !target.isConnected) return false;
  if (target.hidden || target.closest('[hidden], [aria-hidden="true"]') || target.matches(':disabled')) return false;
  const style = requireView(documentRef).getComputedStyle(target);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/** @param {string} value */
function cssEscape(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/**
 * @param {Document} documentRef
 * @param {string} section
 * @param {{categories: Array<Record<string, unknown>>, defaultCategoryId?: string, deletingFeeds?: Array<Record<string, unknown>>, feeds: Array<Record<string, unknown>>}} snapshot
 */
function settingsRenderSignature(documentRef, section, snapshot) {
  const locale = `${documentRef.documentElement.lang}|${documentRef.documentElement.dir}`;
  if (section === 'feeds')
    return `${section}|${locale}|${JSON.stringify(snapshot.feeds)}|${JSON.stringify(snapshot.deletingFeeds ?? [])}`;
  if (section === 'categories') {
    return `${section}|${locale}|${snapshot.defaultCategoryId ?? ''}|${JSON.stringify(snapshot.categories)}|${JSON.stringify(snapshot.feeds)}`;
  }
  return `${section}|${locale}`;
}

/**
 * @param {Document} documentRef
 * @param {string} key
 * @param {{categories: Array<Record<string, unknown>>, deletingFeeds?: Array<Record<string, unknown>>, feeds: Array<Record<string, unknown>>}} snapshot
 * @param {{getMessage(key: string, substitutions?: string | number | Array<string | number>): string, formatDate?(value: number | Date): string, formatNumber?(value: number): string}} i18n
 */
function renderDynamicSection(documentRef, key, snapshot, i18n) {
  const getMessage = i18n.getMessage;
  if (key === 'appearance') return renderAppearanceSection(documentRef, getMessage);
  if (key === 'general') return renderGeneralSection(documentRef, getMessage);
  if (key === 'reading') return renderReadingSection(documentRef, getMessage);
  if (key === 'feeds') return renderFeedsSection(documentRef, snapshot, i18n);
  if (key === 'categories') return renderCategoriesSection(documentRef, snapshot, i18n);
  if (key === 'storage') return renderStorageSection(documentRef, getMessage);
  return renderImportSection(documentRef, getMessage);
}

/**
 * @param {Element} appearance
 * @param {boolean} showDynamic
 */
function setAppearanceHeading(appearance, showDynamic) {
  const heading = appearance.querySelector('h2');
  if (!heading) return;
  if (showDynamic) heading.removeAttribute('id');
  else heading.id = 'settings-main-title';
}

/**
 * @param {Document} documentRef
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(documentRef, value) {
  return value instanceof requireView(documentRef).HTMLElement;
}

/**
 * @param {Document} documentRef
 */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}
