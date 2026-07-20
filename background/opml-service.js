// @ts-check

import { createOpmlRepository } from '../data/opml-repository.js';
import { AppError, ERROR_CODES, createAppError, toSafeError } from '../domain/errors.js';
import { normalizeOpmlImportModel } from '../domain/opml-import-model.js';
import { normalizeFeedText } from '../domain/text.js';
import { normalizeFeedUrl, originPatternForUrl, tryNormalizeHttpUrl } from '../domain/urls.js';
import { MESSAGE_TYPES } from '../domain/message-types.js';
import { startOpmlPostCommitWork } from './opml-post-commit.js';
import { createCommittedChangePublisher } from './change-events.js';

export const MAX_OPML_BYTES = 5 * 1024 * 1024;
export const MAX_OPML_DEPTH = 20;
export const MAX_OPML_FEEDS = 5000;

/**
 * @typedef {object} OpmlParseOptions
 * @property {ReadonlySet<string>} [existingNormalizedUrls]
 *
 * @typedef {object} OpmlPreviewError
 * @property {string} code
 * @property {string} reason
 * @property {number} sourceOrder
 *
 * @typedef {object} OpmlImportFeed
 * @property {string} categoryTitle
 * @property {string} htmlUrl
 * @property {string} normalizedUrl
 * @property {string} originPattern
 * @property {number} sourceOrder
 * @property {string} title
 * @property {'rss' | 'atom' | null} type
 * @property {string} xmlUrl
 *
 * @typedef {object} OpmlPreview
 * @property {true} ok
 * @property {number} alreadySubscribedCount
 * @property {number} categoryCount
 * @property {number} duplicateInFileCount
 * @property {OpmlPreviewError[]} errors
 * @property {Array<OpmlImportFeed & {status: 'valid' | 'already-subscribed'}>} feeds
 * @property {{version: 1, originPatterns: string[], feeds: OpmlImportFeed[]}} importModel
 * @property {number} invalidCount
 * @property {string[]} originPatterns
 * @property {number} uniqueOriginCount
 * @property {number} validCount
 */

/**
 * @param {string} opmlText
 * @param {OpmlParseOptions} [options]
 * @returns {OpmlPreview | {ok: false, error: import('../domain/errors.js').SafeError}}
 */
export function parseOpmlText(opmlText, options = {}) {
  const boundary = opmlBoundaryFailure(opmlText);
  if (boundary) return boundary;
  const document = new DOMParser().parseFromString(opmlText.replace(/\r\n?/gu, '\n'), 'application/xml');
  if (hasParserError(document) || !document.documentElement) {
    return opmlFailure(ERROR_CODES.OPML_PARSE_ERROR, 'OPML XML is malformed');
  }
  if (document.documentElement.localName.toLowerCase() !== 'opml') {
    return opmlFailure(ERROR_CODES.OPML_PARSE_ERROR, 'OPML root is required');
  }
  return collectOpmlPreview(document, options.existingNormalizedUrls ?? new Set());
}

/**
 * @param {import('../data/transaction.js').TransactionOptions} [options]
 * @param {{permissions: {contains(permissions: {origins: string[]}): Promise<boolean>}, runtime?: {sendMessage(message: unknown): Promise<unknown>}}} [browserApi]
 * @param {unknown} [refreshService]
 * @param {import('./change-events.js').ChangePublisher} [changePublisher]
 * @returns {Record<string, import('./command-router.js').CommandHandler>}
 */
export function createOpmlCommandHandlers(
  options = {},
  browserApi = undefined,
  refreshService = undefined,
  changePublisher = undefined,
) {
  const opml = createOpmlRepository(options);
  return {
    [MESSAGE_TYPES.OPML_PREVIEW_IMPORT]: async (payload) => {
      const parsed = parseOpmlText(requireString(payload, 'opmlText'));
      if (!parsed.ok) throw safeErrorAsAppError(parsed.error);
      const existing = await opml.findExistingNormalizedUrls(
        parsed.importModel.feeds.map((feed) => feed.normalizedUrl),
      );
      return toOpmlPreviewDto(markExistingSubscriptions(parsed, existing));
    },
    [MESSAGE_TYPES.OPML_COMMIT_IMPORT]: async (payload) => {
      const importModel = normalizeOpmlImportModel(payload.importModel);
      await requireOriginsGranted(importModel.originPatterns, browserApi);
      const result = await opml.commitImport(importModel);
      const publisher =
        changePublisher ??
        (browserApi?.runtime
          ? createCommittedChangePublisher(/** @type {import('./change-events.js').BrowserRuntimeLike} */ (browserApi))
          : null);
      if (publisher) await publisher(result);
      const refresh = await startOpmlPostCommitWork(refreshService, result);
      return { ...result, refreshState: refresh.status };
    },
    [MESSAGE_TYPES.OPML_EXPORT]: () => opml.exportSubscriptions(),
  };
}

