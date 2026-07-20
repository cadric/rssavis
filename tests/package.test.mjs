import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  PACKAGE_LICENSE_PATTERN,
  PACKAGE_ROOT_DIRECTORIES,
  PACKAGE_ROOT_FILES,
  buildPackage,
} from '../tools/build-package.mjs';

const root = process.cwd();
const expectedDirectories = ['_locales', 'app', 'background', 'data', 'domain', 'icons', 'locales', 'shared', 'styles'];

test('the runtime ZIP is deterministic and uses the exact release allowlist', async () => {
  assert.deepEqual(PACKAGE_ROOT_FILES, ['manifest.json']);
  assert.deepEqual(PACKAGE_ROOT_DIRECTORIES, expectedDirectories);
  assert.equal(PACKAGE_LICENSE_PATTERN, 'LICENSE*');

  const first = await buildPackage(root);
  assert.equal(first.deferred, false);
  const firstBytes = await readFile(first.output);
  const second = await buildPackage(root);
  const secondBytes = await readFile(second.output);
  assert.deepEqual(secondBytes, firstBytes);

  const names = second.entries.map(({ relative }) => relative);
  assert(names.includes('manifest.json'));
  assert(names.includes('LICENSE'));
  assert(names.includes('locales/en.json'));
  assert(names.includes('locales/da.json'));
  assert.equal(names.filter((name) => !name.includes('/') && name.startsWith('LICENSE')).length, 1);
  for (const name of names) {
    const [rootName] = name.split('/');
    assert(
      name === 'manifest.json' || name === 'LICENSE' || expectedDirectories.includes(rootName),
      `unexpected package entry: ${name}`,
    );
    const basename = path.posix.basename(name).toLowerCase();
    assert(!name.endsWith('.map'), `source map reached package: ${name}`);
    assert(!basename.startsWith('.env'), `environment file reached package: ${name}`);
    assert(!/\.(?:key|p12|pfx|pem)$/u.test(basename), `credential file reached package: ${name}`);
  }

  for (const entry of second.entries.filter(({ relative }) => /\.(?:css|html|js|json)$/u.test(relative))) {
    const text = await readFile(entry.absolute, 'utf8');
    assert(!/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/u.test(text), `private key in ${entry.relative}`);
    assert(
      !/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/u.test(text),
      `GitHub token in ${entry.relative}`,
    );
    assert(!/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u.test(text), `AWS credential in ${entry.relative}`);
    assert(
      !/\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/iu.test(text),
      `authorization credential in ${entry.relative}`,
    );
    assert(!/https:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/iu.test(text), `credential URL in ${entry.relative}`);
  }
});

test('manifest locales and every referenced icon are packaged', async () => {
  const result = await buildPackage(root);
  const names = new Set(result.entries.map(({ relative }) => relative));
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const iconPaths = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];

  for (const iconPath of iconPaths) assert(names.has(iconPath), `missing packaged icon: ${iconPath}`);
  for (const locale of ['en', 'da']) {
    assert(names.has(`locales/${locale}.json`));
    assert(names.has(`_locales/${locale}/messages.json`));
  }
});
