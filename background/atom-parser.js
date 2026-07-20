// @ts-check

import { ERROR_CODES } from '../domain/errors.js';
import { MAX_RAW_URL_LENGTH } from '../domain/article-content-blocks.js';
import { httpsOnlyUrl } from '../domain/urls.js';
import { sanitizeContent } from './content-sanitizer.js';
import {
  emptyEntry,
  emptyFeed,
  fieldDate,
  fieldText,
  fieldUrl,
  MAX_FEED_DEPTH,
  MAX_FEED_ENTRY_COUNT,
  MAX_NORMALIZED_ENTRIES,
  parserFailure,
  parserSuccess,
  rawHtmlText,
  TEXT_LIMITS,
  xmlTextBoundaryFailure,
} from './feed-parser-utils.js';
import { htmlStringToPlainText, htmlToInertBody, nodeToPlainText } from './plain-text-extractor.js';

const ATOM_NS = 'http://www.w3.org/2005/Atom';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/**
 * @param {string} xmlText
 * @param {import('./feed-parser-utils.js').ParserContext} context
 * @returns {import('./feed-parser-utils.js').ParserResult}
 */
export function parseAtomFeed(xmlText, context) {
  const doc = parseXml(xmlText);
  if (!doc.ok) return doc;
  const root = doc.document.documentElement;
  if (root.localName !== 'feed' || root.namespaceURI !== ATOM_NS) {
    return parserFailure(ERROR_CODES.UNSUPPORTED_FEED_FORMAT);
  }
  const feedBase = xmlBaseFor(root, context.responseUrl);
  const feedAuthor = authorText(root);
  const feed = {
    ...emptyFeed(),
    iconUrl: fieldUrl(textChild(root, 'icon', 8192), feedBase),
    logoUrl: fieldUrl(textChild(root, 'logo', 8192), feedBase),
    siteUrl: alternateLink(root, feedBase),
    title: textChild(root, 'title', TEXT_LIMITS.title),
    updatedAtMs: fieldDate(textChild(root, 'updated', 128), context.nowMs),
  };
  const entryElements = atomChildren(root, 'entry');
  if (entryElements.length > MAX_FEED_ENTRY_COUNT) {
    return parserFailure(ERROR_CODES.FEED_PARSE_ERROR, { reason: 'Atom feed entry count exceeded' });
  }
  const entries = entryElements
    .slice(0, MAX_NORMALIZED_ENTRIES)
    .map((entry) => atomEntry(entry, context.responseUrl, feedAuthor, context.nowMs));
  return parserSuccess({ entries, feed, format: 'atom' });
}

/**
 * @param {Element} entry
 * @param {string} responseUrl
 * @param {string} feedAuthor
 * @param {number | undefined} nowMs
 */
function atomEntry(entry, responseUrl, feedAuthor, nowMs) {
  const entryBase = xmlBaseFor(entry, responseUrl);
  const contentElement = firstAtomChild(entry, 'content');
  const summaryElement = firstAtomChild(entry, 'summary');
  return {
    ...emptyEntry(),
    author: authorText(entry) || feedAuthor,
    canonicalUrl: alternateLink(entry, entryBase),
    contentBlocks: contentElement ? elementContentBlocks(contentElement, responseUrl) : [],
    contentText: contentElement ? elementPlainText(contentElement, TEXT_LIMITS.body) : '',
    guid: textChild(entry, 'id', TEXT_LIMITS.id),
    imageUrl: firstImageLink(entry, entryBase),
    publishedAtMs: fieldDate(textChild(entry, 'published', 128), nowMs),
    sourceUpdatedAtMs: fieldDate(textChild(entry, 'updated', 128), nowMs),
    summaryText: summaryElement ? elementPlainText(summaryElement, TEXT_LIMITS.description) : '',
    title: textChild(entry, 'title', TEXT_LIMITS.title),
  };
}

