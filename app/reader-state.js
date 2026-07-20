// @ts-check

import { DEFAULT_READER_SETTINGS } from './reader-settings.js';

/**
 * @typedef {Awaited<ReturnType<import('./api-client.js').bootstrapApp>>} ReaderSnapshot
 * @typedef {object} ArticleState
 * @property {boolean} busy
 * @property {number} dataRevision
 * @property {'' | 'filtered-unread' | 'filtered-read'} emptyVariant
 * @property {boolean} freezeReadyRows
 * @property {boolean} hasMore
 * @property {Array<Record<string, unknown>>} items
 * @property {boolean} loadingStatusVisible
 * @property {{busy: boolean, dataRevision: number, queryKey: string} | null} newArticlesAvailable
 * @property {string | null} nextCursor
 * @property {Record<string, import('./article-preview.js').PreviewEntry>} previewByArticleId
 * @property {boolean} searchActive
 * @property {string} searchQuery
 * @property {import('./reader-settings.js').ReaderSettings} settings
 * @property {'empty' | 'error' | 'loading' | 'ready'} status
 * @property {'' | 'show-all'} statusAction
 * @property {boolean} statusCanRetry
 * @property {string} statusMessage
 */

/**
 * @returns {ReaderSnapshot}
 */
export function emptySnapshot() {
  return {
    categories: [],
    dataRevision: 0,
    defaultCategoryId: '',
    deletingFeeds: [],
    feeds: [],
    status: 'reader-ready',
    systemStats: {
      all: { articleCount: 0, lastArticleAtMs: 0, starredCount: 0, unreadCount: 0 },
      main: { articleCount: 0, lastArticleAtMs: 0, starredCount: 0, unreadCount: 0 },
    },
  };
}

/**
 * @returns {ArticleState}
 */
export function emptyArticleState() {
  return {
    busy: false,
    dataRevision: 0,
    emptyVariant: '',
    freezeReadyRows: false,
    hasMore: false,
    items: [],
    loadingStatusVisible: false,
    newArticlesAvailable: null,
    nextCursor: null,
    previewByArticleId: {},
    searchActive: false,
    searchQuery: '',
    settings: DEFAULT_READER_SETTINGS,
    status: 'empty',
    statusAction: '',
    statusCanRetry: false,
    statusMessage: '',
  };
}
