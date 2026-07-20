// @ts-check

/** @type {WeakMap<object, Map<string, number>>} */
const generationsByOwner = new WeakMap();

/**
 * Records the latest local flag intent for one article field. Read and star
 * generations are independent so one completion cannot suppress the other.
 * @param {object} owner
 * @param {string} articleId
 * @param {'readState' | 'starredState'} field
 */
export function noteArticleFlagIntent(owner, articleId, field) {
  const generations = generationsFor(owner);
  const key = flagIntentKey(articleId, field);
  const next = (generations.get(key) ?? 0) + 1;
  generations.set(key, next);
  return next;
}

/** @param {object} owner @param {string} articleId @param {'readState' | 'starredState'} field */
export function articleFlagIntentGeneration(owner, articleId, field) {
  return generationsByOwner.get(owner)?.get(flagIntentKey(articleId, field)) ?? 0;
}

/**
 * Records a user/workflow read-state intent on the stable Reader controller
 * input. Async automatic completions use the generation to avoid overwriting
 * a newer intent for the same article.
 * @param {object} owner
 * @param {string} articleId
 */
export function noteArticleReadIntent(owner, articleId) {
  return noteArticleFlagIntent(owner, articleId, 'readState');
}

/** @param {object} owner @param {string} articleId */
export function articleReadIntentGeneration(owner, articleId) {
  return articleFlagIntentGeneration(owner, articleId, 'readState');
}

/** @param {string} articleId @param {'readState' | 'starredState'} field */
function flagIntentKey(articleId, field) {
  return `${field}\n${articleId}`;
}

/** @param {object} owner */
function generationsFor(owner) {
  let generations = generationsByOwner.get(owner);
  if (!generations) {
    generations = new Map();
    generationsByOwner.set(owner, generations);
  }
  return generations;
}
