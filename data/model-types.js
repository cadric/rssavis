// @ts-check

// Persisted-record typedefs shared across the data and command layers. This module holds no runtime
// code; `data/models.js` re-exports each type so `import('./models.js').FeedRecord` keeps resolving.

/**
 * @typedef {object} CategoryRecord
 * @property {string} id
 * @property {string} title
 * @property {string} normalizedTitle
 * @property {number} order
 * @property {number} createdAtMs
 * @property {number} updatedAtMs
 */

/**
 * @typedef {object} FeedRecord
 * @property {string} id
 * @property {string} title
 * @property {string} customTitle
 * @property {string} url
 * @property {string} normalizedUrl
 * @property {string} resolvedUrl
 * @property {string} siteUrl
 * @property {string | null} iconUrl
 * @property {'auto' | 'favicon'} iconSource
 * @property {string} iconColor
 * @property {string} categoryId
 * @property {number} mainStreamState
 * @property {number} order
 * @property {string} permissionOrigin
 * @property {number} permissionState
 * @property {string} redirectOriginPending
 * @property {string} redirectUrlPending
 * @property {number} scheduleState
 * @property {string} etag
 * @property {string} lastModified
 * @property {number} lastCheckedAtMs
 * @property {number} lastSuccessAtMs
 * @property {number} nextFetchAtMs
 * @property {number} consecutiveFailures
 * @property {number} lastHttpStatus
 * @property {string} lastErrorCode
 * @property {string} lastErrorMessage
 * @property {number} leaseState
 * @property {string} leaseOwner
 * @property {number} leaseExpiresAtMs
 * @property {number} deletionState
 * @property {number} keepReadOnPurge
 * @property {number} createdAtMs
 * @property {number} updatedAtMs
 */

/**
 * @typedef {object} ArticleRecord
 * @property {string} id
 * @property {string} feedId
 * @property {string} primaryIdentityKey
 * @property {string} guid
 * @property {string} canonicalUrl
 * @property {string} title
 * @property {string} author
 * @property {number} publishedAtMs
 * @property {number} sourceUpdatedAtMs
 * @property {number} fetchedAtMs
 * @property {number} sortAtMs
 * @property {number} readState
 * @property {number} starredState
 * @property {string} summaryText
 * @property {string} searchText
 * @property {string} imageUrl
 * @property {number} hasBodyState
 * @property {string} sourceRevisionHash
 * @property {number} createdAtMs
 * @property {number} changedAtMs
 */

/**
 * @typedef {object} ArticleIdentityRecord
 * @property {string} key
 * @property {string} feedId
 * @property {string} articleId
 * @property {'guid' | 'url' | 'fallback'} kind
 * @property {string} valueHash
 * @property {number} createdAtMs
 */

/**
 * @typedef {object} ArticleBodyRecord
 * @property {string} articleId
 * @property {string} contentText
 * @property {number} contentLength
 * @property {number} updatedAtMs
 * @property {import('../domain/article-content-blocks.js').Block[]} contentBlocks
 */

/**
 * @typedef {object} StatsRecord
 * @property {string} id
 * @property {'global' | 'feed'} scopeType
 * @property {string} scopeId
 * @property {number} articleCount
 * @property {number} unreadCount
 * @property {number} starredCount
 * @property {number} lastArticleAtMs
 * @property {number} updatedAtMs
 */

export {};
