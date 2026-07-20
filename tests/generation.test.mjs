import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateFirefoxLocales } from '../tools/generate-firefox-locales.mjs';
import { generateThemeFiles } from '../tools/generate-theme-tokens.mjs';

const root = process.cwd();

test('locale generation reproduces committed Firefox catalogs', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rssavis-public-locales-'));
  try {
    const outputRoot = path.join(temporary, '_locales');
    await generateFirefoxLocales({ catalogRoot: path.join(root, 'locales'), outputRoot });
    for (const locale of ['en', 'da']) {
      const [actual, expected] = await Promise.all([
        readFile(path.join(outputRoot, locale, 'messages.json')),
        readFile(path.join(root, '_locales', locale, 'messages.json')),
      ]);
      assert.deepEqual(actual, expected, `${locale} Firefox catalog drifted`);
    }
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test('theme generation reproduces every committed generated theme', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rssavis-public-themes-'));
  try {
    const sourceDirectory = path.join(temporary, 'tools', 'theme-sources');
    await mkdir(sourceDirectory, { recursive: true });
    await copyFile(
      path.join(root, 'tools', 'theme-sources', 'libadwaita-1.9.2.json'),
      path.join(sourceDirectory, 'libadwaita-1.9.2.json'),
    );
    await generateThemeFiles(temporary);
    for (const filename of ['accents.css', 'adwaita-dark.css', 'adwaita-light.css', 'tokens.css']) {
      const [actual, expected] = await Promise.all([
        readFile(path.join(temporary, 'styles', 'themes', filename)),
        readFile(path.join(root, 'styles', 'themes', filename)),
      ]);
      assert.deepEqual(actual, expected, `${filename} drifted`);
    }
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test('brand ownership and committed PNG dimensions match the public source map', async () => {
  const ownership = new Map([
    [16, 'build-aux/brand/app-icon-16.svg'],
    ...[32, 48, 64, 96, 128].map((size) => [size, 'build-aux/brand/app-icon.svg']),
  ]);
  assert.equal(new Set(ownership.values()).size, 2);
  for (const [size, source] of ownership) {
    assert((await readFile(path.join(root, source))).byteLength > 0, `missing source: ${source}`);
    const png = await readFile(path.join(root, 'icons', `app-${size}.png`));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});
