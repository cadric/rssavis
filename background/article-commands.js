// @ts-check

import { createArticleRepository } from '../data/article-repository.js';
import { STATE } from '../data/constants.js';
import { createFeedRepository } from '../data/feed-repository.js';
import { createSettingsRepository, DEFAULT_SETTINGS } from '../data/settings-repository.js';
import { MESSAGE_TYPES } from '../domain/message-types.js';
import { openArticleContentLink, openArticleOriginal } from './action-controller.js';
import { createCommittedChangePublisher } from './change-events.js';

/**
 * @typedef {import('../data/transaction.js').TransactionOptions} RepositoryOptions
 * @typedef {import('../data/settings-repository.js').StorageArea} StorageArea
 * @typedef {import('./change-events.js').BrowserRuntimeLike} BrowserRuntimeLike
 * @typedef {BrowserRuntimeLike & import('./action-controller.js').BrowserLike & {storage?: {local?: StorageArea}}} ArticleCommandBrowser
 */

/**
 * @param {RepositoryOptions} options
 * @param {ArticleCommandBrowser} [browserApi]
 * @param {import('./change-events.js').ChangePublisher} [changePublisher]
 * @returns {Record<string, import('./command-router.js').CommandHandler>}
 */
export function createArticleCommandHandlers(options = {}, browserApi = undefined, changePublisher = undefined) {
  const articles = createArticleRepository(options);
  const feeds = createFeedRepository(options);
  return {
    [MESSAGE_TYPES.ARTICLES_QUERY]: async (payload) => joinFeedMetadata(await articles.query(payload), feeds),
    [MESSAGE_TYPES.ARTICLES_SEARCH]: async (payload) => joinFeedMetadata(await articles.search(payload), feeds),
    [MESSAGE_TYPES.ARTICLES_GET_DETAIL]: async (payload) => articles.getDetail(requireString(payload, 'id')),
    [MESSAGE_TYPES.ARTICLES_OPEN_ORIGINAL]: async (payload, context) =>
      openOriginalCommand(payload, context, {
        articles,
        browserApi: requireBrowser(browserApi),
        changePublisher,
      }),
    [MESSAGE_TYPES.ARTICLES_OPEN_CONTENT_LINK]: async (payload, context) =>
      openContentLinkCommand(payload, context, { browserApi: requireBrowser(browserApi) }),
    [MESSAGE_TYPES.ARTICLES_SET_READ]: async (payload) =>
      runMutationCommand(
        () => articles.setRead(requireString(payload, 'id'), requireNumber(payload, 'readState')),
        browserApi,
        changePublisher,
      ),
    [MESSAGE_TYPES.ARTICLES_SET_STARRED]: async (payload) =>
      runMutationCommand(
        () => articles.setStarred(requireString(payload, 'id'), requireNumber(payload, 'starredState')),
        browserApi,
        changePublisher,
      ),
    [MESSAGE_TYPES.ARTICLES_COUNT_UNREAD]: async (payload) => articles.countUnread(payload.scope),
    [MESSAGE_TYPES.ARTICLES_MARK_SCOPE_READ]: async (payload) =>
      runMutationCommand(
        () =>
          articles.markScopeRead(payload.scope, {
            batchSize: optionalNumber(payload, 'batchSize'),
            maxChunks: optionalNumber(payload, 'maxChunks'),
          }),
        browserApi,
        changePublisher,
      ),
  };
}

/**
 * @param {Record<string, unknown>} payload
 * @param {import('./command-router.js').CommandContext} context
 * @param {{articles: ReturnType<typeof createArticleRepository>, browserApi: ArticleCommandBrowser, changePublisher?: import('./change-events.js').ChangePublisher}} dependencies
 */
async function openOriginalCommand(payload, context, dependencies) {
  const articleId = requireString(payload, 'id');
  const settings = await readSettings(dependencies.browserApi);
  const mode = bridgeCurrentTabRequested(payload, context, '/app/open-original.html')
    ? 'current-tab'
    : settings.openLinksMode;
  const opened = await openArticleOriginal({ ...payload, id: articleId, mode }, context, dependencies);
  if (!settings.markReadOnOpen) return openOriginalResult(opened, { article: null, changed: false, dataRevision: 0 });
  const read = await runMutationCommand(
    () => dependencies.articles.setRead(articleId, STATE.ON),
    dependencies.browserApi,
    dependencies.changePublisher,
  );
  return openOriginalResult(opened, read);
}