/**
 * @param {string} opmlText
 */
function opmlBoundaryFailure(opmlText) {
  if (new TextEncoder().encode(opmlText).byteLength > MAX_OPML_BYTES) {
    return opmlFailure(ERROR_CODES.OPML_TOO_LARGE, 'OPML exceeds byte limit');
  }
  if (opmlText.includes('\u0000')) return opmlFailure(ERROR_CODES.OPML_PARSE_ERROR, 'OPML contains NUL');
  if (/<!DOCTYPE\b/iu.test(opmlText)) return opmlFailure(ERROR_CODES.OPML_PARSE_ERROR, 'DOCTYPE is not supported');
  return null;
}

/**
 * @param {XMLDocument} document
 * @param {ReadonlySet<string>} existingNormalizedUrls
 * @returns {OpmlPreview | {ok: false, error: import('../domain/errors.js').SafeError}}
 */
function collectOpmlPreview(document, existingNormalizedUrls) {
  const body = [...document.documentElement.children].find((element) => element.localName.toLowerCase() === 'body');
  const state = createPreviewState(existingNormalizedUrls);
  if (!body) return buildPreview(state);
  for (const child of body.children) {
    const failure = walkOutline(child, [], 0, state);
    if (failure) return failure;
  }
  return buildPreview(state);
}

/**
 * @param {Element} element
 * @param {string[]} categoryPath
 * @param {number} outlineDepth
 * @param {ReturnType<typeof createPreviewState>} state
 * @returns {{ok: false, error: import('../domain/errors.js').SafeError} | null}
 */
function walkOutline(element, categoryPath, outlineDepth, state) {
  if (element.localName.toLowerCase() !== 'outline') return null;
  const nextDepth = outlineDepth + 1;
  if (nextDepth > MAX_OPML_DEPTH) return opmlFailure(ERROR_CODES.OPML_PARSE_ERROR, 'OPML outline depth exceeded');
  const xmlUrl = attributeValue(element, 'xmlUrl');
  if (xmlUrl) return collectFeedOutline(element, categoryPath, xmlUrl, state);
  const label = outlineLabel(element);
  const nextPath = label ? [...categoryPath, label] : categoryPath;
  for (const child of element.children) {
    const failure = walkOutline(child, nextPath, nextDepth, state);
    if (failure) return failure;
  }
  return null;
}

/**
 * @param {Element} element
 * @param {string[]} categoryPath
 * @param {string} xmlUrl
 * @param {ReturnType<typeof createPreviewState>} state
 * @returns {{ok: false, error: import('../domain/errors.js').SafeError} | null}
 */
function collectFeedOutline(element, categoryPath, xmlUrl, state) {
  state.totalFeedOutlines += 1;
  if (state.totalFeedOutlines > MAX_OPML_FEEDS) {
    return opmlFailure(ERROR_CODES.OPML_PARSE_ERROR, 'OPML feed count exceeded');
  }
  const sourceOrder = state.totalFeedOutlines - 1;
  let normalizedUrl = '';
  try {
    normalizedUrl = normalizeFeedUrl(xmlUrl);
  } catch (error) {
    if (!isExpectedUrlValidationError(error)) throw error;
    state.invalidCount += 1;
    state.errors.push({ code: 'OPML_INVALID_FEED_URL', reason: 'invalid feed URL', sourceOrder });
    return null;
  }
  if (state.seenNormalizedUrls.has(normalizedUrl)) {
    state.duplicateInFileCount += 1;
    state.errors.push({ code: 'OPML_DUPLICATE_IN_FILE', reason: 'duplicate feed URL', sourceOrder });
    return null;
  }
  state.seenNormalizedUrls.add(normalizedUrl);
  const categoryTitle = normalizeCategoryPath(categoryPath);
  const feed = {
    categoryTitle,
    htmlUrl: tryNormalizeHttpUrl(attributeValue(element, 'htmlUrl')),
    normalizedUrl,
    originPattern: originPatternForUrl(normalizedUrl),
    sourceOrder,
    title: outlineLabel(element) || normalizedUrl,
    type: outlineType(element),
    xmlUrl: normalizedUrl,
  };
  state.feeds.push(feed);
  state.originPatterns.add(feed.originPattern);
  if (categoryTitle) state.categories.add(categoryTitle);
  if (state.existingNormalizedUrls.has(normalizedUrl)) state.alreadySubscribedUrls.add(normalizedUrl);
  return null;
}

/**
 * @param {unknown} error
 */
function isExpectedUrlValidationError(error) {
  return (
    error instanceof AppError &&
    (error.code === ERROR_CODES.VALIDATION_ERROR || error.code === ERROR_CODES.UNSUPPORTED_URL_SCHEME)
  );
}

/**
 * @param {ReturnType<typeof createPreviewState>} state
 * @returns {OpmlPreview}
 */
