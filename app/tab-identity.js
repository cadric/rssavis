// @ts-check

import { normalizeUnreadCount } from '../shared/unread-count.js';

/**
 * @typedef {object} TabIdentityI18n
 * @property {(key: string, substitutions?: string | number | Array<string | number>) => string} getMessage
 * @property {() => string} getUILanguage
 *
 * @typedef {object} TabIdentityOptions
 * @property {Document} documentRef
 * @property {TabIdentityI18n} i18n
 */

/** @param {TabIdentityOptions} options */
export function createTabIdentity(options) {
  let titleSignature = '';
  return {
    /**
     * @param {unknown} unreadCount
     * @returns {void}
     */
    update(unreadCount) {
      const count = normalizeUnreadCount(unreadCount);
      const locale = options.i18n.getUILanguage();
      const signature = count === 0 ? '0' : `${locale}:${count}`;
      if (signature === titleSignature) return;
      const title =
        count === 0 ? options.i18n.getMessage('extensionName') : options.i18n.getMessage('tabUnreadTitle', count);
      if (options.documentRef.title !== title) options.documentRef.title = title;
      titleSignature = signature;
    },
  };
}
