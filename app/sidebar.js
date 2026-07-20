// @ts-check

import { scopeToStorageKey } from '../domain/scopes.js';
import { displayTitle } from '../domain/feed-title.js';
import { applyFeedIcon } from './feed-icons.js';
import { reconcileKeyedChildren } from './keyed-dom.js';
import { DEFAULT_READER_SETTINGS } from './reader-settings.js';
import { scopeCountDescriptor } from './scope-count.js';
import {
  formatSidebarCount as formatCount,
  isSidebarButtonElement as isButtonElement,
  isSidebarHtmlElement as isHtmlElement,
  normalizeSidebarI18n as normalizeI18n,
  removeSidebarAttribute as removeAttribute,
  requireSidebarElement as requireElement,
  setSidebarAttribute as setAttribute,
  setSidebarButtonLabel as setButtonLabel,
  setSidebarCount as setCount,
  setSidebarHidden as setHidden,
  setSidebarText as setText,
  sidebarString as stringValue,
} from './sidebar-render-utils.js';
import { cloneTemplate } from './templates.js';

const SYSTEM_SCOPES = Object.freeze([
  {
    icon: 'all',
    key: 'scopeAll',
    scope: Object.freeze({ type: 'system', id: 'all' }),
  },
  {
    icon: 'unread',
    key: 'scopeUnread',
    scope: Object.freeze({ type: 'system', id: 'unread' }),
  },
  {
    icon: 'starred',
    key: 'scopeStarred',
    scope: Object.freeze({ type: 'system', id: 'starred' }),
  },
  {
    icon: 'main',
    key: 'scopeMain',
    scope: Object.freeze({ type: 'system', id: 'main' }),
  },
]);

/**
 * @typedef {object} SidebarSnapshot
 * @property {Array<Record<string, unknown>>} categories
 * @property {Array<Record<string, unknown>>} feeds
 * @property {{all?: Record<string, unknown>, main?: Record<string, unknown>}} systemStats
 *
 * @typedef {object} SidebarI18n
 * @property {(key: string, substitutions?: string | number | Array<string | number>) => string} getMessage
 * @property {(value: number) => string} [formatNumber]
 *
 * @typedef {object} SidebarCount
 * @property {string} accessible
 * @property {string} visible
 */

/**
 * @param {Document} documentRef
 * @param {{activeScope: import('../domain/scopes.js').Scope, categoryCollapsed: Record<string, boolean>}} state
 * @param {SidebarSnapshot} snapshot
 * @param {SidebarI18n | ((key: string, substitutions?: string | number | Array<string | number>) => string)} i18n
 * @param {import('./reader-settings.js').ReaderSettings} [settings]
 */
export function renderSidebar(documentRef, state, snapshot, i18n, settings = DEFAULT_READER_SETTINGS) {
  const messages = normalizeI18n(i18n);
  const activeKey = scopeToStorageKey(state.activeScope);
  const focus = captureSidebarFocus(documentRef);
  renderSystemScopes(documentRef, state, snapshot, messages, activeKey);
  renderCategories(documentRef, state, snapshot, messages, settings, activeKey);
  restoreSidebarFocus(documentRef, focus, activeKey);
}

/** @param {Document} documentRef */
function captureSidebarFocus(documentRef) {
  const active = documentRef.activeElement;
  if (!isHtmlElement(documentRef, active) || !active.closest('[data-reader-sidebar]')) return null;
  const owner = active.closest('[data-scope-key], [data-category-key]');
  if (!isHtmlElement(documentRef, owner)) return null;
  return {
    element: active,
    key: owner.getAttribute('data-scope-key') ?? owner.getAttribute('data-category-key') ?? '',
  };
}

/**
 * @param {Document} documentRef
 * @param {{element: HTMLElement, key: string} | null} focus
 * @param {string} activeKey
 */
function restoreSidebarFocus(documentRef, focus, activeKey) {
  if (!focus || focus.element.isConnected) return;
  const candidates = [...documentRef.querySelectorAll('[data-reader-sidebar] [data-scope-key]')].filter((element) =>
    isHtmlElement(documentRef, element),
  );
  const target =
    candidates.find((element) => element.dataset.scopeKey === focus.key) ??
    candidates.find((element) => element.dataset.scopeKey === activeKey) ??
    candidates.find((element) => element.dataset.scopeKey === 'system:unread') ??
    null;
  target?.focus();
}

/**
 * @param {Document} documentRef
 * @param {{categoryCollapsed: Record<string, boolean>}} state
 * @param {SidebarSnapshot} snapshot
 * @param {SidebarI18n} i18n
 * @param {string} activeKey
 */
