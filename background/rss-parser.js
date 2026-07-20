// @ts-check

import { ERROR_CODES } from '../domain/errors.js';
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
import { htmlStringToPlainText, htmlToInertBody } from './plain-text-extractor.js';

const NS = Object.freeze({
  content: 'http://purl.org/rss/1.0/modules/content/',
  dc: 'http://purl.org/dc/elements/1.1/',
  media: 'http://search.yahoo.com/mrss/',
});

/**
 * @param {string} xmlText
 * @param {import('./feed-parser-utils.js').ParserContext} context
 * @returns {import('./feed-parser-utils.js').ParserResult}
 */
export function parseRssFeed(xmlText, context) {
  const doc = parseXml(xmlText);
  if (!doc.ok) return doc;
  const root = doc.document.documentElement;
  if (root.localName !== 'rss') return parserFailure(ERROR_CODES.UNSUPPORTED_FEED_FORMAT);
  const channel = firstChild(root, 'channel');
  if (!channel) return parserFailure(ERROR_CODES.FEED_PARSE_ERROR, { reason: 'RSS channel is missing' });
  const baseUrl = context.responseUrl;
  const feed = {
    ...emptyFeed(),
    description: textChild(channel, 'description', TEXT_LIMITS.description),
    iconUrl: imageUrl(channel, baseUrl),
    language: textChild(channel, 'language', 64),
    siteUrl: fieldUrl(textChild(channel, 'link', 8192), baseUrl),
    title: textChild(channel, 'title', TEXT_LIMITS.title),
    updatedAtMs: fieldDate(textChild(channel, 'lastBuildDate', 128), context.nowMs),
  };
  const items = elementChildren(channel, 'item');
  if (items.length > MAX_FEED_ENTRY_COUNT) {
    return parserFailure(ERROR_CODES.FEED_PARSE_ERROR, { reason: 'RSS feed entry count exceeded' });
  }
  const entries = items.slice(0, MAX_NORMALIZED_ENTRIES).map((item) => rssEntry(item, baseUrl, context.nowMs));
  return parserSuccess({ entries, feed, format: 'rss' });
}

/**
 * @param {Element} item
 * @param {string} baseUrl
 * @param {number | undefined} nowMs
 */
function rssEntry(item, baseUrl, nowMs) {
  const guidElement = firstChild(item, 'guid');
  const guid = textFrom(guidElement, TEXT_LIMITS.id);
  const linkUrl = fieldUrl(textChild(item, 'link', 8192), baseUrl);
  const guidUrl = guidElement?.getAttribute('isPermaLink') !== 'false' ? fieldUrl(guid, baseUrl) : '';
  const encoded =
    [...item.children].find((element) => element.localName === 'encoded' && element.namespaceURI === NS.content) ??
    null;
  const rawContent = rawHtmlText(encoded?.textContent ?? '', TEXT_LIMITS.body);
  return {
    ...emptyEntry(),
    author: textChildNs(item, 'creator', NS.dc, TEXT_LIMITS.author) || textChild(item, 'author', TEXT_LIMITS.author),
    canonicalUrl: linkUrl || guidUrl,
    contentBlocks: sanitizeContent(htmlToInertBody(rawContent), baseUrl),
    contentText: htmlText(rawContent, TEXT_LIMITS.body),
    guid,
    imageUrl: itemImageUrl(item, baseUrl),
    publishedAtMs: fieldDate(textChild(item, 'pubDate', 128), nowMs),
    summaryText: htmlText(textChild(item, 'description', TEXT_LIMITS.description), TEXT_LIMITS.description),
    title: textChild(item, 'title', TEXT_LIMITS.title),
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
    return parserFailure(ERROR_CODES.FEED_PARSE_ERROR, { reason: 'RSS XML is malformed' });
  }
  /** @type {Array<{depth: number, element: Element}>} */
  const stack = [{ depth: 1, element: document.documentElement }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.depth > MAX_FEED_DEPTH) {
      return parserFailure(ERROR_CODES.FEED_PARSE_ERROR, { reason: 'RSS XML exceeds parser limits' });
    }
    for (const child of current.element.children) stack.push({ depth: current.depth + 1, element: child });
  }
  return null;
}

/**
 * @param {Element} parent
 * @param {string} localName
 */
function firstChild(parent, localName) {
  return elementChildren(parent, localName)[0] ?? null;
}

/**
 * @param {Element} parent
 * @param {string} localName
 */
function elementChildren(parent, localName) {
  return [...parent.children].filter((element) => element.localName === localName);
}

/**
 * @param {Element} parent
 * @param {string} localName
 * @param {number} maxCodePoints
 */
function textChild(parent, localName, maxCodePoints) {
  return textFrom(firstChild(parent, localName), maxCodePoints);
}

/**
 * @param {Element} parent
 * @param {string} localName
 * @param {string} namespaceUri
 * @param {number} maxCodePoints
 */
function textChildNs(parent, localName, namespaceUri, maxCodePoints) {
  return textFrom(
    [...parent.children].find((element) => element.localName === localName && element.namespaceURI === namespaceUri) ??
      null,
    maxCodePoints,
  );
}

/**
 * @param {Element | null | undefined} element
 * @param {number} maxCodePoints
 */
function textFrom(element, maxCodePoints) {
  return fieldText(element?.textContent ?? '', maxCodePoints);
}

/**
 * @param {string} value
 * @param {number} maxCodePoints
 */
function htmlText(value, maxCodePoints) {
  return htmlStringToPlainText(value, maxCodePoints);
}

/**
 * @param {Element} channel
 * @param {string} baseUrl
 */
function imageUrl(channel, baseUrl) {
  const url = textFrom(firstChild(firstChild(channel, 'image') ?? channel, 'url'), 8192);
  return fieldUrl(url, baseUrl);
}

/**
 * @param {Element} item
 * @param {string} baseUrl
 */
function itemImageUrl(item, baseUrl) {
  const media = [...item.children].find(
    (element) =>
      element.namespaceURI === NS.media &&
      (element.localName === 'thumbnail' || element.localName === 'content') &&
      element.getAttribute('url'),
  );
  const enclosure = elementChildren(item, 'enclosure').find((element) =>
    (element.getAttribute('type') ?? '').startsWith('image/'),
  );
  return fieldUrl(media?.getAttribute('url') ?? enclosure?.getAttribute('url') ?? '', baseUrl);
}
