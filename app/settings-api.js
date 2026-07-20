// @ts-check

import { MESSAGE_TYPES } from '../shared/messages.js';
import { sendRuntimeMessage, unwrapRuntimeResult } from './api-client.js';

/**
 * @typedef {import('./api-client.js').BrowserRuntimeLike} BrowserRuntimeLike
 */

/**
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function getSettings(browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.SETTINGS_GET, {}, browserApi).then((response) => {
    const data = unwrapRuntimeResult(response);
    return isRecord(data) && isRecord(data.settings) ? data.settings : {};
  });
}

/**
 * @param {Record<string, unknown>} settings
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function updateSettings(settings, browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.SETTINGS_UPDATE, { settings }, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function resetSettings(browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.SETTINGS_RESET, {}, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function getStorageUsage(browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.STORAGE_GET_USAGE, {}, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function purgeStorage(browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.STORAGE_PURGE, {}, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function rebuildStats(browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.STORAGE_REBUILD_STATS, {}, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function repairIntegrity(browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.STORAGE_REPAIR_INTEGRITY, {}, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {BrowserRuntimeLike} [browserApi]
 */
export function resetAllData(browserApi) {
  return sendRuntimeMessage(MESSAGE_TYPES.STORAGE_RESET_DATA, {}, browserApi).then(unwrapRuntimeResult);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
