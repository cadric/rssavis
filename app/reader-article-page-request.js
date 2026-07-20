// @ts-check

import { ERROR_CODES, createAppError } from '../domain/errors.js';
import { queryArticles, searchArticles } from './api-client.js';
import { effectiveArticleFilter, queryFilterForArticleFilter } from './article-filter.js';
import { readerQueryKey } from './reader-refresh-plan.js';

/**
 * @typedef {object} ArticlePageRequestInput
 * @property {import('./reader-controller.js').ReaderControllerInput} input
 * @property {import('./reader-controller.js').ReaderRuntime} runtime
 * @property {NonNullable<ReturnType<import('./reader-controller.js').ReaderControllerInput['getState']>>} current
 * @property {import('./reader-state.js').ArticleState} previous
 * @property {import('./reader-settings.js').ReaderSettings} settings
 * @property {'append' | 'reset'} mode
 * @property {import('./reader-article-loader.js').LoadArticlesOptions} options
 * @property {number} requestSequence
 * @property {boolean} searchActive
 * @property {string} searchQuery
 * @property {boolean} preserveRows
 */

/**
 * @param {ArticlePageRequestInput} context
 */
export async function requestCurrentArticlePage(context) {
  const { input, runtime, current, previous, settings, mode, options, requestSequence, searchActive, searchQuery } =
    context;
  const cursor = mode === 'append' ? previous.nextCursor : null;
  const pageSize = settings.articlesPerPage;
  const appliedFilter = effectiveArticleFilter(current, previous);
  const filter = queryFilterForArticleFilter(appliedFilter);
  const query = {
    cursor,
    pageSize,
    scope: current.activeScope,
    ...(filter ? { filter } : {}),
  };
  const requestPage = () =>
    searchActive
      ? searchArticles(
          { cursor, pageSize: Math.min(pageSize, 100), query: searchQuery, scope: current.activeScope },
          input.options.browserApi,
        )
      : queryArticles(query, input.options.browserApi);
  const pageQueryKey = readerQueryKey(current, previous, pageSize);
  let page = await requestPage();
  if (requestSequence !== runtime.requestSequence) return null;
  let minimumRevision = minimumPageRevision(
    input,
    runtime,
    options,
    pageQueryKey,
    searchActive,
    mode === 'reset' && !context.preserveRows,
  );
  if (mode === 'reset' && page.dataRevision < minimumRevision) {
    page = await requestPage();
    if (requestSequence !== runtime.requestSequence) return null;
    minimumRevision = minimumPageRevision(input, runtime, options, pageQueryKey, searchActive, true);
    if (page.dataRevision < minimumRevision) {
      throw createAppError(ERROR_CODES.CURSOR_STALE, { retryable: true });
    }
  }
  return { appliedFilter, minimumRevision, page, pageQueryKey, pageSize };
}

/** @param {import('./reader-controller.js').ReaderControllerInput} input @param {import('./reader-controller.js').ReaderRuntime} runtime @param {import('./reader-article-loader.js').LoadArticlesOptions} options @param {string} queryKey @param {boolean} searchActive @param {boolean} includeSnapshot */
function minimumPageRevision(input, runtime, options, queryKey, searchActive, includeSnapshot) {
  if (options.revisionReset === true) return 0;
  return Math.max(
    includeSnapshot && !searchActive ? input.getSnapshot().dataRevision : 0,
    runtime.pageRevisionFloors.get(queryKey) ?? 0,
  );
}
