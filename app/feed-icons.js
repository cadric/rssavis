// @ts-check

import { hostKey, tryNormalizeHttpUrl } from '../domain/urls.js';
import { cloneTemplate } from './templates.js';

/** @type {WeakMap<HTMLImageElement, string>} */
const appliedImageSignatures = new WeakMap();

/**
 * @typedef {object} FeedIconSource
 * @property {unknown} [feedUrl]
 * @property {unknown} [iconColor]
 * @property {unknown} [iconUrl]
 * @property {unknown} [iconSource]
 * @property {unknown} [id]
 * @property {unknown} [siteUrl]
 * @property {unknown} [title]
 *
 * @typedef {Pick<import('./reader-settings.js').ReaderSettings, 'imageLoading' | 'lazyLoadImages'>} FeedIconSettings
 */

/**
 * @param {Document} documentRef
 * @param {ParentNode} root
 * @param {FeedIconSource} source
 * @param {FeedIconSettings} settings
 */
export function applyFeedIcon(documentRef, root, source, settings) {
  const icon = root.querySelector('[data-feed-icon]');
  const image = root.querySelector('[data-feed-icon-image]');
  const view = requireView(documentRef);
  if (!(icon instanceof view.HTMLElement)) return;
  const initials = ensureInitials(documentRef, icon);
  const identitySeed = stringValue(source.id) || stringValue(source.title);
  const iconColor = stringValue(source.iconColor);
  setHidden(icon, false);
  setText(initials, feedInitials(stringValue(source.title) || stringValue(source.id)));
  // A user-selected identity color overrides the deterministic hash (B36).
  setAttribute(initials, 'data-identity', /^[0-8]$/u.test(iconColor) ? iconColor : String(identityIndex(identitySeed)));
  const iconSource = stringValue(source.iconSource) || 'auto';
  if (!(image instanceof view.HTMLImageElement) || settings.imageLoading !== 'always') {
    if (image instanceof view.HTMLImageElement) {
      image.onerror = null;
      appliedImageSignatures.set(image, `initials:${settings.imageLoading}`);
    }
    showInitials(image, initials);
    return;
  }
  // The favicon source ignores any resolved iconUrl and always uses the favicon chain.
  const chain = buildFaviconChain(source, iconSource !== 'favicon');
  if (chain.length === 0) {
    image.onerror = null;
    appliedImageSignatures.set(image, 'initials:empty-chain');
    showInitials(image, initials);
    return;
  }
  const signature = `${settings.lazyLoadImages ? 'lazy' : 'eager'}:${chain.join('\n')}`;
  if (appliedImageSignatures.get(image) === signature) return;
  appliedImageSignatures.set(image, signature);
  let index = 0;
  setImage(image, chain[0], settings);
  setHidden(initials, true);
  setHidden(image, false);
  // Assign onerror as a property (not addEventListener): reused <img> rows must not
  // accumulate error listeners, so each render replaces the prior handler outright.
  image.onerror = () => {
    index += 1;
    if (index < chain.length) {
      setImage(image, chain[index], settings);
      return;
    }
    image.onerror = null;
    showInitials(image, initials);
  };
}

/**
 * Ordered favicon fallback chain: the resolved iconUrl first, then the site and
 * feed favicons, then the caller renders initials once the chain is exhausted.
 * eTLD+1 distrust: the feed favicon is tried before the site favicon ONLY when
 * the site host differs from the feed host AND the siteUrl looks like a
 * placeholder (a reserved `example.*` / `localhost` / `.invalid`/`.test` host,
 * the "dummy siteUrl" the B32 plan flags — e.g. Kanal Frederikshavn's
 * `example.com`). A legitimate publisher on a different host from its feed CDN
 * (e.g. `publisher.example.org` + `feeds.cdn.net`) still keeps its own site
 * favicon first.
 * @param {FeedIconSource} source
 * @param {boolean} includeIconUrl
 * @returns {string[]}
 */