/**
 * @param {string} xmlText
 * @returns {{ok: true, document: XMLDocument} | {ok: false, error: import('../domain/errors.js').SafeError}}
 */
function parseXml(xmlText) {
  const boundaryFailure = xmlTextBoundaryFailure(xmlText);
  if (boundaryFailure) return boundaryFailure;
  const document = new DOMParser().parseFromString(xmlText.replace(/\r\n?/gu, '\n'), 'application/xml');
  const validationFailure = validateXml(document);
  if (validationFailure) return validationFailure;
  return { document, ok: true };
}

/**
 * @param {XMLDocument} document
 */
function validateXml(document) {
  if (document.getElementsByTagName('parsererror').length > 0 || !document.documentElement) {
    return parserFailure(ERROR_CODES.FEED_PARSE_ERROR, { reason: 'Atom XML is malformed' });
  }
  /** @type {Array<{depth: number, element: Element}>} */
  const stack = [{ depth: 1, element: document.documentElement }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.depth > MAX_FEED_DEPTH) {
      return parserFailure(ERROR_CODES.FEED_PARSE_ERROR, { reason: 'Atom XML exceeds parser limits' });
    }
    for (const child of current.element.children) stack.push({ depth: current.depth + 1, element: child });
  }
  return null;
}

/**
 * @param {Element} parent
 * @param {string} localName
 */
function firstAtomChild(parent, localName) {
  return atomChildren(parent, localName)[0] ?? null;
}

/**
 * @param {Element} parent
 * @param {string} localName
 */
function atomChildren(parent, localName) {
  return [...parent.children].filter((element) => element.localName === localName && element.namespaceURI === ATOM_NS);
}

/**
 * @param {Element} parent
 * @param {string} localName
 * @param {number} maxCodePoints
 */
function textChild(parent, localName, maxCodePoints) {
  return fieldText(firstAtomChild(parent, localName)?.textContent ?? '', maxCodePoints);
}

/**
 * @param {Element} element
 * @param {number} maxCodePoints
 */
function elementPlainText(element, maxCodePoints) {
  const type = (element.getAttribute('type') ?? 'text').toLowerCase();
  if (type === 'xhtml') return nodeToPlainText(element, maxCodePoints);
  if (type === 'html' || /<[^>]+>/u.test(element.textContent ?? ''))
    return htmlText(element.textContent ?? '', maxCodePoints);
  return fieldText(element.textContent ?? '', maxCodePoints);
}

/**
 * @param {Element} element
 * @param {string} responseUrl
 */
function elementContentBlocks(element, responseUrl) {
  const type = (element.getAttribute('type') ?? 'text').toLowerCase();
  const resolver = createRichContentResolver(element, responseUrl);
  if (type === 'xhtml') {
    return sanitizeContent(element, resolver.contentBase, resolver.resolveUrl);
  }
  if (type === 'html' || /<[^>]+>/u.test(element.textContent ?? ''))
    return sanitizeContent(
      htmlToInertBody(rawHtmlText(element.textContent ?? '', TEXT_LIMITS.body)),
      resolver.contentBase,
    );
  return [];
}

/**
 * @param {string} value
 * @param {number} maxCodePoints
 */
function htmlText(value, maxCodePoints) {
  return htmlStringToPlainText(value, maxCodePoints);
}

/**
 * @param {Element} element
 */
function authorText(element) {
  return fieldText(
    firstAtomChild(firstAtomChild(element, 'author') ?? element, 'name')?.textContent ?? '',
    TEXT_LIMITS.author,
  );
}

/**
 * @param {Element} element
 * @param {string} baseUrl
 */
function alternateLink(element, baseUrl) {
  const links = atomChildren(element, 'link');
  const alternate = links.filter((link) => (link.getAttribute('rel') ?? 'alternate') === 'alternate');
  const fallback = links.filter((link) => link.getAttribute('href') && !alternate.includes(link));
  return firstValidLink([...alternate, ...fallback], baseUrl);
}

