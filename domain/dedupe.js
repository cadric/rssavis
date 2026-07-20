// @ts-check

import { createAppError, ERROR_CODES } from './errors.js';
import { sha256Hex } from './hashing.js';
import { normalizePlainText } from './text.js';
import { normalizeArticleUrl } from './urls.js';

export const ALIAS_SEPARATOR = '\u001f';
export const MAX_ALIASES_PER_ARTICLE = 8;

const KIND_PRIORITY = Object.freeze({ guid: 1, url: 2, fallback: 3 });

/**
 * @typedef {'guid' | 'url' | 'fallback'} AliasKind
 * @typedef {object} IdentityAlias
 * @property {AliasKind} kind
 * @property {string} valueHash
 * @property {string} key
 * @property {number} priority
 *
 * @typedef {object} IdentityInput
 * @property {string} feedId
 * @property {string} [guid]
 * @property {string} [canonicalUrl]
 * @property {string} title
 * @property {number} [publishedAtMs]
 * @property {string} [summaryText]
 */

/**
 * @param {IdentityInput} input
 * @returns {Promise<IdentityAlias[]>}
 */
export async function buildIdentityAliases(input) {
  /** @type {IdentityAlias[]} */
  const aliases = [];
  const guid = normalizeOptionalText(input.guid, 2048);
  const title = normalizeOptionalText(input.title, 2048);
  const summary = normalizeOptionalText(input.summaryText, 32768);
  const url = input.canonicalUrl ? normalizeArticleUrl(input.canonicalUrl) : '';
  if (guid) aliases.push(await createAlias(input.feedId, 'guid', guid));
  if (url) aliases.push(await createAlias(input.feedId, 'url', url));
  if (title && Number.isSafeInteger(input.publishedAtMs) && Number(input.publishedAtMs) > 0) {
    aliases.push(
      await createAlias(input.feedId, 'fallback', `v1\0title-date\0${title.toLowerCase()}\0${input.publishedAtMs}`),
    );
  }
  if (title && url)
    aliases.push(await createAlias(input.feedId, 'fallback', `v1\0title-url\0${title.toLowerCase()}\0${url}`));
  if (title && summary) {
    aliases.push(
      await createAlias(
        input.feedId,
        'fallback',
        `v1\0title-summary\0${title.toLowerCase()}\0${summary.slice(0, 512)}`,
      ),
    );
  }
  return sortAliasesForStorage(dedupeAliases(aliases)).slice(0, MAX_ALIASES_PER_ARTICLE);
}

/**
 * @param {string} feedId
 * @param {AliasKind} kind
 * @param {string} valueHash
 * @returns {string}
 */
export function buildAliasKey(feedId, kind, valueHash) {
  validateAliasKind(kind);
  if (!/^[0-9a-f]{64}$/.test(valueHash)) {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field: 'valueHash', reason: 'invalid hash' } });
  }
  return `${feedId}${ALIAS_SEPARATOR}${kind}${ALIAS_SEPARATOR}${valueHash}`;
}

/**
 * @param {string} feedId
 * @param {string} primaryIdentityKey
 * @returns {Promise<string>}
 */
export async function buildArticleId(feedId, primaryIdentityKey) {
  return `art_${await sha256Hex(`${feedId}\0${primaryIdentityKey}`)}`;
}

/**
 * @param {IdentityAlias[]} aliases
 * @returns {IdentityAlias[]}
 */
export function sortAliasesForStorage(aliases) {
  return [...aliases].sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key));
}

/**
 * @template {{aliases: IdentityAlias[], sourceOrder: number, article: Record<string, unknown>, body?: {contentText?: string, contentBlocks?: unknown[]} | null}} T
 * @param {T[]} preparedArticles
 * @returns {T[]}
 */
