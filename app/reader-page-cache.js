// @ts-check

export const READER_PAGE_CACHE_LIMIT = 8;

/**
 * @typedef {object} ReaderPageCacheEntry
 * @property {number} availabilityRevision
 * @property {number} dataRevision
 * @property {'' | 'filtered-unread' | 'filtered-read'} emptyVariant
 * @property {'all' | 'unread' | 'read'} filter
 * @property {boolean} hasMore
 * @property {Array<Record<string, unknown>>} items
 * @property {string | null} nextCursor
 * @property {string} queryKey
 * @property {import('../domain/scopes.js').Scope} scope
 * @property {boolean} stale
 * @property {'empty' | 'ready'} status
 */

/**
 * Session-only LRU for successful Reader query windows.
 * @param {number} [limit]
 * @param {{onEvict?(queryKey: string): void}} [options]
 */
export function createReaderPageCache(limit = READER_PAGE_CACHE_LIMIT, options = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Reader page cache limit must be positive.');
  /** @type {Map<string, ReaderPageCacheEntry>} */
  const entries = new Map();
  /** @type {Map<string, number>} */
  const pendingArticleFlagRevision = new Map();

  /** @param {string} queryKey @param {boolean} touch */
  function read(queryKey, touch) {
    const cached = entries.get(queryKey);
    if (!cached) return null;
    if (touch) {
      entries.delete(queryKey);
      entries.set(queryKey, cached);
    }
    return cached;
  }

  /** @param {string} queryKey */
  function evict(queryKey) {
    if (!entries.delete(queryKey)) return;
    pendingArticleFlagRevision.delete(queryKey);
    options.onEvict?.(queryKey);
  }

  return {
    /** @param {string} queryKey */
    get(queryKey) {
      const cached = read(queryKey, false);
      if (!cached || cached.stale) return null;
      return read(queryKey, true);
    },
    /** @param {string} queryKey */
    peek(queryKey) {
      return read(queryKey, false);
    },
    /** @param {ReaderPageCacheEntry} entry */
    set(entry) {
      const next = copyEntry(entry);
      entries.delete(next.queryKey);
      pendingArticleFlagRevision.delete(next.queryKey);
      entries.set(next.queryKey, next);
      while (entries.size > limit) evict(entries.keys().next().value ?? '');
      return next;
    },
    /** @param {string} queryKey */
    markStale(queryKey) {
      const current = read(queryKey, false);
      pendingArticleFlagRevision.delete(queryKey);
      if (current && !current.stale) entries.set(queryKey, { ...current, stale: true });
    },
    /** @param {string} queryKey @param {number} dataRevision */
    markArticleFlagPending(queryKey, dataRevision) {
      const current = read(queryKey, false);
      if (!current || (current.stale && !pendingArticleFlagRevision.has(queryKey))) return;
      entries.set(queryKey, { ...current, stale: true });
      pendingArticleFlagRevision.set(queryKey, Math.max(pendingArticleFlagRevision.get(queryKey) ?? 0, dataRevision));
    },
    /** @param {number} dataRevision */
    markOlderThan(dataRevision) {
      if (!Number.isSafeInteger(dataRevision) || dataRevision < 0) return;
      for (const [queryKey, current] of entries) {
        if (current.dataRevision < dataRevision && !current.stale) {
          entries.set(queryKey, { ...current, stale: true });
        }
      }
    },
    /** @param {string} queryKey @param {number} dataRevision */
    raiseAvailability(queryKey, dataRevision) {
      const current = read(queryKey, false);
      if (!current || !Number.isSafeInteger(dataRevision) || dataRevision < 0) return;
      entries.set(queryKey, {
        ...current,
        availabilityRevision: Math.max(current.availabilityRevision, dataRevision),
      });
    },
    /** @param {string} queryKey @param {Partial<Pick<ReaderPageCacheEntry, 'dataRevision' | 'items'>>} patch */
    updatePage(queryKey, patch) {
      const current = read(queryKey, false);
      if (!current) return;
      entries.set(queryKey, {
        ...current,
        ...(Number.isSafeInteger(patch.dataRevision) ? { dataRevision: patch.dataRevision } : {}),
        ...(Array.isArray(patch.items) ? { items: [...patch.items] } : {}),
      });
    },
    /**
     * @param {string} articleId
     * @param {'readState' | 'starredState'} field
     * @param {number} expectedValue
     * @param {number} nextValue
     * @param {import('./api-validation.js').BootstrapSnapshot} snapshot
     * @param {Record<string, unknown>} article
     */
    patchArticleField(articleId, field, expectedValue, nextValue, snapshot, article) {
      for (const [queryKey, current] of entries) {
        let itemChanged = false;
        const containsArticle = current.items.some((item) => item.id === articleId);
        const items = current.items.map((item) => {
          if (item.id !== articleId || numberValue(item[field]) !== expectedValue) return item;
          itemChanged = true;
          return { ...item, [field]: nextValue };
        });
        const membershipSensitive =
          scopeMayContainArticle(current.scope, article, snapshot) &&
          (field === 'readState'
            ? current.filter !== 'all' || (current.scope.type === 'system' && current.scope.id === 'unread')
            : current.scope.type === 'system' && current.scope.id === 'starred');
        if (!itemChanged && !membershipSensitive) continue;
        entries.set(queryKey, {
          ...current,
          items: itemChanged ? items : current.items,
          stale: current.stale || membershipSensitive || (containsArticle && !itemChanged),
        });
      }
    },
    /**
     * Resolves a bounded article-flag event from the background-owned article
     * record. Membership-sensitive pages keep their sticky stale marker, while
     * an otherwise fresh page can clear only the flag-pending marker that this
     * authoritative value covers.
     * @param {string} articleId
     * @param {'readState' | 'starredState'} field
     * @param {number} nextValue
     * @param {number} dataRevision
     * @param {import('./api-validation.js').BootstrapSnapshot} snapshot
     * @param {Record<string, unknown>} article
     */
    applyAuthoritativeArticleField(articleId, field, nextValue, dataRevision, snapshot, article) {
      for (const [queryKey, current] of entries) {
        const containsArticle = current.items.some((item) => item.id === articleId);
        const membershipSensitive =
          scopeMayContainArticle(current.scope, article, snapshot) &&
          (field === 'readState'
            ? current.filter !== 'all' || (current.scope.type === 'system' && current.scope.id === 'unread')
            : current.scope.type === 'system' && current.scope.id === 'starred');
        if (!containsArticle && !membershipSensitive) continue;
        const pendingRevision = pendingArticleFlagRevision.get(queryKey) ?? 0;
        const pendingCovered = pendingRevision > 0 && pendingRevision <= dataRevision;
        const items = containsArticle
          ? current.items.map((item) => (item.id === articleId ? { ...item, [field]: nextValue } : item))
          : current.items;
        entries.set(queryKey, {
          ...current,
          dataRevision: Math.max(current.dataRevision, dataRevision),
          items,
          stale: membershipSensitive || (current.stale && !pendingCovered),
        });
        if (pendingCovered) pendingArticleFlagRevision.delete(queryKey);
      }
    },
    /** @param {{categories?: Array<{id?: string}>, feeds?: Array<{categoryId?: string, id?: string}>}} snapshot */
    evictUnavailable(snapshot) {
      const feedIds = new Set((snapshot.feeds ?? []).map((feed) => feed.id).filter(Boolean));
      const categoryIds = new Set((snapshot.categories ?? []).map((category) => category.id).filter(Boolean));
      const populatedCategoryIds = new Set((snapshot.feeds ?? []).map((feed) => feed.categoryId).filter(Boolean));
      for (const [key, current] of entries) {
        const unavailableFeed = current.scope.type === 'feed' && !feedIds.has(current.scope.id);
        const unavailableCategory =
          current.scope.type === 'category' &&
          (!categoryIds.has(current.scope.id) || !populatedCategoryIds.has(current.scope.id));
        if (unavailableFeed || unavailableCategory) evict(key);
      }
    },
    clear() {
      for (const key of [...entries.keys()]) evict(key);
      pendingArticleFlagRevision.clear();
    },
    values() {
      return [...entries.values()];
    },
  };
}

