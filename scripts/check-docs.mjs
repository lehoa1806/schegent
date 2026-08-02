import { readFileSync } from 'node:fs';

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const webview = JSON.parse(readFileSync('webview-ui/package.json', 'utf8'));
const readme = readFileSync('README.md', 'utf8');
const release = readFileSync('RELEASE.md', 'utf8');
const requiredDocs = [
  'docs/reference/audit-events.md',
  'docs/security/threat-model.md',
  'docs/concepts/sessions-and-logs.md',
  'docs/operations/contract-generation.md'
];
const failures = [];
if (root.version !== webview.version) failures.push('root/webview version drift');
for (const file of requiredDocs) {
  const body = readFileSync(file, 'utf8');
  if (body.trim().length < 100) failures.push(`${file} is missing or incomplete`);
}
if (!readme.includes('schegent.exportAuditLog')) failures.push('README command table is stale');
if (!release.includes('npm run verify:all')) failures.push('RELEASE.md omits verify:all');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Documentation/version checks passed for ${root.version}.`);
