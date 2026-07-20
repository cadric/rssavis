// @ts-check

import { createSettingsRepository, DEFAULT_SETTINGS } from '../data/settings-repository.js';
import { MESSAGE_TYPES } from '../domain/message-types.js';
import { SETTINGS_EFFECTS } from '../shared/settings-effects.js';

/**
 * @typedef {import('../data/settings-repository.js').StorageArea} StorageArea
 * @typedef {{onSettingsChanged?: (input: {before: import('../data/settings-repository.js').SettingsRecord, after: import('../data/settings-repository.js').SettingsRecord, effects: string[]}) => Promise<void> | void}} SettingsCommandHooks
 */

/**
 * @param {StorageArea} storageArea
 * @param {SettingsCommandHooks} [hooks]
 * @returns {Record<string, import('./command-router.js').CommandHandler>}
 */
export function createSettingsCommandHandlers(storageArea, hooks = {}) {
  const settings = createSettingsRepository(storageArea);
  return {
    [MESSAGE_TYPES.SETTINGS_GET]: async () => ({ settings: await settings.read() }),
    [MESSAGE_TYPES.SETTINGS_UPDATE]: async (payload) => {
      const before = await settings.read();
      const after = await settings.write(readPatch(payload, 'settings'));
      const effects = describeSettingsEffects(before, after);
      await hooks.onSettingsChanged?.({ before, after, effects });
      return { effects, settings: after };
    },
    [MESSAGE_TYPES.SETTINGS_RESET]: async () => {
      const before = await settings.read();
      const after = await settings.write({ ...DEFAULT_SETTINGS });
      const effects = describeSettingsEffects(before, after);
      await hooks.onSettingsChanged?.({ before, after, effects });
      return { effects, settings: after };
    },
  };
}

/**
 * @param {import('../data/settings-repository.js').SettingsRecord} before
 * @param {import('../data/settings-repository.js').SettingsRecord} after
 */
function describeSettingsEffects(before, after) {
  /** @type {string[]} */
  const effects = [];
  if (changed(before, after, ['colorScheme', 'accentColor'])) effects.push(SETTINGS_EFFECTS.THEME);
  if (changed(before, after, ['language'])) effects.push(SETTINGS_EFFECTS.LANGUAGE);
  if (
    changed(before, after, [
      'articlesPerPage',
      'defaultArticleView',
      'imageLoading',
      'lazyLoadImages',
      'markReadOnExpand',
      'markReadOnOpen',
      'markReadOnScroll',
      'openLinksMode',
    ])
  ) {
    effects.push(SETTINGS_EFFECTS.READER_SETTINGS);
  }
  if (changed(before, after, ['refreshIntervalMinutes'])) effects.push(SETTINGS_EFFECTS.REFRESH_SCHEDULE);
  return effects;
}

/**
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @param {string[]} keys
 */
function changed(before, after, keys) {
  return keys.some((key) => before[key] !== after[key]);
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} key
 */
function readPatch(payload, key) {
  const value = payload[key];
  return value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}
