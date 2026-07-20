// @ts-check

import { ERROR_CODES } from '../domain/errors.js';
import { parseAtomFeed } from './atom-parser.js';
import { MAX_FEED_BYTES, MAX_FEED_DEPTH, parserFailure, xmlTextBoundaryFailure } from './feed-parser-utils.js';
import { parseRssFeed } from './rss-parser.js';

export { MAX_FEED_BYTES };

/**
 * @param {Uint8Array} bytes
 * @param {{contentType?: string}} [metadata]
 * @returns {{ok: true, encoding: string, text: string} | {ok: false, error: import('../domain/errors.js').SafeError}}
 */
export function decodeFeedBytes(bytes, metadata = {}) {
  if (bytes.byteLength > MAX_FEED_BYTES) {
    return parserFailure(ERROR_CODES.FETCH_RESPONSE_TOO_LARGE, { reason: 'feed response exceeds byte limit' });
  }
  const encoding = detectEncoding(bytes, metadata.contentType ?? '');
  try {
    return {
      encoding: encoding.label,
      ok: true,
      text: new TextDecoder(encoding.label, { fatal: true }).decode(stripBom(bytes, encoding.bomLength)),
    };
  } catch (error) {
    if (!isExpectedDecodeFailure(error)) throw error;
    return parserFailure(ERROR_CODES.FEED_PARSE_ERROR, { reason: 'feed response could not be decoded' });
  }
}

/**
 * @param {unknown} error
 */
function isExpectedDecodeFailure(error) {
  return (
    error instanceof RangeError ||
    error instanceof TypeError ||
    (error instanceof DOMException && (error.name === 'EncodingError' || error.name === 'InvalidCharacterError'))
  );
}

/**
 * @param {Uint8Array} bytes
 * @param {{contentType?: string, responseUrl: string, nowMs?: number}} context
 * @returns {import('./feed-parser-utils.js').ParserResult}
 */
export function parseFeedBytes(bytes, context) {
  const decoded = decodeFeedBytes(bytes, { contentType: context.contentType });
  if (!decoded.ok) return decoded;
  return parseFeedXml(decoded.text, context);
}

/**
 * @param {string} xmlText
 * @param {{responseUrl: string, nowMs?: number}} context
 * @returns {import('./feed-parser-utils.js').ParserResult}
 */
export function parseFeedXml(xmlText, context) {
  const boundaryFailure = xmlTextBoundaryFailure(xmlText);
  if (boundaryFailure) return boundaryFailure;
  const doc = new DOMParser().parseFromString(xmlText.replace(/\r\n?/gu, '\n'), 'application/xml');
  const validationFailure = validateXmlDocument(doc);
  if (validationFailure) return validationFailure;
  const root = doc.documentElement;
  if (root.localName === 'rss') return parseRssFeed(xmlText, context);
  if (root.localName === 'feed' && root.namespaceURI === 'http://www.w3.org/2005/Atom')
    return parseAtomFeed(xmlText, context);
  return parserFailure(ERROR_CODES.UNSUPPORTED_FEED_FORMAT, { reason: 'unsupported feed root' });
}

/**
 * @param {XMLDocument} doc
 * @returns {import('./feed-parser-utils.js').ParserResult | null}
 */
function validateXmlDocument(doc) {
  if (hasParserError(doc) || !doc.documentElement) {
    return parserFailure(ERROR_CODES.FEED_PARSE_ERROR, { reason: 'feed XML is malformed' });
  }
  /** @type {Array<{depth: number, element: Element}>} */
  const stack = [{ depth: 1, element: doc.documentElement }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.depth > MAX_FEED_DEPTH) {
      return parserFailure(ERROR_CODES.FEED_PARSE_ERROR, { reason: 'feed XML exceeds parser limits' });
    }
    for (const child of current.element.children) stack.push({ depth: current.depth + 1, element: child });
  }
  return null;
}

/**
 * @param {XMLDocument} doc
 */
function hasParserError(doc) {
  const errors = doc.getElementsByTagName('parsererror');
  return errors.length > 0 || doc.documentElement?.localName === 'parsererror';
}

/**
 * @param {Uint8Array} bytes
 * @param {string} contentType
 * @returns {{label: string, bomLength: number}}
 */
function detectEncoding(bytes, contentType) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { bomLength: 3, label: 'utf-8' };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { bomLength: 2, label: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { bomLength: 2, label: 'utf-16be' };
  const declaration = asciiPrefix(bytes).match(/<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/iu)?.[1];
  if (declaration) return { bomLength: 0, label: declaration };
  const charset = contentType.match(/;\s*charset\s*=\s*"?([^;"\s]+)"?/iu)?.[1];
  return { bomLength: 0, label: charset || 'utf-8' };
}

/**
 * @param {Uint8Array} bytes
 */
function asciiPrefix(bytes) {
  return Array.from(bytes.slice(0, 512), (byte) => String.fromCharCode(byte)).join('');
}

/**
 * @param {Uint8Array} bytes
 * @param {number} length
 */
function stripBom(bytes, length) {
  return length > 0 ? bytes.slice(length) : bytes;
}