function buildFaviconChain(source, includeIconUrl = true) {
  const iconUrl = includeIconUrl ? tryNormalizeHttpUrl(source.iconUrl) : '';
  const siteFavicon = faviconFromUrl(source.siteUrl);
  const feedFavicon = faviconFromUrl(source.feedUrl);
  const distrustSite =
    Boolean(siteFavicon) &&
    Boolean(feedFavicon) &&
    hostKey(stringValue(source.siteUrl)) !== hostKey(stringValue(source.feedUrl)) &&
    isPlaceholderSiteHost(source.siteUrl);
  const favicons = distrustSite ? [feedFavicon, siteFavicon] : [siteFavicon, feedFavicon];
  /** @type {string[]} */
  const chain = [];
  for (const url of [iconUrl, ...favicons]) {
    if (url && !chain.includes(url)) chain.push(url);
  }
  return chain;
}

const PLACEHOLDER_SITE_HOSTS = new Set(['example.com', 'example.net', 'example.org', 'example.edu']);
const PLACEHOLDER_SITE_TLDS = new Set(['invalid', 'test', 'localhost', 'example']);

/**
 * True when a siteUrl is a reserved placeholder host (RFC 2606/6761) rather than
 * a real publisher domain, so its favicon should not be trusted over the feed's.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlaceholderSiteHost(value) {
  const url = tryNormalizeHttpUrl(value);
  if (!url) return false;
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./u, '');
  if (host === 'localhost' || PLACEHOLDER_SITE_HOSTS.has(host)) return true;
  return PLACEHOLDER_SITE_TLDS.has(host.slice(host.lastIndexOf('.') + 1));
}

/**
 * @param {string} seed
 */
export function identityIndex(seed) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % 9;
}

/**
 * @param {Document} documentRef
 * @param {HTMLElement} icon
 */
function ensureInitials(documentRef, icon) {
  const existing = icon.querySelector('[data-feed-initials]');
  const view = requireView(documentRef);
  if (existing instanceof view.HTMLElement) return existing;
  const initials = cloneTemplate(documentRef, 'data-feed-initials-template', '[data-feed-initials]');
  icon.append(initials);
  return initials;
}

/**
 * @param {unknown} value
 */
function faviconFromUrl(value) {
  const url = tryNormalizeHttpUrl(value);
  if (!url) return '';
  return `${new URL(url).origin}/favicon.ico`;
}

/**
 * @param {Element | null} image
 * @param {HTMLElement} initials
 */
function showInitials(image, initials) {
  if (isElementWithHidden(image)) {
    setHidden(image, true);
    removeAttribute(image, 'src');
  }
  setHidden(initials, false);
}

/**
 * @param {HTMLImageElement} image
 * @param {string} url
 * @param {FeedIconSettings} settings
 */
function setImage(image, url, settings) {
  setAttribute(image, 'decoding', 'async');
  setAttribute(image, 'loading', settings.lazyLoadImages ? 'lazy' : 'eager');
  setAttribute(image, 'referrerpolicy', 'no-referrer');
  setAttribute(image, 'src', url);
}

/** @param {Element} element @param {string} name @param {string} value */
function setAttribute(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** @param {Element} element @param {string} name */
function removeAttribute(element, name) {
  if (element.hasAttribute(name)) element.removeAttribute(name);
}

/** @param {{hidden: boolean | string}} element @param {boolean} hidden */
function setHidden(element, hidden) {
  if (element.hidden !== hidden) element.hidden = hidden;
}

/** @param {Node} node @param {string} text */
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/**
 * @param {string} title
 */
function feedInitials(title) {
  const letters = title
    .trim()
    .split(/\s+/u)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return letters || '#';
}

/**
 * @param {unknown} value
 */
function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isElementWithHidden(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    'hidden' in value &&
    'nodeType' in value &&
    value.nodeType === 1 &&
    'removeAttribute' in value
  );
}

/**
 * @param {Document} documentRef
 */
function requireView(documentRef) {
  if (documentRef.defaultView) return documentRef.defaultView;
  throw new Error('Document has no defaultView.');
}
