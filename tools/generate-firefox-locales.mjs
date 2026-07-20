#!/usr/bin/env node
// @ts-check

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIREFOX_MESSAGE_MAP, RUNTIME_MESSAGE_MAP } from '../shared/i18n-keys.js';

const DEFAULT_LOCALES = Object.freeze(['en', 'da']);
export const DEFAULT_MESSAGE_MAP = FIREFOX_MESSAGE_MAP;
export const DEFAULT_RUNTIME_MESSAGE_MAP = RUNTIME_MESSAGE_MAP;

/**
 * @typedef {object} GenerateOptions
 * @property {string} [catalogRoot]
 * @property {string} [outputRoot]
 * @property {readonly string[]} [locales]
 * @property {Readonly<Record<string, string>>} [messageMap]
 */

/**
 * @param {GenerateOptions} [options]
 * @returns {Promise<string[]>}
 */
export async function generateFirefoxLocales(options = {}) {
  const catalogRoot = options.catalogRoot ?? path.join(process.cwd(), 'locales');
  const outputRoot = options.outputRoot ?? path.join(process.cwd(), '_locales');
  const locales = options.locales ?? DEFAULT_LOCALES;
  const messageMap = options.messageMap ?? DEFAULT_MESSAGE_MAP;
  /** @type {string[]} */
  const written = [];

  for (const locale of locales) {
    const catalog = JSON.parse(await readFile(path.join(catalogRoot, `${locale}.json`), 'utf8'));
    const generated = generateMessages(catalog, messageMap);
    const outputFile = path.join(outputRoot, locale, 'messages.json');
    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(outputFile, `${JSON.stringify(generated, null, 2)}\n`, 'utf8');
    written.push(path.posix.join('_locales', locale, 'messages.json'));
  }

  return written;
}

/**
 * @param {{messages?: Record<string, {kind?: string, message?: string, placeholders?: string[]}>}} catalog
 * @param {Readonly<Record<string, string>>} messageMap
 * @returns {Record<string, {message: string, placeholders?: Record<string, {content: string}>}>}
 */
export function generateMessages(catalog, messageMap = DEFAULT_MESSAGE_MAP) {
  /** @type {Record<string, {message: string, placeholders?: Record<string, {content: string}>}>} */
  const output = {};
  for (const [canonicalKey, firefoxKey] of Object.entries(messageMap)) {
    const message = catalog.messages?.[canonicalKey];
    if (!message || message.kind !== 'text' || typeof message.message !== 'string') {
      throw new Error(`Missing text message ${canonicalKey}`);
    }
    output[firefoxKey] = convertMessage(
      /** @type {{message: string, placeholders?: string[]}} */ (message),
      canonicalKey,
    );
  }
  return output;
}

/**
 * @typedef {object} GenerateAppCatalogOptions
 * @property {string} [catalogRoot]
 * @property {string} outputFile
 * @property {readonly string[]} [locales]
 * @property {Readonly<Record<string, string>>} [messageMap]
 */

/**
 * @param {GenerateAppCatalogOptions} options
 * @returns {Promise<string>}
 */
export async function generateAppLocaleCatalogs(options) {
  const catalogRoot = options.catalogRoot ?? path.join(process.cwd(), 'locales');
  const locales = options.locales ?? DEFAULT_LOCALES;
  const messageMap = options.messageMap ?? DEFAULT_RUNTIME_MESSAGE_MAP;
  /** @type {Record<string, {direction: string, messages: Record<string, unknown>}>} */
  const output = {};

  for (const locale of locales) {
    const catalog = JSON.parse(await readFile(path.join(catalogRoot, `${locale}.json`), 'utf8'));
    output[locale] = generateRuntimeCatalog(catalog, messageMap);
  }

  await mkdir(path.dirname(options.outputFile), { recursive: true });
  await writeFile(
    options.outputFile,
    `// @ts-check\n\nexport const APP_LOCALE_CATALOGS = Object.freeze(${JSON.stringify(output, null, 2)});\n`,
    'utf8',
  );
  return path.basename(options.outputFile);
}

/**
 * @param {{ $meta?: {direction?: string}, messages?: Record<string, {kind?: string, message?: string, forms?: Record<string, string>, placeholders?: string[]}>}} catalog
 * @param {Readonly<Record<string, string>>} messageMap
 */
export function generateRuntimeCatalog(catalog, messageMap = DEFAULT_MESSAGE_MAP) {
  /** @type {Record<string, unknown>} */
  const messages = {};
  for (const [canonicalKey, appKey] of Object.entries(messageMap)) {
    const message = catalog.messages?.[canonicalKey];
    if (!message || typeof message.kind !== 'string') throw new Error(`Missing message ${canonicalKey}`);
    if (message.kind === 'text') {
      if (typeof message.message !== 'string') throw new Error(`Missing text message ${canonicalKey}`);
      messages[appKey] = { message: message.message, placeholders: message.placeholders ?? [] };
    } else if (message.kind === 'plural') {
      if (!message.forms || typeof message.forms.other !== 'string') throw new Error(`Missing plural ${canonicalKey}`);
      messages[appKey] = { forms: message.forms, placeholders: message.placeholders ?? [] };
    } else {
      throw new Error(`Unsupported message kind ${canonicalKey}`);
    }
  }
  return { direction: catalog.$meta?.direction ?? 'ltr', messages };
}

/**
 * @param {{message: string, placeholders?: string[]}} message
 * @param {string} canonicalKey
 * @returns {{message: string, placeholders?: Record<string, {content: string}>}}
 */
function convertMessage(message, canonicalKey) {
  const placeholders = message.placeholders ?? [];
  if (placeholders.length === 0) return { message: message.message };
  /** @type {Record<string, {content: string}>} */
  const firefoxPlaceholders = {};
  let converted = message.message;
  for (const [index, name] of placeholders.entries()) {
    if (!/^[a-z][a-z0-9]*$/u.test(name)) throw new Error(`Invalid placeholder ${canonicalKey}: ${name}`);
    const token = `{${name}}`;
    if (!converted.includes(token)) throw new Error(`Missing placeholder token ${canonicalKey}: ${token}`);
    converted = converted.replaceAll(token, `$${name}$`);
    firefoxPlaceholders[name] = { content: `$${index + 1}` };
  }
  return { message: converted, placeholders: firefoxPlaceholders };
}

async function main() {
  const written = await generateFirefoxLocales();
  for (const file of written) console.log(`Generated ${file}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
