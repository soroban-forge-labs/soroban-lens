#!/usr/bin/env node
/**
 * Stamp a release version into every published workspace (#83).
 *
 *   node scripts/release-version.mjs 0.2.0
 *
 * Sets `version`, and replaces the `"*"` ranges between @soroban-lens packages
 * with the exact version: `*` is right inside the monorepo, but a published
 * package that depends on "any version" of its sibling would install whatever
 * is newest, not the one it was released and tested with. Run in CI on a
 * clean checkout; the result is never committed.
 */
import { readFile, writeFile } from 'node:fs/promises';

const version = process.argv[2]?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: release-version.mjs <semver>, e.g. 0.2.0 or v0.2.0-rc.1');
  process.exit(2);
}

const root = JSON.parse(await readFile('package.json', 'utf8'));
const workspaces = root.workspaces.flatMap((w) => (w.endsWith('/*') ? [] : [w]));
const { readdir } = await import('node:fs/promises');
for (const pattern of root.workspaces.filter((w) => w.endsWith('/*'))) {
  const dir = pattern.slice(0, -2);
  for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) workspaces.push(`${dir}/${entry.name}`);
}

for (const ws of workspaces) {
  const path = `${ws}/package.json`;
  let pkg;
  try {
    pkg = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    continue;
  }
  pkg.version = version;
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (name.startsWith('@soroban-lens/')) pkg[field][name] = version;
    }
  }
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${pkg.name}@${version}${pkg.private ? ' (private, not published)' : ''}`);
}
