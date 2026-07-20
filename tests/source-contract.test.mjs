import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, opendir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const runtimeRoots = new Set([
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

test('all public JavaScript has valid Node syntax', async () => {
  const files = (await walk(root))
    .filter((relative) => /\.(?:js|mjs)$/u.test(relative))
    .filter((relative) => !relative.startsWith('dist/'));
  for (const relative of files) await execFileAsync(process.execPath, ['--check', path.join(root, relative)]);
});

test('manifest identity, locale catalogs, and icon references are complete', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const packageMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(manifest.version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u);
  assert.equal(manifest.version, packageMetadata.version);
  assert.equal(manifest.browser_specific_settings.gecko.id, ['rssavis', 'pm.me'].join('@'));
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '150.0');

  for (const locale of ['en', 'da']) {
    const catalog = JSON.parse(await readFile(path.join(root, 'locales', `${locale}.json`), 'utf8'));
    const generated = JSON.parse(await readFile(path.join(root, '_locales', locale, 'messages.json'), 'utf8'));
    assert.equal(catalog.$schema, '../schema/locale-catalog.schema.json');
    assert.equal(catalog.messages['manifest.extension.name'].message, 'RSSavis');
    assert.equal(generated.extensionName.message, 'RSSavis');
  }

  for (const iconPath of new Set([...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)])) {
    assert((await readFile(path.join(root, iconPath))).byteLength > 0, `missing icon bytes: ${iconPath}`);
  }
});

test('the public root contains only consumer-facing source classes', async () => {
  const rootEntries = await directoryNames(root);
  const allowedFiles = new Set([
    '.gitignore',
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'SECURITY.md',
    'manifest.json',
    'package-lock.json',
    'package.json',
  ]);
  const allowedDirectories = new Set([...runtimeRoots, 'build-aux', 'schema', 'tests', 'tools']);
  for (const entry of rootEntries) {
    if (entry === '.git' || entry === 'dist') continue;
    assert(allowedFiles.has(entry) || allowedDirectories.has(entry), `unexpected public root entry: ${entry}`);
  }
});

async function walk(directory, relativeRoot = '') {
  const files = [];
  const handle = await opendir(directory);
  const names = [];
  for await (const entry of handle) names.push(entry.name);
  names.sort();
  for (const name of names) {
    if (!relativeRoot && (name === '.git' || name === 'dist')) continue;
    const relative = relativeRoot ? `${relativeRoot}/${name}` : name;
    const absolute = path.join(directory, name);
    const stats = await lstat(absolute);
    if (stats.isDirectory()) files.push(...(await walk(absolute, relative)));
    else files.push(relative);
  }
  return files;
}

async function directoryNames(directory) {
  const handle = await opendir(directory);
  const names = [];
  for await (const entry of handle) names.push(entry.name);
  return names.sort();
}
