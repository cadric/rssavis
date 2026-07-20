// @ts-check

export const SETTINGS_EFFECTS = Object.freeze({
  LANGUAGE: 'language',
  READER_SETTINGS: 'reader-settings',
  REFRESH_SCHEDULE: 'refresh-schedule',
  THEME: 'theme',
});

/** @type {Set<string>} */
const KNOWN_EFFECTS = new Set(Object.values(SETTINGS_EFFECTS));

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeSettingsEffects(value) {
  if (!Array.isArray(value)) return [];
  const effects = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !KNOWN_EFFECTS.has(item) || seen.has(item)) continue;
    seen.add(item);
    effects.push(item);
  }
  return effects;
}
