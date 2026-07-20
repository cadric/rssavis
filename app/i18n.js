// @ts-check

import daCatalog from '../locales/da.json' with { type: 'json' };
import enCatalog from '../locales/en.json' with { type: 'json' };
import { RUNTIME_MESSAGE_MAP } from '../shared/i18n-keys.js';

const SETTINGS_STORAGE_KEY = 'settings.v1';
const SUPPORTED_LOCALES = new Set(['en', 'da']);
const NUMERIC_PLACEHOLDERS = new Set(['articles', 'count', 'done', 'feeds', 'max', 'min', 'status']);
const DEFAULT_CATALOGS = Object.freeze({
  da: runtimeCatalogFromCanonical(daCatalog),
  en: runtimeCatalogFromCanonical(enCatalog),
});

/**
 * @typedef {object} RuntimeMessage
 * @property {string} [message]
 * @property {Record<string, string>} [forms]
 * @property {string[]} placeholders
 *
 * @typedef {object} RuntimeCatalog
 * @property {string} direction
 * @property {Record<string, RuntimeMessage>} messages
 *
 * @typedef {object} AppI18nOptions
 * @property {{getUILanguage(): string}} browserI18n
 * @property {Record<string, RuntimeCatalog>} [catalogs]
 * @property {{documentElement?: {lang?: string, dir?: string}}} [documentRef]
 * @property {{get(keys: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>, set?(items: Record<string, unknown>): Promise<void>}} storageArea
 */

/**
 * @param {string} setting
 * @param {string} browserLanguage
 * @returns {'da' | 'en'}
 */
export function resolveAppLocale(setting, browserLanguage) {
  if (setting === 'da' || setting === 'en') return setting;
  return browserLanguage.toLowerCase().startsWith('da') ? 'da' : 'en';
}

/**
 * @param {AppI18nOptions} options
 */
