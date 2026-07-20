// @ts-check

import { STATE } from './constants.js';
import { collectArticlePage, resolvePlanInTransaction } from './query-planner.js';

const COUNT_PAGE_SIZE = 250;

/**
 * @param {IDBTransaction} transaction
 * @param {import('../domain/scopes.js').Scope} scope
 * @param {number} batchSize
 * @returns {Promise<import('./models.js').ArticleRecord[]>}
 */
export async function collectUnreadForScope(transaction, scope, batchSize) {
  const plan = await resolvePlanInTransaction(transaction, scope, STATE.OFF);
  if (plan.strategy === 'empty') return [];
  return (await collectArticlePage(transaction, plan, batchSize, null)).items;
}

/**
 * @param {IDBTransaction} transaction
 * @param {import('../domain/scopes.js').Scope} scope
 */
export async function countUnreadForScope(transaction, scope) {
  const plan = await resolvePlanInTransaction(transaction, scope, STATE.OFF);
  if (plan.strategy === 'empty') return 0;
  let total = 0;
  /** @type {{lastKey?: unknown[], feedCursors?: Record<string, unknown[]>} | null} */
  let cursor = null;
  do {
    const page = await collectArticlePage(
      transaction,
      plan,
      COUNT_PAGE_SIZE,
      /** @type {import('./pagination.js').CursorPayload | null} */ (cursor),
    );
    total += page.items.length;
    cursor = page.cursorState;
  } while (cursor);
  return total;
}
