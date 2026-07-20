// Public Git identity fixture: cadric <964797+cadric@users.noreply.github.com>

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, opendir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const allowedEmails = new Set([
  ['rssavis', 'pm.me'].join('@'),
  ['964797+cadric', 'users.noreply.github.com'].join('@'),
]);
const emailPattern =
  /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/giu;

test('package metadata and dependency-free lockfile agree exactly', async () => {
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const before = await Promise.all([readFile(packagePath), readFile(lockPath)]);
  const beforeTree = await treeFingerprint();
  const beforeStatus = await gitStatus();
  const packageMetadata = JSON.parse(before[0].toString('utf8'));
  const lockfile = JSON.parse(before[1].toString('utf8'));

  assert.equal(packageMetadata.name, 'rssavis');
  assert.match(packageMetadata.version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u);
  assert.equal(packageMetadata.license, 'MPL-2.0');
  assert.equal(packageMetadata.dependencies, undefined);
  assert.equal(packageMetadata.devDependencies, undefined);
  assert.equal(lockfile.lockfileVersion, 3);
  assert.deepEqual(Object.keys(lockfile.packages), ['']);
  assert.deepEqual(lockfile.packages[''], {
    name: packageMetadata.name,
    version: packageMetadata.version,
    license: packageMetadata.license,
    engines: packageMetadata.engines,
  });

  await execFileAsync(
    'npm',
    ['install', '--package-lock-only', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    {
      cwd: root,
    },
  );
  const after = await Promise.all([readFile(packagePath), readFile(lockPath)]);
  assert.deepEqual(after, before);
  assert.deepEqual(await treeFingerprint(), beforeTree);
  assert.equal(await gitStatus(), beforeStatus);
});

test('the public tree has one license and no private roots, state, symlinks, or high-confidence secrets', async () => {
  const entries = await walk(root);
  const rootLicenses = entries.filter((entry) => !entry.relative.includes('/') && entry.relative.startsWith('LICENSE'));
  assert.deepEqual(
    rootLicenses.map(({ relative }) => relative),
    ['LICENSE'],
  );

  const privateParts = new Set([
    '.agent',
    '.claude',
    '.codex',
    '.git',
    'dist',
    'docs',
    'evidence',
    'node_modules',
    'policy',
    'validation',
  ]);
  for (const entry of entries) {
    const segments = entry.relative.split('/');
    const basename = path.posix.basename(entry.relative).toLowerCase();
    assert.notEqual(entry.kind, 'symlink', `symlink found: ${entry.relative}`);
    assert(!segments.some((segment) => privateParts.has(segment)), `private path found: ${entry.relative}`);
    assert(
      entry.relative === '.gitignore' || !segments.some((segment) => segment.startsWith('.')),
      `dotfile found: ${entry.relative}`,
    );
    assert(!['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].includes(path.posix.basename(entry.relative)));
    assert(!basename.startsWith('.env'), `environment file found: ${entry.relative}`);
    assert(!/\.(?:key|map|p12|pem|pfx)$/u.test(basename), `sensitive file found: ${entry.relative}`);
    if (entry.kind !== 'file' || !/\.(?:css|html|js|json|md|mjs)$/u.test(entry.relative)) continue;
    const text = await readFile(path.join(root, entry.relative), 'utf8');
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
    assert(
      !/\bprivate[_-]?key\s*[:=]\s*["'][^"'\r\n]{16,}["']/iu.test(text),
      `private key assignment in ${entry.relative}`,
    );
    for (const match of text.matchAll(emailPattern)) {
      assert(allowedEmails.has(match[0]), `private email identity in ${entry.relative}`);
    }
  }
});

test('public Markdown links resolve locally or use the one reporting destination', async () => {
  const reportingUrl = 'https://github.com/cadric/rssavis/security/advisories/new';
  const markdownFiles = (await walk(root)).filter((entry) => entry.kind === 'file' && entry.relative.endsWith('.md'));
  for (const entry of markdownFiles) {
    const text = await readFile(path.join(root, entry.relative), 'utf8');
    const destinations = markdownDestinations(text);
    for (const destination of destinations) {
      if (destination.startsWith('https:')) {
        assert.equal(destination, reportingUrl);
        continue;
      }
      const hashIndex = destination.indexOf('#');
      const beforeFragment = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? '' : decodeURIComponent(destination.slice(hashIndex + 1));
      const localPart = decodeURIComponent(beforeFragment.split('?', 1)[0]);
      let resolved = localPart
        ? path.resolve(root, path.dirname(entry.relative), localPart)
        : path.join(root, entry.relative);
      assert(resolved === root || resolved.startsWith(`${root}${path.sep}`));
      const stats = await lstat(resolved);
      if (stats.isDirectory() && fragment) resolved = path.join(resolved, 'README.md');
      if (fragment) assert(await fileHasFragment(resolved, fragment), `missing fragment in ${destination}`);
    }
  }
});

function markdownDestinations(text) {
  const patterns = [
    /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/gu,
    /^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|([^\s]+))/gmu,
    /<(https?:\/\/[^>]+)>/gu,
  ];
  const destinations = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) destinations.push(match[1] ?? match[2]);
  }
  return [...new Set(destinations)];
}

async function fileHasFragment(absolute, fragment) {
  const text = await readFile(absolute, 'utf8');
  if (absolute.endsWith('.md')) return markdownSlugs(text).has(fragment.toLowerCase());
  if (absolute.endsWith('.html')) {
    return [...text.matchAll(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/giu)].some(
      (match) => (match[1] ?? match[2]) === fragment,
    );
  }
  return false;
}

function markdownSlugs(text) {
  const slugs = new Set();
  const counts = new Map();
  for (const match of text.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const base = match[1]
      .replace(/<[^>]*>/gu, '')
      .replace(/[`*_~]/gu, '')
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s+/gu, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

async function walk(directory, relativeRoot = '') {
  const entries = [];
  const handle = await opendir(directory);
  const names = [];
  for await (const entry of handle) names.push(entry.name);
  names.sort();
  for (const name of names) {
    if (!relativeRoot && (name === '.git' || name === 'dist')) continue;
    const absolute = path.join(directory, name);
    const relative = relativeRoot ? `${relativeRoot}/${name}` : name;
    const stats = await lstat(absolute);
    const kind = stats.isSymbolicLink()
      ? 'symlink'
      : stats.isDirectory()
        ? 'directory'
        : stats.isFile()
          ? 'file'
          : 'special';
    entries.push({ kind, relative });
    if (kind === 'directory') entries.push(...(await walk(absolute, relative)));
  }
  return entries;
}

async function treeFingerprint() {
  const fingerprint = [];
  for (const entry of await walk(root)) {
    if (entry.kind !== 'file') {
      fingerprint.push(`${entry.kind}:${entry.relative}`);
      continue;
    }
    const absolute = path.join(root, entry.relative);
    const [bytes, stats] = await Promise.all([readFile(absolute), lstat(absolute)]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    fingerprint.push(`file:${entry.relative}:${stats.mode & 0o777}:${sha256}`);
  }
  return fingerprint;
}

async function gitStatus() {
  try {
    await lstat(path.join(root, '.git'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return (await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: root })).stdout;
}
