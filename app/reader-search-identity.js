// @ts-check

export const SEARCH_MIN_CODE_POINTS = 2;

/** @param {string} value */
export function normalizeSearchInput(value) {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
}
