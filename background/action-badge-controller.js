// @ts-check

import { compactUnreadCount, normalizeUnreadCount } from '../shared/unread-count.js';

/**
 * @typedef {object} ActionBadgeControllerOptions
 * @property {{setBadgeText?: (details: {text: string}) => Promise<void>, setTitle?: (details: {title: string}) => Promise<void>}} action
 * @property {{getUILanguage?: () => string, getMessage?: (key: string, substitutions?: string | string[]) => string}} i18n
 * @property {() => Promise<number>} readUnreadCount
 * @property {(error: unknown, operation: string) => void} [reportError]
 */

/**
 * @param {ActionBadgeControllerOptions} options
 */
export function createActionBadgeController(options) {
  let requestedGeneration = 0;
  /** @type {Promise<void> | null} */
  let activeDrain = null;
  /** @type {string | null} */
  let lastAppliedSignature = null;

  return {
    sync() {
      requestedGeneration += 1;
      if (!activeDrain) {
        activeDrain = drain()
          .catch((error) => {
            lastAppliedSignature = null;
            reportActionBadgeError(options, error);
          })
          .finally(() => {
            activeDrain = null;
          });
      }
      return activeDrain;
    },
  };

  async function drain() {
    while (true) {
      const generation = requestedGeneration;
      let state;
      try {
        state = await readState(options);
      } catch (error) {
        lastAppliedSignature = null;
        reportActionBadgeError(options, error);
        if (generation !== requestedGeneration) continue;
        return;
      }
      if (generation !== requestedGeneration) continue;
      if (!state) return;
      if (state.readFailed) lastAppliedSignature = null;
      if (state.signature === lastAppliedSignature) return;

      try {
        if (generation !== requestedGeneration) continue;
        await options.action.setBadgeText?.({ text: state.badge });
        if (generation !== requestedGeneration) continue;
        await options.action.setTitle?.({ title: state.title });
        if (generation !== requestedGeneration) continue;
        lastAppliedSignature = state.signature;
        return;
      } catch (error) {
        lastAppliedSignature = null;
        reportActionBadgeError(options, error);
        if (generation !== requestedGeneration) continue;
        return;
      }
    }
  }
}

/**
 * @param {ActionBadgeControllerOptions} options
 */
async function readState(options) {
  if (typeof options.action.setBadgeText !== 'function' || typeof options.action.setTitle !== 'function') {
    return null;
  }

  let count = 0;
  let readFailed = false;
  try {
    count = normalizeUnreadCount(await options.readUnreadCount());
  } catch (error) {
    readFailed = true;
    reportActionBadgeError(options, error);
  }

  const locale = firefoxMessageLocale(options.i18n.getUILanguage?.());
  const badge = count === 0 ? '' : compactUnreadCount(count);
  const title = actionTitle(options.i18n, locale, count);
  const signature = `${badge}\u0000${title}`;
  return { badge, readFailed, signature, title };
}

/**
 * @param {ActionBadgeControllerOptions} options
 * @param {unknown} error
 */
function reportActionBadgeError(options, error) {
  try {
    options.reportError?.(error, 'action.badge.sync');
  } catch (reportError) {
    // Error reporting is best-effort and must not reject action synchronization.
    void reportError;
  }
}

/**
 * @param {{getMessage?: (key: string, substitutions?: string | string[]) => string}} i18n
 * @param {'da' | 'en'} locale
 * @param {number} count
 */
function actionTitle(i18n, locale, count) {
  if (count === 0) return i18n.getMessage?.('openReader') ?? '';
  const formatted = new Intl.NumberFormat(locale).format(count);
  const plural = new Intl.PluralRules(locale).select(count);
  const key = plural === 'one' ? 'openReaderMainUnreadOne' : 'openReaderMainUnreadOther';
  return i18n.getMessage?.(key, formatted) ?? '';
}

/**
 * @param {unknown} uiLanguage
 * @returns {'da' | 'en'}
 */
export function firefoxMessageLocale(uiLanguage) {
  const language = typeof uiLanguage === 'string' ? uiLanguage.trim().replaceAll('_', '-').toLowerCase() : '';
  return language === 'da' || language.startsWith('da-') ? 'da' : 'en';
}
