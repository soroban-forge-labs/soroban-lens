#!/usr/bin/env node
/**
 * Release notes from conventional commit subjects (#83).
 *
 *   node scripts/changelog.mjs v0.2.0 [v0.1.0]   # previous tag defaults to the one before
 *
 * The repo's subjects are `<module>: …` (CONTRIBUTING.md) as well as the usual
 * `feat:`/`fix:` types, so both are grouped: breaking changes first, then by
 * module. Merge commits are skipped; their PR's own commits carry the content.
 */
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const tag = process.argv[2];
if (!tag) {
  console.error('usage: changelog.mjs <tag> [previous-tag]');
  process.exit(2);
}
let previous = process.argv[3];
if (!previous) {
  try {
    previous = git('describe', '--tags', '--abbrev=0', `${tag}^`);
  } catch {
    previous = undefined; // first release: everything up to the tag
  }
}

const range = previous ? `${previous}..${tag}` : tag;
const lines = git('log', '--no-merges', '--format=%h%x09%s', range).split('\n').filter(Boolean);

const MODULES = { ingest: 'Ingestion & RPC', store: 'Decoding & Storage', api: 'Query API', web: 'Web UI', deploy: 'Deployment & CLI', cli: 'Deployment & CLI', docs: 'Docs', bench: 'Benchmarks' };
const TYPES = { feat: 'Features', fix: 'Fixes', perf: 'Performance', docs: 'Docs', test: 'Tests', refactor: 'Refactoring', ci: 'CI', build: 'Build', chore: 'Chores' };

const groups = new Map();
const breaking = [];
for (const line of lines) {
  const [sha, subject = ''] = line.split('\t');
  const match = /^([a-z]+(?:\([^)]*\))?)(!)?(?:,\s*[a-z]+)*:\s*(.+)$/i.exec(subject);
  const prefix = match?.[1]?.toLowerCase() ?? '';
  const base = prefix.replace(/\(.*$/, '');
  const text = match?.[3] ?? subject;
  const entry = `- ${text} (${sha})`;
  if (match?.[2] || base === 'breaking' || /BREAKING CHANGE/.test(subject)) {
    breaking.push(entry);
    continue;
  }
  const heading = MODULES[base] ?? TYPES[base] ?? 'Other';
  if (!groups.has(heading)) groups.set(heading, []);
  groups.get(heading).push(entry);
}

const out = [`## ${tag}`, ''];
if (previous) out.push(`Changes since ${previous}.`, '');
if (breaking.length > 0) out.push('### Breaking changes', '', ...breaking, '');
for (const [heading, entries] of [...groups].sort(([a], [b]) => (a === 'Other') - (b === 'Other') || a.localeCompare(b))) {
  out.push(`### ${heading}`, '', ...entries, '');
}
if (lines.length === 0) out.push('No changes.', '');
process.stdout.write(out.join('\n'));