function buildPreview(state) {
  const feeds = state.feeds.map((feed) => ({
    ...feed,
    status: /** @type {'valid' | 'already-subscribed'} */ (
      state.alreadySubscribedUrls.has(feed.normalizedUrl) ? 'already-subscribed' : 'valid'
    ),
  }));
  return {
    alreadySubscribedCount: state.alreadySubscribedUrls.size,
    categoryCount: state.categories.size,
    duplicateInFileCount: state.duplicateInFileCount,
    errors: state.errors,
    feeds,
    importModel: { feeds: state.feeds, originPatterns: [...state.originPatterns], version: 1 },
    invalidCount: state.invalidCount,
    ok: true,
    originPatterns: [...state.originPatterns],
    uniqueOriginCount: state.originPatterns.size,
    validCount: feeds.length,
  };
}

/**
 * @param {ReadonlySet<string>} existingNormalizedUrls
 */
function createPreviewState(existingNormalizedUrls) {
  return {
    alreadySubscribedUrls: new Set(),
    categories: new Set(),
    duplicateInFileCount: 0,
    errors: /** @type {OpmlPreviewError[]} */ ([]),
    existingNormalizedUrls,
    feeds: /** @type {OpmlImportFeed[]} */ ([]),
    invalidCount: 0,
    originPatterns: new Set(),
    seenNormalizedUrls: new Set(),
    totalFeedOutlines: 0,
  };
}

/**
 * @param {OpmlPreview} preview
 * @param {ReadonlySet<string>} existingNormalizedUrls
 * @returns {OpmlPreview}
 */
function markExistingSubscriptions(preview, existingNormalizedUrls) {
  return buildPreview({
    alreadySubscribedUrls: new Set(
      preview.importModel.feeds
        .filter((feed) => existingNormalizedUrls.has(feed.normalizedUrl))
        .map((feed) => feed.normalizedUrl),
    ),
    categories: new Set(preview.importModel.feeds.map((feed) => feed.categoryTitle).filter(Boolean)),
    duplicateInFileCount: preview.duplicateInFileCount,
    errors: preview.errors,
    existingNormalizedUrls,
    feeds: preview.importModel.feeds,
    invalidCount: preview.invalidCount,
    originPatterns: new Set(preview.importModel.originPatterns),
    seenNormalizedUrls: new Set(preview.importModel.feeds.map((feed) => feed.normalizedUrl)),
    totalFeedOutlines: preview.validCount + preview.duplicateInFileCount + preview.invalidCount,
  });
}

/**
 * @param {OpmlPreview} preview
 */
function toOpmlPreviewDto(preview) {
  const { ok: _ok, ...dto } = preview;
  return dto;
}

/**
 * @param {Element} element
 */
function outlineLabel(element) {
  return normalizeFeedText(attributeValue(element, 'title') || attributeValue(element, 'text'), {
    maxCodePoints: 2048,
  });
}

/**
 * @param {Element} element
 * @returns {'rss' | 'atom' | null}
 */
function outlineType(element) {
  const type = attributeValue(element, 'type').toLowerCase();
  if (type === 'rss' || type === 'atom') return type;
  return null;
}

/**
 * @param {string[]} path
 */
function normalizeCategoryPath(path) {
  return path
    .map((part) => normalizeFeedText(part, { maxCodePoints: 200 }))
    .filter(Boolean)
    .join(' / ');
}

/**
 * @param {Element} element
 * @param {string} name
 */
function attributeValue(element, name) {
  for (const attribute of element.attributes) {
    if (attribute.name.toLowerCase() === name.toLowerCase()) return attribute.value.trim();
  }
  return '';
}

/**
 * @param {string} code
 * @param {string} reason
 */
function opmlFailure(code, reason) {
  return {
    error: toSafeError(createAppError(code, { details: { reason }, retryable: false })),
    ok: /** @type {false} */ (false),
  };
}

/**
 * @param {XMLDocument} document
 */
function hasParserError(document) {
  const errors = document.getElementsByTagName('parsererror');
  return errors.length > 0 || document.documentElement?.localName === 'parsererror';
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} key
 */
function requireString(payload, key) {
  const value = payload[key];
  if (typeof value !== 'string') {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field: key, reason: 'must be a string' } });
  }
  return value;
}

/**
 * @param {readonly string[]} originPatterns
 * @param {{permissions: {contains(permissions: {origins: string[]}): Promise<boolean>}} | undefined} browserApi
 */
async function requireOriginsGranted(originPatterns, browserApi) {
  if (!browserApi || !(await browserApi.permissions.contains({ origins: [...originPatterns] }))) {
    throw createAppError(ERROR_CODES.HOST_PERMISSION_DENIED, {
      details: { operation: 'opml.commitImport' },
      retryable: false,
    });
  }
}

/**
 * @param {import('../domain/errors.js').SafeError} error
 */
function safeErrorAsAppError(error) {
  return createAppError(error.code, { details: error.details, retryable: error.retryable });
}
