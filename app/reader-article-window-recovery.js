// @ts-check

import { mergeArticles } from './article-merge.js';
import { requestCurrentArticlePage } from './reader-article-page-request.js';

/**
 * Replays fresh keyset pages without committing an intermediate first page.
 * A page that advances its cursor without adding a unique row remains a valid
 * terminal step for bounded search scans, so the user can continue explicitly.
 * @param {Parameters<typeof requestCurrentArticlePage>[0]} context
 * @param {NonNullable<Awaited<ReturnType<typeof requestCurrentArticlePage>>>} first
 * @param {number} targetItemCount
 * @returns {Promise<Awaited<ReturnType<typeof requestCurrentArticlePage>>>}
 */
export async function requestRecoveredArticleWindow(context, first, targetItemCount) {
  let current = first;
  while (current.page.hasMore && current.page.nextCursor && current.page.items.length < targetItemCount) {
    const previousItemCount = current.page.items.length;
    const next = await requestCurrentArticlePage({
      ...context,
      mode: 'append',
      previous: { ...context.previous, items: current.page.items, nextCursor: current.page.nextCursor },
    });
    if (!next) return null;
    const items = mergeArticles(current.page.items, next.page.items);
    current = {
      ...first,
      minimumRevision: Math.max(current.minimumRevision, next.minimumRevision),
      page: { ...next.page, items },
    };
    if (items.length === previousItemCount) break;
  }
  return current;
}