/**
 * @param {Record<string, unknown>} opened
 * @param {{article?: Record<string, unknown> | null, changed: boolean, dataRevision: number, change?: Record<string, unknown> | null}} read
 */
function openOriginalResult(opened, read) {
  return {
    ...opened,
    changed: read.changed,
    change: read.change ?? null,
    dataRevision: read.dataRevision,
    read: {
      article: read.article ?? null,
      changed: read.changed,
    },
  };
}

/**
 * Inline article-content link command (SEC-004). Content links are NOT the article,
 * so there is no mark-read side effect and no article-id resolution: the target URL
 * arrives in the payload and is re-validated inside {@link openArticleContentLink}.
 * The tab mode follows `settings.openLinksMode`, except that the content-link bridge
 * page (a middle/modified click) forces `current-tab` so the link opens in the bridge's
 * own tab rather than spawning another one.
 *
 * @param {Record<string, unknown>} payload
 * @param {import('./command-router.js').CommandContext} context
 * @param {{browserApi: ArticleCommandBrowser}} dependencies
 */
async function openContentLinkCommand(payload, context, dependencies) {
  const settings = await readSettings(dependencies.browserApi);
  const mode = bridgeCurrentTabRequested(payload, context, '/app/open-content-link.html')
    ? 'current-tab'
    : settings.openLinksMode;
  return openArticleContentLink({ ...payload, mode }, context, dependencies);
}

/**
 * @param {ArticleCommandBrowser} browserApi
 */
async function readSettings(browserApi) {
  return browserApi.storage?.local ? createSettingsRepository(browserApi.storage.local).read() : DEFAULT_SETTINGS;
}

/**
 * A bridge page requested `current-tab` only when the sender is that specific internal
 * bridge document (not any app page) and the payload already asked for `current-tab`.
 *
 * @param {Record<string, unknown>} payload
 * @param {import('./command-router.js').CommandContext} context
 * @param {string} bridgePath the internal bridge path; its page is owned by `app/open-original.html`
 */
function bridgeCurrentTabRequested(payload, context, bridgePath) {
  if (payload.mode !== 'current-tab') return false;
  const sender = context.sender;
  if (typeof sender !== 'object' || sender === null) return false;
  const url = /** @type {{url?: unknown}} */ (sender).url;
  return typeof url === 'string' && url.includes(bridgePath);
}

/**
 * @param {ArticleCommandBrowser | undefined} browserApi
 */
function requireBrowser(browserApi) {
  if (browserApi) return browserApi;
  throw new TypeError('browserApi is required for article actions');
}

/**
 * @param {() => Promise<import('./change-events.js').RepositoryMutationResult>} operation
 * @param {BrowserRuntimeLike | undefined} browserApi
 * @param {import('./change-events.js').ChangePublisher | undefined} changePublisher
 */
async function runMutationCommand(operation, browserApi, changePublisher = undefined) {
  const result = await operation();
  const publisher = changePublisher ?? (browserApi ? createCommittedChangePublisher(browserApi) : null);
  if (publisher) await publisher(result);
  return result;
}

/**
 * @param {{items: Array<Record<string, unknown>>, [key: string]: unknown}} page
 * @param {ReturnType<typeof createFeedRepository>} feeds
 */
async function joinFeedMetadata(page, feeds) {
  const feedIds = [...new Set(page.items.map((item) => item.feedId).filter((id) => typeof id === 'string'))];
  const feedMap = new Map();
  for (const feedId of feedIds) feedMap.set(feedId, await feeds.get(feedId));
  return {
    ...page,
    items: page.items.map((item) => {
      const feed = typeof item.feedId === 'string' ? feedMap.get(item.feedId) : null;
      return {
        ...item,
        feedTitle: feed?.title ?? '',
        feedIconColor: feed?.iconColor ?? '',
        feedIconSource: feed?.iconSource ?? 'auto',
        feedIconUrl: feed?.iconUrl ?? null,
        feedSiteUrl: feed?.siteUrl ?? '',
        feedUrl: feed?.url ?? '',
      };
    }),
  };
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} key
 */
function requireString(payload, key) {
  const value = payload[key];
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string`);
  return value;
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} key
 */
function requireNumber(payload, key) {
  const value = payload[key];
  if (typeof value !== 'number') throw new TypeError(`${key} must be a number`);
  return value;
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} key
 */
function optionalNumber(payload, key) {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new TypeError(`${key} must be a number`);
  return value;
}