function renderSystemScopes(documentRef, state, snapshot, i18n, activeKey) {
  void state;
  const list = requireElement(documentRef, '[data-system-scope-list]');
  reconcileKeyedChildren(
    list,
    [...SYSTEM_SCOPES],
    (node) => node.querySelector('[data-scope-key]')?.getAttribute('data-scope-key') ?? '',
    (entry) => scopeToStorageKey(entry.scope),
    (entry) =>
      createScopeRow(
        documentRef,
        entry.scope,
        '',
        { accessible: '', visible: '' },
        activeKey,
        undefined,
        DEFAULT_READER_SETTINGS,
        entry.icon,
      ),
    (node, entry) => {
      const descriptor = scopeCountDescriptor(entry.scope, snapshot);
      configureScopeRow(
        documentRef,
        node,
        entry.scope,
        i18n.getMessage(entry.key),
        formatCount(i18n, descriptor.shortKey, descriptor.phraseKey, descriptor.count),
        activeKey,
        undefined,
        DEFAULT_READER_SETTINGS,
        entry.icon,
      );
    },
  );
}

/**
 * @param {Document} documentRef
 * @param {{categoryCollapsed: Record<string, boolean>}} state
 * @param {SidebarSnapshot} snapshot
 * @param {SidebarI18n} i18n
 * @param {import('./reader-settings.js').ReaderSettings} settings
 * @param {string} activeKey
 */
function renderCategories(documentRef, state, snapshot, i18n, settings, activeKey) {
  const list = requireElement(documentRef, '[data-category-scope-list]');
  const feedsByCategory = new Map();
  for (const feed of snapshot.feeds) {
    const categoryId = stringValue(feed.categoryId);
    feedsByCategory.set(categoryId, [...(feedsByCategory.get(categoryId) ?? []), feed]);
  }

  const visibleCategories = [];
  for (const category of snapshot.categories) {
    const categoryId = stringValue(category.id);
    const categoryFeeds = feedsByCategory.get(categoryId) ?? [];
    if (categoryFeeds.length === 0) continue;
    visibleCategories.push({ category, categoryFeeds, categoryId });
  }
  if (visibleCategories.length === 0) {
    if (list.childElementCount !== 1 || !list.firstElementChild?.querySelector('.nav-row.is-empty')) {
      list.replaceChildren(cloneTemplate(documentRef, 'data-sidebar-empty-template', 'li'));
    }
    return;
  }
  reconcileKeyedChildren(
    list,
    visibleCategories,
    (node) => node.dataset.categoryId ?? '',
    (entry) => entry.categoryId,
    () => cloneTemplate(documentRef, 'data-category-group-template', 'li'),
    (group, entry) => configureCategoryGroup(documentRef, group, entry, state, snapshot, i18n, settings, activeKey),
  );
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} group
 * @param {{category: Record<string, unknown>, categoryFeeds: Array<Record<string, unknown>>, categoryId: string}} entry
 * @param {{categoryCollapsed: Record<string, boolean>}} state
 * @param {SidebarSnapshot} snapshot
 * @param {SidebarI18n} i18n
 * @param {import('./reader-settings.js').ReaderSettings} settings
 * @param {string} activeKey
 */
function configureCategoryGroup(documentRef, group, entry, state, snapshot, i18n, settings, activeKey) {
  const categoryKey = `category:${entry.categoryId}`;
  setAttribute(group, 'data-category-id', entry.categoryId);
  const descriptor = scopeCountDescriptor({ type: 'category', id: entry.categoryId }, snapshot);
  const feedList = configureCategoryHeader(documentRef, group, i18n, {
    activeKey,
    categoryCount: formatCount(i18n, descriptor.shortKey, descriptor.phraseKey, descriptor.count),
    categoryId: entry.categoryId,
    categoryKey,
    categoryLabel: stringValue(entry.category.title),
    collapsed: state.categoryCollapsed[categoryKey] === true,
  });
  if (!feedList) return;
  reconcileKeyedChildren(
    feedList,
    entry.categoryFeeds,
    (node) => node.querySelector('[data-scope-key]')?.getAttribute('data-scope-key') ?? '',
    (feed) => `feed:${stringValue(feed.id)}`,
    (feed) =>
      createScopeRow(
        documentRef,
        { type: 'feed', id: stringValue(feed.id) },
        '',
        { accessible: '', visible: '' },
        activeKey,
        feed,
        settings,
      ),
    (node, feed) => {
      const feedScope = /** @type {const} */ ({ type: 'feed', id: stringValue(feed.id) });
      const count = scopeCountDescriptor(feedScope, snapshot);
      configureScopeRow(
        documentRef,
        node,
        feedScope,
        displayTitle(feed),
        formatCount(i18n, count.shortKey, count.phraseKey, count.count),
        activeKey,
        feed,
        settings,
      );
    },
  );
}

/**
 * Splits the category header across a disclosure toggle and a scope label, keeping aria valid.
 *
 * @param {Document} documentRef
 * @param {Element} group
 * @param {SidebarI18n} i18n
 * @param {{activeKey: string, categoryCount: SidebarCount, categoryId: string, categoryKey: string, categoryLabel: string, collapsed: boolean}} context
 * @returns {HTMLElement | null} the category feed list, or null when the template is malformed
 */
