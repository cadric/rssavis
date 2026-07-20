#!/usr/bin/env node
// @ts-check

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OUTPUT_DIR = 'dist';
const OUTPUT_FILE = 'rssavis.zip';
export const PACKAGE_ROOT_FILES = Object.freeze(['manifest.json']);
export const PACKAGE_ROOT_DIRECTORIES = Object.freeze([
  '_locales',
  'app',
  'background',
  'data',
  'domain',
  'icons',
  'locales',
  'shared',
  'styles',
]);
export const PACKAGE_LICENSE_PATTERN = 'LICENSE*';
const ALLOWED_ROOT_FILES = new Set(PACKAGE_ROOT_FILES);
const ALLOWED_ROOT_DIRS = new Set(PACKAGE_ROOT_DIRECTORIES);
const IGNORED_DIRS = new Set(['.git', '.hg', '.svn', 'coverage', 'dist', 'node_modules', 'web-ext-artifacts']);
const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/**
 * @typedef PackageEntry
 * @property {string} absolute
 * @property {string} relative
 */

/**
 * @param {string} value
 * @returns {string}
 */
function toPosix(value) {
  return value.split(path.sep).join('/');
}

/**
 * Strip HTML comments (including `prettier-ignore` marker comments) from a packaged
 * `.html` runtime entry. Pure, deterministic string operation: same input always
 * produces the same output, with no I/O and no side effects. Applied only to the
 * in-memory bytes written into the release archive; the source file on disk is
 * never touched by this function or its caller.
 * @param {string} html
 * @returns {string}
 */
export function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * @param {string} relative
 * @returns {boolean}
 */
function isAllowedRuntimeFile(relative) {
  const [head] = relative.split('/');
  const licenseStem = PACKAGE_LICENSE_PATTERN.slice(0, -1);
  const isLicense = !relative.includes('/') && (relative === licenseStem || relative.startsWith(`${licenseStem}.`));
  return ALLOWED_ROOT_FILES.has(relative) || isLicense || ALLOWED_ROOT_DIRS.has(head);
}

/**
 * @param {string} root
 * @returns {Promise<PackageEntry[]>}
 */
async function walkFiles(root) {
  /** @type {PackageEntry[]} */
  const files = [];

  /**
   * @param {string} current
   * @returns {Promise<void>}
   */
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push({ absolute, relative: toPosix(path.relative(root, absolute)) });
      }
    }
  }

  await visit(root);
  return files;
}

/**
 * Collect files that may be included in the runtime extension archive.
 * @param {string} root
 * @returns {Promise<PackageEntry[]>}
 */
export async function collectPackageEntries(root) {
  const files = await walkFiles(root);
  return files
    .filter((file) => isAllowedRuntimeFile(file.relative))
    .sort((left, right) => left.relative.localeCompare(right.relative));
}

/**
 * @param {Buffer | Uint8Array} bytes
 * @returns {number}
 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function fixedDosDateTime() {
  return { time: 0, date: 33 };
}

/**
 * @param {string} name
 * @param {Buffer | Uint8Array} bytes
 * @param {number} offset
 * @param {boolean} central
 * @returns {Buffer}
 */
function header(name, bytes, offset, central) {
  const nameBytes = Buffer.from(name, 'utf8');
  const { time, date } = fixedDosDateTime();
  const size = bytes.byteLength;
  const output = Buffer.alloc(central ? 46 : 30);
  output.writeUInt32LE(central ? 0x02014b50 : 0x04034b50, 0);
  if (central) output.writeUInt16LE(0x031e, 4);
  output.writeUInt16LE(20, central ? 6 : 4);
  output.writeUInt16LE(0, central ? 8 : 6);
  output.writeUInt16LE(0, central ? 10 : 8);
  output.writeUInt16LE(time, central ? 12 : 10);
  output.writeUInt16LE(date, central ? 14 : 12);
  output.writeUInt32LE(crc32(bytes), central ? 16 : 14);
  output.writeUInt32LE(size, central ? 20 : 18);
  output.writeUInt32LE(size, central ? 24 : 22);
  output.writeUInt16LE(nameBytes.byteLength, central ? 28 : 26);
  if (central) output.writeUInt32LE(offset, 42);
  return Buffer.concat([output, nameBytes]);
}

/**
 * Read the bytes for a single package entry as they should be written into the
 * archive. Only `.html` runtime entries are transformed (HTML comment stripping);
 * every other extension (JSON, JS, CSS, icons, ...) is packaged byte-for-byte from
 * disk. The source file on disk is only ever read here, never written.
 * @param {PackageEntry} entry
 * @returns {Promise<Buffer>}
 */
async function packagedEntryBytes(entry) {
  const raw = await readFile(entry.absolute);
  if (!entry.relative.endsWith('.html')) return raw;
  return Buffer.from(stripHtmlComments(raw.toString('utf8')), 'utf8');
}

/**
 * @param {PackageEntry[]} entries
 * @param {string} destination
 * @returns {Promise<void>}
 */
async function writeZip(entries, destination) {
  /** @type {Buffer[]} */
  const localParts = [];
  /** @type {Buffer[]} */
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const bytes = await packagedEntryBytes(entry);
    const local = header(entry.relative, bytes, offset, false);
    const central = header(entry.relative, bytes, offset, true);
    localParts.push(local, bytes);
    centralParts.push(central);
    offset += local.byteLength + bytes.byteLength;
  }
  const centralSize = centralParts.reduce((sum, item) => sum + item.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  await mkdir(path.dirname(destination), { recursive: true });
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(destination);
    stream.on('error', reject);
    stream.on('finish', resolve);
    for (const part of [...localParts, ...centralParts, end]) stream.write(part);
    stream.end();
  });
}

/**
 * @param {string} root
 * @returns {Promise<{deferred: boolean, reason?: string, output?: string, entries: PackageEntry[]}>}
 */
export async function buildPackage(root) {
  const manifest = path.join(root, 'manifest.json');
  try {
    await stat(manifest);
  } catch {
    return {
      deferred: true,
      reason: 'B00 has no manifest.json; runtime archive creation starts in B01.',
      entries: await collectPackageEntries(root),
    };
  }
  const entries = await collectPackageEntries(root);
  const output = path.join(root, OUTPUT_DIR, OUTPUT_FILE);
  await writeZip(entries, output);
  return { deferred: false, output, entries };
}

async function main() {
  const result = await buildPackage(process.cwd());
  if (result.deferred) {
    console.log(result.reason);
    return;
  }
  console.log(`Wrote ${path.relative(process.cwd(), result.output ?? '')} with ${result.entries.length} entries.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
