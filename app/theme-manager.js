// @ts-check

import { getSettings, updateSettings } from './settings-api.js';

const THEME_MIRROR_KEY = 'rssavis.theme.v1';
const COLOR_SCHEMES = new Set(['system', 'light', 'dark']);
const ACCENT_COLORS = new Set(['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'slate']);

const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  language: 'auto',
  colorScheme: 'system',
  accentColor: 'blue',
  defaultArticleView: 'normal',
  articlesPerPage: 100,
  refreshIntervalMinutes: 30,
  feedTimeoutSeconds: 30,
  imageLoading: 'on-expand',
  lazyLoadImages: true,
  openLinksMode: 'background-tab',
  markReadOnExpand: true,
  markReadOnOpen: true,
  markReadOnScroll: false,
  purgeMaxArticles: 10000,
  purgeMaxAgeDays: 90,
  keepUnreadOnPurge: true,
  keepStarredOnPurge: true,
});

/**
 * @typedef {object} ThemeSettings
 * @property {'system' | 'light' | 'dark'} colorScheme
 * @property {'blue' | 'teal' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple' | 'slate'} accentColor
 *
 * @typedef {object} ThemeManagerOptions
 * @property {import('./api-client.js').BrowserRuntimeLike} browserApi
 * @property {HTMLElement} documentElement
 * @property {Storage} localStorageArea
 * @property {(query: string) => MediaQueryList} matchMedia
 */

/**
 * @param {ThemeManagerOptions} options
 */
export function createThemeManager(options) {
  const media = options.matchMedia('(prefers-color-scheme: dark)');
  /** @type {ThemeSettings} */
  let current = { colorScheme: 'system', accentColor: 'blue' };
  /** @type {Set<() => void>} */
  const listeners = new Set();
  let appliedSignature = '';

  const apply = () => {
    const effectiveScheme = current.colorScheme === 'system' ? (media.matches ? 'dark' : 'light') : current.colorScheme;
    options.documentElement.dataset.colorScheme = current.colorScheme;
    options.documentElement.dataset.effectiveScheme = effectiveScheme;
    options.documentElement.dataset.accentColor = current.accentColor;
    options.documentElement.style.colorScheme = effectiveScheme;
    options.localStorageArea.setItem(THEME_MIRROR_KEY, JSON.stringify(current));
    const signature = effectiveScheme;
    if (signature === appliedSignature) return;
    appliedSignature = signature;
    for (const listener of listeners) listener();
  };

  const sync = async () => {
    const settings = normalizeSettings(await getSettings(options.browserApi));
    current = { colorScheme: settings.colorScheme, accentColor: settings.accentColor };
    apply();
  };

  /**
   * @param {Record<string, unknown>} patch
   */
  const updateThemeSettings = async (patch) => {
    const result = await updateSettings(patch, options.browserApi);
    current = normalizeThemePatch({ ...current, ...patch, ...settingsFromUpdateResult(result) });
    apply();
  };

  media.addEventListener('change', apply);

  return {
    async start() {
      await sync();
    },
    /**
     * @param {'system' | 'light' | 'dark'} colorScheme
     */
    async setColorScheme(colorScheme) {
      await updateThemeSettings({ colorScheme: validateColorScheme(colorScheme) });
    },
    /**
     * @param {'blue' | 'teal' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple' | 'slate'} accentColor
     */
    async setAccentColor(accentColor) {
      await updateThemeSettings({ accentColor: validateAccentColor(accentColor) });
    },
    /**
     * @param {Record<string, unknown>} patch
     */
    applySettings(patch) {
      current = normalizeThemePatch({ ...current, ...patch });
      apply();
    },
    getTheme() {
      return { ...current };
    },
    getThemeSignature() {
      return appliedSignature;
    },
    /** @param {() => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * @param {unknown} value
 */
function normalizeSettings(value) {
  const record = isPlainRecord(value) ? value : {};
  return {
    ...DEFAULT_SETTINGS,
    ...record,
    accentColor: validateAccentColor(record.accentColor),
    colorScheme: validateColorScheme(record.colorScheme),
  };
}

/**
 * @param {Record<string, unknown>} value
 * @returns {ThemeSettings}
 */
function normalizeThemePatch(value) {
  return {
    accentColor: validateAccentColor(value.accentColor),
    colorScheme: validateColorScheme(value.colorScheme),
  };
}

/**
 * @param {unknown} value
 * @returns {'system' | 'light' | 'dark'}
 */
function validateColorScheme(value) {
  return typeof value === 'string' && COLOR_SCHEMES.has(value)
    ? /** @type {'system' | 'light' | 'dark'} */ (value)
    : 'system';
}

/**
 * @param {unknown} value
 * @returns {'blue' | 'teal' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple' | 'slate'}
 */
function validateAccentColor(value) {
  return typeof value === 'string' && ACCENT_COLORS.has(value)
    ? /** @type {'blue' | 'teal' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple' | 'slate'} */ (value)
    : 'blue';
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function settingsFromUpdateResult(value) {
  return isPlainRecord(value) && isPlainRecord(value.settings) ? value.settings : {};
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