export function dedupePreparedArticles(preparedArticles) {
  /** @type {Array<{items: T[], aliasKeys: Set<string>, sourceOrder: number}>} */
  const groups = [];
  const aliasToGroup = new Map();
  for (const article of preparedArticles) {
    const matching = new Set(
      article.aliases.map((alias) => aliasToGroup.get(alias.key)).filter((index) => index !== undefined),
    );
    const targetIndex = matching.size > 0 ? Math.min(...matching) : groups.length;
    if (!groups[targetIndex])
      groups[targetIndex] = { items: [], aliasKeys: new Set(), sourceOrder: article.sourceOrder };
    const target = groups[targetIndex];
    target.items.push(article);
    target.sourceOrder = Math.min(target.sourceOrder, article.sourceOrder);
    for (const alias of article.aliases) {
      target.aliasKeys.add(alias.key);
      aliasToGroup.set(alias.key, targetIndex);
    }
    for (const index of [...matching].filter((index) => index !== targetIndex).sort((a, b) => b - a)) {
      const group = groups[index];
      target.items.push(...group.items);
      target.sourceOrder = Math.min(target.sourceOrder, group.sourceOrder);
      for (const key of group.aliasKeys) {
        target.aliasKeys.add(key);
        aliasToGroup.set(key, targetIndex);
      }
      groups.splice(index, 1);
      for (const [key, value] of aliasToGroup) if (value > index) aliasToGroup.set(key, value - 1);
    }
  }
  return groups
    .map((group) => {
      const winner = [...group.items].sort((left, right) => compareCompleteness(left, right))[0];
      const aliases = sortAliasesForStorage(dedupeAliases(group.items.flatMap((item) => item.aliases))).slice(
        0,
        MAX_ALIASES_PER_ARTICLE,
      );
      return { ...winner, aliases, sourceOrder: group.sourceOrder };
    })
    .sort((left, right) => left.sourceOrder - right.sourceOrder);
}

/**
 * @param {IdentityAlias[]} aliases
 * @returns {IdentityAlias[]}
 */
export function dedupeAliases(aliases) {
  return [...new Map(aliases.map((alias) => [alias.key, alias])).values()];
}

/**
 * @param {string} feedId
 * @param {AliasKind} kind
 * @param {string} material
 */
async function createAlias(feedId, kind, material) {
  const valueHash = await sha256Hex(material);
  return { kind, valueHash, key: buildAliasKey(feedId, kind, valueHash), priority: KIND_PRIORITY[kind] };
}

/**
 * @param {AliasKind} kind
 */
function validateAliasKind(kind) {
  if (kind !== 'guid' && kind !== 'url' && kind !== 'fallback') {
    throw createAppError(ERROR_CODES.VALIDATION_ERROR, { details: { field: 'kind', reason: 'invalid identity kind' } });
  }
}

/**
 * @param {unknown} value
 * @param {number} maxCodePoints
 */
function normalizeOptionalText(value, maxCodePoints) {
  if (value === undefined || value === null || value === '') return '';
  return normalizePlainText(String(value), { maxCodePoints });
}

/**
 * @template {{aliases: IdentityAlias[], sourceOrder: number, article: Record<string, unknown>, body?: {contentText?: string, contentBlocks?: unknown[]} | null}} T
 * @param {T} left
 * @param {T} right
 */
function compareCompleteness(left, right) {
  return completenessScore(right) - completenessScore(left) || left.sourceOrder - right.sourceOrder;
}

/**
 * @param {{aliases: IdentityAlias[], article: Record<string, unknown>, body?: {contentText?: string, contentBlocks?: unknown[]} | null}} item
 */
function completenessScore(item) {
  const title = typeof item.article.title === 'string' ? item.article.title : '';
  const canonicalUrl = typeof item.article.canonicalUrl === 'string' ? item.article.canonicalUrl : '';
  const guid = typeof item.article.guid === 'string' ? item.article.guid : '';
  const summaryText = typeof item.article.summaryText === 'string' ? item.article.summaryText : '';
  return (
    item.aliases.length * 1000 +
    (item.body?.contentText?.length ?? 0) +
    // B35: a body with sanitized rich blocks outranks an equal (or near-equal) plain-text body, since it
    // carries structure the reader view can render. 500 is below the per-alias term (1000) so identity
    // strength still dominates, and modest next to a real full-article contentText length (hundreds to tens
    // of thousands of chars), so a substantially longer plain body still wins over a short rich one — this
    // is a tie-breaking tilt, not an override.
    (item.body?.contentBlocks?.length ? 500 : 0) +
    summaryText.length +
    (title ? 50 : 0) +
    (canonicalUrl ? 25 : 0) +
    (guid ? 25 : 0)
  );
}
