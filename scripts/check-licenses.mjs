import { existsSync, readFileSync } from 'node:fs';

const failures = [];
if (!existsSync('LICENSE.md')) failures.push('LICENSE.md missing');
if (!existsSync('docs/operations/licenses.md')) failures.push('license operations doc missing');
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
if (!manifest.license) failures.push('package.json license missing');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`License checks passed (${manifest.license}).`);
