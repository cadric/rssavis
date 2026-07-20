// @ts-check

import { mergeReaderRefreshIntents } from './reader-refresh-plan.js';

export const READER_REFRESH_QUIET_MS = 250;

/**
 * @template T
 * @typedef {{promise: Promise<T>, reject(error: unknown): void, resolve(value: T): void}} Deferred
 */

/**
 * @template T
 * @param {{execute(intent: import('./reader-refresh-plan.js').ReaderRefreshIntent): Promise<T> | T, quietMs?: number, setTimeoutFn?: typeof setTimeout, clearTimeoutFn?: typeof clearTimeout}} options
 */
export function createReaderRefreshCoordinator(options) {
  const quietMs = options.quietMs ?? READER_REFRESH_QUIET_MS;
  const setTimer = options.setTimeoutFn ?? setTimeout;
  const clearTimer = options.clearTimeoutFn ?? clearTimeout;
  /** @type {import('./reader-refresh-plan.js').ReaderRefreshIntent | null} */
  let pending = null;
  /** @type {Deferred<T> | null} */
  let pendingResult = null;
  /** @type {import('./reader-refresh-plan.js').ReaderRefreshIntent | null} */
  let afterResetPending = null;
  /** @type {Deferred<T> | null} */
  let afterResetResult = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let readyAt = 0;
  let active = false;
  /** @type {import('./reader-refresh-plan.js').ReaderRefreshIntent | null} */
  let activeIntent = null;
  /** @type {Promise<T> | null} */
  let activeResult = null;
  let holdCount = 0;
  let epoch = 1;
  /** @type {import('./reader-refresh-plan.js').ReaderRefreshIntent | null} */
  let deferredIntent = null;
  /** @type {{operation: Promise<unknown>, options: {preserveResolvedOnError: boolean}} | null} */
  let bootstrapInFlight = null;
  /** @type {Map<string, {isCurrent(): boolean, operation: Promise<unknown>, scopeSequence: number}>} */
  const resetInFlight = new Map();

  function arm() {
    if (active || !pending) return;
    if (holdCount > 0 && pending.kind !== 'hard-reset') return;
    if (timer !== null) clearTimer(timer);
    const immediate = pending.kind === 'hard-reset';
    const delay = immediate ? 0 : Math.max(0, readyAt - Date.now());
    timer = setTimer(() => {
      timer = null;
      void drain();
    }, delay);
  }

  async function drain() {
    if (active || !pending || !pendingResult) return;
    const next = pending;
    const result = pendingResult;
    pending = null;
    pendingResult = null;
    active = true;
    activeIntent = next;
    activeResult = result.promise;
    if (next.revisionReset) epoch = Math.max(epoch + 1, next.readerEpoch);
    try {
      result.resolve(await options.execute(next));
    } catch (error) {
      result.reject(error);
    } finally {
      active = false;
      activeIntent = null;
      activeResult = null;
      if (!pending && afterResetPending && afterResetResult) {
        pending = afterResetPending;
        pendingResult = afterResetResult;
        afterResetPending = null;
        afterResetResult = null;
        readyAt = Date.now() + quietMs;
      }
      arm();
    }
  }

  /** @param {import('./reader-refresh-plan.js').ReaderRefreshIntent} intent */
  function queueAfterReset(intent) {
    if (!afterResetResult) afterResetResult = deferred();
    afterResetPending = mergeReaderRefreshIntents(afterResetPending, intent);
    return afterResetResult.promise;
  }

  return {
    /** @param {import('./reader-refresh-plan.js').ReaderRefreshIntent} intent */
    schedule(intent) {
      if (
        activeIntent?.revisionReset === true &&
        intent.revisionReset === true &&
        (activeIntent.readerEpoch === intent.readerEpoch || epoch === intent.readerEpoch) &&
        activeIntent.queryKey === intent.queryKey &&
        activeIntent.scopeSequence === intent.scopeSequence &&
        activeIntent.targetRevision === intent.targetRevision &&
        activeResult
      ) {
        return activeResult;
      }
      if (!intent.revisionReset && (activeIntent?.revisionReset === true || pending?.revisionReset === true)) {
        return queueAfterReset(intent);
      }
      if (!pendingResult) pendingResult = deferred();
      const result = pendingResult.promise;
      pending = mergeReaderRefreshIntents(pending, intent);
      readyAt = pending.kind === 'hard-reset' ? Date.now() : Date.now() + quietMs;
      arm();
      return result;
    },
    /** @param {import('./reader-refresh-plan.js').ReaderRefreshIntent} intent */
    defer(intent) {
      deferredIntent = mergeReaderRefreshIntents(deferredIntent, intent);
    },
    hasDeferred() {
      return deferredIntent !== null;
    },
    hold() {
      holdCount += 1;
      if (timer !== null && pending?.kind !== 'hard-reset') {
        clearTimer(timer);
        timer = null;
      }
      let released = false;
      return () => {
        if (released) return Promise.resolve(null);
        released = true;
        holdCount = Math.max(0, holdCount - 1);
        arm();
        return holdCount === 0 && pendingResult ? pendingResult.promise : Promise.resolve(null);
      };
    },
    resume() {
      if (!deferredIntent) return Promise.resolve(null);
      const next = deferredIntent;
      deferredIntent = null;
      return this.schedule(next);
    },
    /**
     * @template V
     * @param {(options: {preserveResolvedOnError: boolean}) => Promise<V> | V} task
     * @param {{preserveResolvedOnError?: boolean}} [requestOptions]
     * @returns {Promise<V>}
     */
    bootstrap(task, requestOptions = {}) {
      if (bootstrapInFlight) {
        if (requestOptions.preserveResolvedOnError) bootstrapInFlight.options.preserveResolvedOnError = true;
        return /** @type {Promise<V>} */ (bootstrapInFlight.operation);
      }
      const mergedOptions = { preserveResolvedOnError: requestOptions.preserveResolvedOnError === true };
      /** @type {Promise<V>} */
      let operation;
      try {
        operation = Promise.resolve(task(mergedOptions));
      } catch (error) {
        operation = Promise.reject(error);
      }
      bootstrapInFlight = { operation, options: mergedOptions };
      const owned = operation;
      const release = () => {
        if (bootstrapInFlight?.operation === owned) bootstrapInFlight = null;
      };
      void owned.then(release, release);
      return owned;
    },
    /**
     * @template V
     * @param {import('./reader-refresh-plan.js').ReaderRefreshIntent} identity
     * @param {() => Promise<V> | V} task
     * @param {{isCurrent?: () => boolean}} [requestOptions]
     * @returns {Promise<V>}
     */
    reset(identity, task, requestOptions = {}) {
      const key = [identity.readerEpoch, identity.queryKey, identity.targetRevision].join('\n');
      const current = resetInFlight.get(key);
      if (current?.scopeSequence === identity.scopeSequence && current.isCurrent()) {
        return /** @type {Promise<V>} */ (current.operation);
      }
      let operation;
      try {
        operation = Promise.resolve(task());
      } catch (error) {
        operation = Promise.reject(error);
      }
      resetInFlight.set(key, {
        isCurrent: requestOptions.isCurrent ?? (() => true),
        operation,
        scopeSequence: identity.scopeSequence,
      });
      const release = () => {
        if (resetInFlight.get(key)?.operation === operation) resetInFlight.delete(key);
      };
      void operation.then(release, release);
      return operation;
    },
    readerEpoch() {
      return epoch;
    },
  };
}

/** @template T @returns {Deferred<T>} */
function deferred() {
  /** @type {(value: T) => void} */
  let resolve = () => {};
  /** @type {(error: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}
