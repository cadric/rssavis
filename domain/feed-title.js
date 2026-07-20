// @ts-check

// Feed display-title resolution shared by the app (sidebar, management, article rows) and the data
// layer (OPML export). The user's `customTitle` wins over the remote `title`; an empty custom title
// falls back to the remote title so an unset feed shows its fetched name.

/**
 * @param {{customTitle?: unknown, title?: unknown}} feed
 * @returns {string}
 */
export function displayTitle(feed) {
  const custom = typeof feed.customTitle === 'string' ? feed.customTitle : '';
  if (custom) return custom;
  return typeof feed.title === 'string' ? feed.title : '';
}

/**
 * Builds a `feedId → customTitle` lookup from a feeds snapshot, keeping only feeds whose custom title
 * is a non-empty string. The denormalized article surfaces read this map instead of re-denormalizing
 * `feedTitle` onto every article row.
 * @param {Iterable<{id?: unknown, customTitle?: unknown}>} feeds
 * @returns {Map<string, string>}
 */
export function customTitleMap(feeds) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const feed of feeds) {
    const id = typeof feed.id === 'string' ? feed.id : '';
    const custom = typeof feed.customTitle === 'string' ? feed.customTitle : '';
    if (id && custom) map.set(id, custom);
  }
  return map;
}

/**
 * @param {Map<string, string> | undefined} map
 * @param {unknown} feedId
 * @param {unknown} fallbackTitle
 * @returns {string}
 */
export function feedTitleOr(map, feedId, fallbackTitle) {
  const id = typeof feedId === 'string' ? feedId : '';
  const custom = id && map ? map.get(id) : undefined;
  if (custom) return custom;
  return typeof fallbackTitle === 'string' ? fallbackTitle : '';
}
