import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const budget = JSON.parse(await readFile(join(webRoot, 'bundle-size-budget.json'), 'utf8'));
if (
  !Number.isSafeInteger(budget.baselineBytes) ||
  !Number.isSafeInteger(budget.maxBytes) ||
  budget.baselineBytes < 0 ||
  budget.maxBytes < budget.baselineBytes
) {
  throw new Error('bundle-size-budget.json must contain valid baselineBytes and maxBytes values.');
}
const assetDirectory = join(webRoot, 'dist', 'assets');
const assets = await readdir(assetDirectory, { withFileTypes: true });
const measured = assets.filter((entry) =>
  entry.isFile() && ['.js', '.css'].includes(entry.name.slice(entry.name.lastIndexOf('.'))),
);

if (measured.length === 0) {
  throw new Error(`No JavaScript or CSS assets found in ${assetDirectory}; build the web app first.`);
}

let currentBytes = 0;
for (const asset of measured) {
  const contents = await readFile(join(assetDirectory, asset.name));
  currentBytes += contents.byteLength;
}

const format = (bytes) => `${(bytes / 1000).toFixed(2)} kB (${bytes.toLocaleString()} bytes)`;
const delta = currentBytes - budget.baselineBytes;
const direction = delta > 0 ? '+' : '';
console.log(`Web bundle before: ${format(budget.baselineBytes)}`);
console.log(`Web bundle after:  ${format(currentBytes)} (${direction}${format(delta)})`);
console.log(`Committed budget:  ${format(budget.maxBytes)}`);

if (currentBytes > budget.maxBytes) {
  console.error('Bundle size budget exceeded.');
  process.exitCode = 1;
}