/**
 * @param {Element} element
 * @param {string} baseUrl
 */
function firstImageLink(element, baseUrl) {
  const image = atomChildren(element, 'link').find((link) => (link.getAttribute('type') ?? '').startsWith('image/'));
  return image ? linkHref(image, baseUrl) : '';
}

/**
 * @param {Element[]} links
 * @param {string} baseUrl
 */
function firstValidLink(links, baseUrl) {
  for (const link of links) {
    const url = linkHref(link, baseUrl);
    if (url) return url;
  }
  return '';
}

/**
 * @param {Element} link
 * @param {string} baseUrl
 */
function linkHref(link, baseUrl) {
  const linkBase = linkOwnBaseFor(link, baseUrl);
  return linkBase ? fieldUrl(link.getAttribute('href') ?? '', linkBase) : '';
}

/**
 * @param {Element} element
 * @param {string} baseUrl
 */
function linkOwnBaseFor(element, baseUrl) {
  const value = element.getAttributeNS(XML_NS, 'base');
  if (value === null || value === '') return baseUrl;
  return fieldUrl(value, baseUrl);
}

/**
 * @param {Element} element
 * @param {string} fallbackBase
 */
function xmlBaseFor(element, fallbackBase) {
  return xmlBaseChain(element).reduce(
    (baseUrl, item) => fieldUrl(item.getAttributeNS(XML_NS, 'base') ?? '', baseUrl) || baseUrl,
    fallbackBase,
  );
}

/** @param {Element} element @returns {Element[]} */
function xmlBaseChain(element) {
  /** @type {Element[]} */
  const chain = [];
  /** @type {Element | null} */
  let cursor = element;
  while (cursor) {
    chain.unshift(cursor);
    cursor = cursor.parentElement;
  }
  return chain;
}

/**
 * Creates one strict base resolver per content element. Base results, including
 * poisoned empty results, are cached so repeated descendant URLs do not reparse
 * their shared xml:base chain.
 * @param {Element} contentElement @param {string} responseUrl
 */
function createRichContentResolver(contentElement, responseUrl) {
  /** @type {WeakMap<Element, string>} */
  const baseCache = new WeakMap();
  const responseBase = boundedBaseUrl(responseUrl, '');
  const baseFor = (/** @type {Element} */ element) => strictXmlBaseFor(element, responseBase, baseCache);
  const contentBase = baseFor(contentElement);
  return {
    contentBase,
    resolveUrl(/** @type {Element} */ element, /** @type {string} */ raw) {
      const absolute = httpsOnlyUrl(raw);
      if (absolute) return absolute;
      const base = baseFor(element);
      return base ? httpsOnlyUrl(raw, base) : '';
    },
  };
}

/**
 * Resolves explicit xml:base values without ancestor fallback. An invalid or
 * overlong override poisons the element and every relative descendant.
 * @param {Element} element @param {string} fallbackBase @param {WeakMap<Element, string>} cache
 */
function strictXmlBaseFor(element, fallbackBase, cache) {
  if (cache.has(element)) return cache.get(element) ?? '';
  /** @type {Element[]} */
  const unresolved = [];
  /** @type {Element | null} */
  let cursor = element;
  while (cursor && !cache.has(cursor)) {
    unresolved.push(cursor);
    cursor = cursor.parentElement;
  }
  let base = cursor ? (cache.get(cursor) ?? '') : fallbackBase;
  while (unresolved.length) {
    const item = unresolved.pop();
    if (!item) break;
    const own = item.getAttributeNS(XML_NS, 'base');
    if (base && own !== null && own !== '') base = boundedBaseUrl(own, base);
    cache.set(item, base);
  }
  return cache.get(element) ?? '';
}

/** @param {string} raw @param {string} baseUrl */
function boundedBaseUrl(raw, baseUrl) {
  return raw.length <= MAX_RAW_URL_LENGTH ? fieldUrl(raw, baseUrl) : '';
}