export function createAppI18n(options) {
  const catalogs = options.catalogs ?? DEFAULT_CATALOGS;
  /** @type {'auto' | 'da' | 'en'} */
  let languageSetting = 'auto';
  /** @type {'da' | 'en'} */
  let locale = resolveAppLocale(languageSetting, options.browserI18n.getUILanguage());
  /** @type {Set<() => void>} */
  const listeners = new Set();

  const applyLocale = () => {
    locale = resolveAppLocale(languageSetting, options.browserI18n.getUILanguage());
    applyDocumentMetadata(options.documentRef, catalogs[locale], locale);
    for (const listener of listeners) listener();
  };

  /**
   * @param {string} key
   * @param {string | number | Array<string | number>} [substitutions]
   */
  const getMessage = (key, substitutions) => formatRuntimeMessage(catalogs[locale], locale, key, substitutions);

  return {
    async start() {
      languageSetting = await readLanguageSetting(options.storageArea);
      applyLocale();
    },
    async refreshFromSettings() {
      languageSetting = await readLanguageSetting(options.storageArea);
      applyLocale();
    },
    /**
     * @param {unknown} next
     */
    async setLanguage(next) {
      languageSetting = next === 'da' || next === 'en' || next === 'auto' ? next : 'auto';
      applyLocale();
    },
    getMessage,
    getUILanguage: () => locale,
    /**
     * @param {number} value
     */
    formatNumber(value) {
      return new Intl.NumberFormat(locale).format(value);
    },
    /**
     * @param {number | Date} value
     */
    formatDate(value) {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
    },
    /**
     * @param {number} value
     * @param {Intl.RelativeTimeFormatUnit} unit
     */
    formatRelativeTime(value, unit) {
      return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit);
    },
    /**
     * @param {() => void} listener
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * @param {RuntimeCatalog} catalog
 * @param {string} locale
 * @param {string} key
 * @param {string | number | Array<string | number>} [substitutions]
 */
function formatRuntimeMessage(catalog, locale, key, substitutions) {
  const entry = catalog.messages[key];
  if (!entry) throw new Error(`Missing translation: ${key}`);
  const values = valuesByPlaceholder(entry.placeholders, substitutions);
  const template = entry.forms ? pluralTemplate(entry, locale, values) : entry.message;
  if (typeof template !== 'string') throw new Error(`Missing translation text: ${key}`);
  return replacePlaceholders(template, values, locale);
}

/**
 * @param {RuntimeMessage} entry
 * @param {string} locale
 * @param {Record<string, string>} values
 */
function pluralTemplate(entry, locale, values) {
  const count = Number(values.count);
  const form = new Intl.PluralRules(locale).select(Number.isFinite(count) ? count : 0);
  return entry.forms?.[form] ?? entry.forms?.other;
}

/**
 * @param {string[]} placeholders
 * @param {string | number | Array<string | number>} [substitutions]
 */
function valuesByPlaceholder(placeholders, substitutions) {
  const values = Array.isArray(substitutions) ? substitutions : substitutions == null ? [] : [substitutions];
  return Object.fromEntries(placeholders.map((name, index) => [name, String(values[index] ?? '')]));
}

/**
 * @param {string} template
 * @param {Record<string, string>} values
 * @param {string} locale
 */
function replacePlaceholders(template, values, locale) {
  let output = template;
  for (const [name, value] of Object.entries(values)) {
    output = output.replaceAll(`{${name}}`, placeholderValue(locale, name, value));
  }
  return output;
}

/**
 * @param {string} locale
 * @param {string} name
 * @param {string} value
 */
function placeholderValue(locale, name, value) {
  if (!NUMERIC_PLACEHOLDERS.has(name)) return value;
  if (!/^-?\d+(?:\.\d+)?$/u.test(value)) return value;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Intl.NumberFormat(locale).format(numeric) : value;
}

/**
 * @param {AppI18nOptions['storageArea']} storageArea
 * @returns {Promise<'auto' | 'da' | 'en'>}
 */
async function readLanguageSetting(storageArea) {
  const stored = (await storageArea.get(SETTINGS_STORAGE_KEY))[SETTINGS_STORAGE_KEY];
  if (!isRecord(stored)) return 'auto';
  const language = stored.language;
  return language === 'da' || language === 'en' || language === 'auto' ? language : 'auto';
}

/**
 * @param {AppI18nOptions['documentRef']} documentRef
 * @param {RuntimeCatalog} catalog
 * @param {'da' | 'en'} locale
 */
function applyDocumentMetadata(documentRef, catalog, locale) {
  if (documentRef?.documentElement) {
    documentRef.documentElement.lang = locale;
    documentRef.documentElement.dir = catalog.direction === 'rtl' ? 'rtl' : 'ltr';
  }
}

/**
 * @param {unknown} canonicalCatalog
 * @returns {RuntimeCatalog}
 */
function runtimeCatalogFromCanonical(canonicalCatalog) {
  const catalog = isRecord(canonicalCatalog) ? canonicalCatalog : {};
  const meta = isRecord(catalog.$meta) ? catalog.$meta : {};
  const canonicalMessages = isRecord(catalog.messages) ? catalog.messages : {};
  /** @type {Record<string, RuntimeMessage>} */
  const messages = {};
  for (const [canonicalKey, runtimeKey] of Object.entries(RUNTIME_MESSAGE_MAP)) {
    const entry = canonicalMessages[canonicalKey];
    if (!isRecord(entry)) throw new Error(`Missing message ${canonicalKey}`);
    const placeholders = Array.isArray(entry.placeholders) ? entry.placeholders.map(String) : [];
    if (entry.kind === 'text' && typeof entry.message === 'string') {
      messages[runtimeKey] = { message: entry.message, placeholders };
    } else if (entry.kind === 'plural' && isRecord(entry.forms)) {
      messages[runtimeKey] = { forms: stringRecord(entry.forms), placeholders };
    } else {
      throw new Error(`Invalid message ${canonicalKey}`);
    }
  }
  return { direction: meta.direction === 'rtl' ? 'rtl' : 'ltr', messages };
}

/**
 * @param {Record<string, unknown>} record
 */
function stringRecord(record) {
  /** @type {Record<string, string>} */
  const output = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') output[key] = value;
  }
  return output;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
