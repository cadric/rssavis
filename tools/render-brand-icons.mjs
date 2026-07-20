import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.slice(2).includes('--check');
const unknownArgs = process.argv.slice(2).filter((argument) => argument !== '--check');

if (unknownArgs.length > 0) throw new Error(`Unknown argument: ${unknownArgs.join(' ')}`);

const sourceMap = [
  { size: 16, source: 'build-aux/brand/app-icon-16.svg', target: 'icons/app-16.png' },
  ...[32, 48, 64, 96, 128].map((size) => ({
    size,
    source: 'build-aux/brand/app-icon.svg',
    target: `icons/app-${size}.png`,
  })),
];

const pythonRenderer = String.raw`
import sys
import gi
gi.require_version('Rsvg', '2.0')
from gi.repository import Rsvg
import cairo

source, size_text, output = sys.argv[1:]
size = int(size_text)
handle = Rsvg.Handle.new_from_file(source)
surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, size, size)
context = cairo.Context(surface)
rect = Rsvg.Rectangle()
rect.x = 0
rect.y = 0
rect.width = size
rect.height = size
handle.render_document(context, rect)
surface.write_to_png(output)
print(f'librsvg {Rsvg.MAJOR_VERSION}.{Rsvg.MINOR_VERSION}.{Rsvg.MICRO_VERSION}; Cairo {cairo.cairo_version_string()}')
`;

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'rssavis-brand-icons-'));

try {
  let versions = '';
  const renders = [];
  for (const entry of sourceMap) {
    const output = path.join(temporaryRoot, `app-${entry.size}.png`);
    const result = await execFileAsync('python3', [
      '-c',
      pythonRenderer,
      path.join(root, entry.source),
      String(entry.size),
      output,
    ]);
    versions ||= result.stdout.trim();
    renders.push({ ...entry, output });
  }

  console.log(versions);
  for (const render of renders) {
    const target = path.join(root, render.target);
    if (checkOnly) {
      await access(target, constants.R_OK);
      const [actual, expected] = await Promise.all([readFile(target), readFile(render.output)]);
      if (!actual.equals(expected)) throw new Error(`${render.target} does not match ${render.source}.`);
    } else {
      const staged = `${target}.tmp-${process.pid}`;
      await copyFile(render.output, staged);
      await rename(staged, target);
    }
    console.log(`${render.source} -> ${render.target}`);
  }
  console.log(
    checkOnly
      ? 'All committed brand icons match their owning source.'
      : 'Rendered all brand icons from their owning source.',
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
