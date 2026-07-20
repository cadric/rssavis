// @ts-check

import { releaseTagForVersion } from '../domain/release-version.js';
import { MESSAGE_TYPES } from '../domain/message-types.js';
import { createAppError } from '../shared/result.js';

const TRUSTED_RESOURCES = Object.freeze(['source', 'license', 'security']);

/**
 * @typedef {object} TrustedResourceBrowser
 * @property {{getManifest(): {version?: string}}} runtime
 * @property {{create(properties: {active: true, url: string}): Promise<unknown>}} tabs
 */

/**
 * @param {unknown} resource
 * @param {unknown} version
 * @returns {string}
 */
export function resolveTrustedResourceUrl(resource, version) {
  if (!isTrustedResource(resource)) throw new TypeError('Unknown trusted release resource.');
  const tag = releaseTagForVersion(version);
  if (resource === 'source') return `https://github.com/cadric/rssavis/tree/${tag}`;
  if (resource === 'license') return `https://github.com/cadric/rssavis/blob/${tag}/LICENSE`;
  return 'https://github.com/cadric/rssavis/security/advisories/new';
}

/**
 * @param {TrustedResourceBrowser} browserApi
 * @returns {Record<string, import('./command-router.js').CommandHandler>}
 */
export function createTrustedResourceCommandHandlers(browserApi) {
  return {
    [MESSAGE_TYPES.APP_OPEN_TRUSTED_RESOURCE]: async (payload) => {
      const resource = requireTrustedResourcePayload(payload);
      const version = browserApi.runtime.getManifest().version;
      const url = resolveTrustedResourceUrl(resource, version);
      await browserApi.tabs.create({ active: true, url });
      return { opened: true };
    },
  };
}

/** @param {Record<string, unknown>} payload */
function requireTrustedResourcePayload(payload) {
  if (Object.getPrototypeOf(payload) !== Object.prototype) throw invalidResourcePayload('payload must be plain');
  const keys = Reflect.ownKeys(payload);
  if (keys.length !== 1 || keys[0] !== 'resource') throw invalidResourcePayload('payload must contain only resource');
  if (!isTrustedResource(payload.resource))
    throw invalidResourcePayload('resource must be source, license, or security');
  return payload.resource;
}

/** @param {unknown} value @returns {value is 'source' | 'license' | 'security'} */
function isTrustedResource(value) {
  return typeof value === 'string' && TRUSTED_RESOURCES.includes(value);
}

/** @param {string} reason */
function invalidResourcePayload(reason) {
  return createAppError('INVALID_MESSAGE', 'errorInvalidMessage', {
    details: { field: 'resource', reason },
    retryable: false,
  });
}
