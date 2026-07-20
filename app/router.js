// @ts-check

const ROUTES = new Set(['reader', 'settings', 'help']);

/** @typedef {'reader' | 'settings' | 'help'} AppMode */
/** @typedef {{mode: AppMode, search: boolean, searchOrigin?: 'reader' | 'settings', legacyOverlay?: 'about' | 'shortcuts'}} AppRoute */

/**
 * @typedef {object} RouterOptions
 * @property {Window} windowRef
 * @property {(route: AppRoute) => Promise<void>} onNavigate
 */

/**
 * @param {RouterOptions} options
 */
export function createRouter(options) {
  /** @type {Array<() => void>} */
  const pendingHashResolves = [];

  async function handleHashRoute() {
    try {
      await options.onNavigate(routeFromHash(options.windowRef.location.hash) ?? { mode: 'reader', search: false });
    } finally {
      pendingHashResolves.shift()?.();
    }
  }

  /**
   * @param {string} hash
   * @param {AppRoute} route
   */
  async function navigateHash(hash, route) {
    if (options.windowRef.location.hash === hash) {
      await options.onNavigate(route);
      return;
    }
    /** @type {Promise<void>} */
    const changed = new Promise((resolve) => {
      pendingHashResolves.push(resolve);
    });
    options.windowRef.location.hash = hash;
    await changed;
  }

  return {
    /**
     * @param {AppMode} fallback
     */
    async start(fallback) {
      await options.onNavigate(routeFromHash(options.windowRef.location.hash) ?? { mode: fallback, search: false });
      options.windowRef.addEventListener('hashchange', () => {
        void handleHashRoute();
      });
    },
    /**
     * @param {AppMode} mode
     */
    async navigate(mode) {
      if (!ROUTES.has(mode)) return;
      await navigateHash(`#/${mode}`, { mode, search: false });
    },
    /**
     * @param {'reader' | 'settings'} [origin]
     */
    async navigateSearch(origin = 'reader') {
      const searchOrigin = origin === 'settings' ? 'settings' : 'reader';
      const hash = searchOrigin === 'settings' ? '#/search/settings' : '#/search';
      await navigateHash(hash, { mode: 'reader', search: true, searchOrigin });
    },
  };
}

/**
 * @param {string} hash
 * @returns {AppRoute | null}
 */
function routeFromHash(hash) {
  const route = hash.replace(/^#\/?/, '');
  if (route === 'search') return { mode: 'reader', search: true, searchOrigin: 'reader' };
  if (route === 'search/settings') return { mode: 'reader', search: true, searchOrigin: 'settings' };
  if (route === 'about' || route === 'shortcuts') return { mode: 'reader', search: false, legacyOverlay: route };
  return ROUTES.has(route) ? { mode: /** @type {AppMode} */ (route), search: false } : null;
}
