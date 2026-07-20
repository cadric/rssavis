// @ts-check

import { READER_PAGE_CACHE_LIMIT } from './reader-page-cache.js';

/**
 * Keeps an unapplied event revision independent from page-cache residency.
 * A failed bootstrap/query must not become covered merely because its cache
 * entry was evicted or because the snapshot revision was observed.
 * @param {import('./reader-controller.js').ReaderRuntime} runtime
 * @param {string} queryKey
 * @param {number} dataRevision
 * @param {boolean} [membershipReconcile]
 */
export function raiseReaderPageRevisionFloor(runtime, queryKey, dataRevision, membershipReconcile = false) {
  if (!queryKey || !Number.isSafeInteger(dataRevision) || dataRevision < 0) return;
  const nextFloor = Math.max(runtime.pageRevisionFloors.get(queryKey) ?? 0, dataRevision);
  runtime.pageRevisionFloors.delete(queryKey);
  runtime.pageRevisionFloors.set(queryKey, nextFloor);
  if (membershipReconcile) runtime.membershipReconcileQueryKeys.add(queryKey);
  while (runtime.pageRevisionFloors.size > READER_PAGE_CACHE_LIMIT) {
    const oldest = runtime.pageRevisionFloors.keys().next().value ?? '';
    runtime.pageRevisionFloors.delete(oldest);
    runtime.membershipReconcileQueryKeys.delete(oldest);
  }
}