function configureCategoryHeader(documentRef, group, i18n, context) {
  const section = group.querySelector('.sidebar-category');
  const toggle = group.querySelector('[data-category-toggle]');
  const label = group.querySelector('[data-category-scope]');
  const feedList = group.querySelector('[data-category-feed-list]');
  if (!isHtmlElement(documentRef, section) || !isButtonElement(documentRef, toggle)) return null;
  if (!isButtonElement(documentRef, label) || !isHtmlElement(documentRef, feedList)) return null;
  const listId = `feeds-${context.categoryId}`;
  const headingId = `category-${context.categoryId}`;
  setAttribute(section, 'aria-labelledby', headingId);
  setAttribute(label, 'id', headingId);
  setAttribute(label, 'data-scope-key', context.categoryKey);
  setAttribute(label, 'data-scope-type', 'category');
  setAttribute(label, 'data-scope-id', context.categoryId);
  if (context.activeKey === context.categoryKey) setAttribute(label, 'aria-current', 'page');
  else removeAttribute(label, 'aria-current');
  setText(group, '[data-category-label]', context.categoryLabel);
  setCount(group, '[data-category-count]', context.categoryCount);
  setButtonLabel(label, context.categoryLabel, context.categoryCount);
  setAttribute(toggle, 'data-category-key', context.categoryKey);
  setAttribute(toggle, 'aria-expanded', context.collapsed ? 'false' : 'true');
  setAttribute(toggle, 'aria-controls', listId);
  setAttribute(toggle, 'aria-label', i18n.getMessage('toggleCategoryNamed', [context.categoryLabel]));
  setAttribute(feedList, 'id', listId);
  setHidden(feedList, context.collapsed);
  return feedList;
}

/**
 * @param {Document} documentRef
 * @param {import('../domain/scopes.js').Scope} scope
 * @param {string} label
 * @param {SidebarCount} count
 * @param {string} activeKey
 * @param {Record<string, unknown>} [feed]
 * @param {import('./reader-settings.js').ReaderSettings} [settings]
 * @param {string} [systemIcon]
 */
function createScopeRow(
  documentRef,
  scope,
  label,
  count,
  activeKey,
  feed,
  settings = DEFAULT_READER_SETTINGS,
  systemIcon,
) {
  const item = cloneTemplate(documentRef, 'data-scope-row-template', 'li');
  configureScopeRow(documentRef, item, scope, label, count, activeKey, feed, settings, systemIcon);
  return item;
}

/** @param {Document} documentRef @param {HTMLElement} item @param {import('../domain/scopes.js').Scope} scope @param {string} label @param {SidebarCount} count @param {string} activeKey @param {Record<string, unknown>} [feed] @param {import('./reader-settings.js').ReaderSettings} [settings] @param {string} [systemIcon] */
function configureScopeRow(
  documentRef,
  item,
  scope,
  label,
  count,
  activeKey,
  feed,
  settings = DEFAULT_READER_SETTINGS,
  systemIcon,
) {
  const button = item.querySelector('[data-scope-key]');
  if (!isButtonElement(documentRef, button)) return;
  const scopeKey = scopeToStorageKey(scope);
  setAttribute(button, 'data-scope-key', scopeKey);
  setAttribute(button, 'data-scope-type', scope.type);
  setAttribute(button, 'data-scope-id', scope.id);
  if (activeKey === scopeKey) setAttribute(button, 'aria-current', 'page');
  else removeAttribute(button, 'aria-current');
  setText(item, '[data-scope-label]', label);
  setCount(item, '[data-scope-count]', count);
  setButtonLabel(button, label, count);
  if (scope.type === 'feed') {
    setAttribute(button, 'data-feed-id', scope.id);
    setAttribute(button, 'data-category-id', stringValue(feed?.categoryId));
    applyFeedIcon(
      documentRef,
      item,
      {
        feedUrl: feed?.url,
        iconColor: feed?.iconColor,
        iconSource: feed?.iconSource,
        iconUrl: feed?.iconUrl,
        id: scope.id,
        siteUrl: feed?.siteUrl,
        title: label,
      },
      settings,
    );
  } else {
    item.querySelector('[data-feed-icon]')?.remove();
    if (systemIcon && !button.querySelector('[data-sidebar-system-icon]')) {
      button.querySelector('[data-scope-label]')?.before(createSystemIcon(documentRef, systemIcon));
    }
  }
}

/**
 * @param {Document} documentRef
 * @param {string} icon
 */
function createSystemIcon(documentRef, icon) {
  return cloneTemplate(documentRef, `[data-sidebar-system-icon-template="${icon}"]`, '[data-sidebar-system-icon]');
}
