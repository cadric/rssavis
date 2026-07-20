// @ts-check

/**
 * Invalidates every article response that captured an older Reader identity.
 * @param {import('./reader-controller.js').ReaderControllerInput} input
 * @param {ReturnType<import('./reader-search-actions.js').createReaderRuntime>} runtime
 */
export function invalidateArticleLoad(input, runtime) {
  input.options.windowRef.clearTimeout(runtime.loadingTimer);
  runtime.loadingTimer = 0;
  runtime.requestSequence += 1;
}
