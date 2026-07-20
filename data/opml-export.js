// @ts-check

import { DELETION_STATE, STORES } from './constants.js';
import { displayTitle } from '../domain/feed-title.js';
import { META_KEYS, readMetaValue } from './meta-repository.js';
import { requestToPromise, runTransaction } from './transaction.js';

/**
 * @typedef {import('./transaction.js').TransactionOptions} RepositoryOptions
 */

/**
 * @param {RepositoryOptions} options
 */
export async function exportSubscriptions(options) {
  return runTransaction(
    [STORES.META, STORES.CATEGORIES, STORES.FEEDS],
    'readonly',
    async (transaction) => {
      const defaultCategoryId = String(await readMetaValue(transaction, META_KEYS.DEFAULT_CATEGORY_ID));
      const categories = await requestToPromise(transaction.objectStore(STORES.CATEGORIES).index('byOrder').getAll());
      const feeds = await requestToPromise(transaction.objectStore(STORES.FEEDS).index('byCategoryOrder').getAll());
      const activeFeeds = feeds.filter((feed) => feed.deletionState === DELETION_STATE.ACTIVE);
      const byCategory = groupFeedsByCategory(activeFeeds);
      return {
        categoryCount: categories.filter((category) => category.id !== defaultCategoryId && byCategory.has(category.id))
          .length,
        feedCount: activeFeeds.length,
        filename: `rssavis-subscriptions-${new Date().toISOString().slice(0, 10)}.opml`,
        xml: buildOpmlXml(categories, byCategory, defaultCategoryId),
      };
    },
    options,
  );
}

/**
 * @param {import('./models.js').FeedRecord[]} feeds
 */
function groupFeedsByCategory(feeds) {
  /** @type {Map<string, import('./models.js').FeedRecord[]>} */
  const groups = new Map();
  for (const feed of feeds) {
    const list = groups.get(feed.categoryId) ?? /** @type {import('./models.js').FeedRecord[]} */ ([]);
    list.push(feed);
    groups.set(feed.categoryId, list);
  }
  for (const list of groups.values()) {
    list.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }
  return groups;
}

/**
 * @param {import('./models.js').CategoryRecord[]} categories
 * @param {Map<string, import('./models.js').FeedRecord[]>} byCategory
 * @param {string} defaultCategoryId
 */
function buildOpmlXml(categories, byCategory, defaultCategoryId) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    '    <title>RSSavis subscriptions</title>',
    '  </head>',
    '  <body>',
  ];
  for (const category of categories) {
    const feeds = byCategory.get(category.id) ?? [];
    if (feeds.length === 0) continue;
    if (category.id === defaultCategoryId) {
      for (const feed of feeds) lines.push(`    ${feedOutline(feed)}`);
    } else {
      lines.push(`    <outline text="${escapeXml(category.title)}" title="${escapeXml(category.title)}">`);
      for (const feed of feeds) lines.push(`      ${feedOutline(feed)}`);
      lines.push('    </outline>');
    }
  }
  lines.push('  </body>', '</opml>', '');
  return lines.join('\n');
}

/**
 * @param {import('./models.js').FeedRecord} feed
 */
function feedOutline(feed) {
  const htmlUrl = feed.siteUrl ? ` htmlUrl="${escapeXml(feed.siteUrl)}"` : '';
  const label = displayTitle(feed);
  return `<outline text="${escapeXml(label)}" title="${escapeXml(label)}" type="rss" xmlUrl="${escapeXml(feed.normalizedUrl)}"${htmlUrl}/>`;
}

/**
 * @param {string} value
 */
function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
