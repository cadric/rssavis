// @ts-check

/** @type {WeakMap<Array<Record<string, unknown>>, {key: string, items: Array<Record<string, unknown>>}>} */
const overlayCache = new WeakMap();

/**
 * Overlays the current bootstrap-owned feed presentation fields without
 * mutating query DTOs or requiring another article query.
 * @param {Array<Record<string, unknown>>} items
 * @param {Array<import('./api-validation.js').BootstrapFeed>} feeds
 */
export function overlayCurrentFeedMetadata(items, feeds) {
  const feedById = new Map(feeds.map((feed) => [feed.id, feed]));
  const key = metadataKey(items, feedById);
  const cached = overlayCache.get(items);
  if (cached?.key === key) return cached.items;
  let changed = false;
  const next = items.map((article) => {
    const feedId = stringValue(article.feedId);
    const feed = feedById.get(feedId);
    if (!feed) return article;
    const patch = {
      feedIconColor: feed.iconColor,
      feedIconSource: feed.iconSource,
      feedIconUrl: feed.iconUrl,
      feedSiteUrl: feed.siteUrl,
      feedUrl: feed.url,
    };
    if (Object.entries(patch).every(([field, value]) => Object.is(article[field], value))) return article;
    changed = true;
    return { ...article, ...patch };
  });
  const result = changed ? next : items;
  overlayCache.set(items, { items: result, key });
  return result;
}

/**
 * @param {Array<Record<string, unknown>>} items
 * @param {Map<string, import('./api-validation.js').BootstrapFeed>} feedById
 */
function metadataKey(items, feedById) {
  const ids = [...new Set(items.map((article) => stringValue(article.feedId)).filter(Boolean))].sort();
  return JSON.stringify(
    ids.map((id) => {
      const feed = feedById.get(id);
      return feed ? [id, feed.iconColor, feed.iconSource, feed.iconUrl, feed.siteUrl, feed.url] : [id, null];
    }),
  );
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === 'string' ? value : '';
}
