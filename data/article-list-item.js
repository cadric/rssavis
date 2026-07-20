// @ts-check

/**
 * @param {import('./models.js').ArticleRecord} article
 */
export function toArticleListItem(article) {
  return {
    id: article.id,
    feedId: article.feedId,
    primaryIdentityKey: article.primaryIdentityKey,
    guid: article.guid,
    canonicalUrl: article.canonicalUrl,
    title: article.title,
    author: article.author,
    publishedAtMs: article.publishedAtMs,
    sourceUpdatedAtMs: article.sourceUpdatedAtMs,
    fetchedAtMs: article.fetchedAtMs,
    sortAtMs: article.sortAtMs,
    readState: article.readState,
    starredState: article.starredState,
    summaryText: article.summaryText,
    searchText: article.searchText,
    imageUrl: article.imageUrl,
    hasBodyState: article.hasBodyState,
    sourceRevisionHash: article.sourceRevisionHash,
    createdAtMs: article.createdAtMs,
    changedAtMs: article.changedAtMs,
  };
}