/**
 * @param {import('../domain/scopes.js').Scope} scope
 * @param {Record<string, unknown>} article
 * @param {import('./api-validation.js').BootstrapSnapshot} snapshot
 */
function scopeMayContainArticle(scope, article, snapshot) {
  const feedId = typeof article.feedId === 'string' ? article.feedId : '';
  if (scope.type === 'system') {
    if (scope.id !== 'main') return true;
    return snapshot.feeds.some((feed) => feed.id === feedId && feed.mainStreamState === 1);
  }
  if (scope.type === 'feed') return scope.id === feedId;
  return snapshot.feeds.some((feed) => feed.id === feedId && feed.categoryId === scope.id);
}

/** @param {unknown} value */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {ReaderPageCacheEntry} entry
 * @param {import('./reader-state.js').ArticleState} previous
 * @param {{expandedArticleId?: string, preserveSearchQuery?: boolean}} [options]
 * @returns {import('./reader-state.js').ArticleState}
 */
export function articleStateFromCachedPage(entry, previous, options = {}) {
  const availabilityRevision = Math.max(0, entry.availabilityRevision);
  const hasPendingAvailability = availabilityRevision > 0;
  const expandedArticleId = options.expandedArticleId ?? '';
  const preview = expandedArticleId ? previous.previewByArticleId[expandedArticleId] : null;
  const expansionStillPresent = entry.items.some((item) => item.id === expandedArticleId);
  return {
    busy: false,
    dataRevision: entry.dataRevision,
    emptyVariant: entry.emptyVariant,
    freezeReadyRows: entry.status === 'ready' && hasPendingAvailability,
    hasMore: entry.hasMore,
    items: [...entry.items],
    loadingStatusVisible: false,
    newArticlesAvailable: hasPendingAvailability
      ? { busy: false, dataRevision: availabilityRevision, queryKey: entry.queryKey }
      : null,
    nextCursor: entry.nextCursor,
    previewByArticleId: preview && expansionStillPresent ? { [expandedArticleId]: preview } : {},
    searchActive: false,
    searchQuery: options.preserveSearchQuery ? previous.searchQuery : '',
    settings: previous.settings,
    status: entry.status,
    statusAction: entry.emptyVariant ? 'show-all' : '',
    statusCanRetry: false,
    statusMessage: '',
  };
}

/** @param {ReaderPageCacheEntry} entry @returns {ReaderPageCacheEntry} */
function copyEntry(entry) {
  if (!entry || typeof entry.queryKey !== 'string' || !entry.queryKey) {
    throw new TypeError('Reader page cache entry requires a query key.');
  }
  return {
    ...entry,
    items: [...entry.items],
    scope: { ...entry.scope },
  };
}
