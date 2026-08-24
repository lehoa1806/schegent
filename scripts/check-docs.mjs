import { readFileSync } from 'node:fs';

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const webview = JSON.parse(readFileSync('webview-ui/package.json', 'utf8'));
const commandReference = readFileSync('docs/reference/commands.md', 'utf8');
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
  // FR-R3-063 — guarded. An unguarded `readFileSync` throws ENOENT on a DELETED
  // required doc, so the one case this loop exists to catch was the one case it
  // could not report: the process died before reaching any other check, and the
  // operator saw a stack trace instead of "is missing or incomplete". A gate that
  // crashes rather than reports is the same defect as one that passes vacuously
  // -- in both, the finding it exists for never reaches a human.
  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch (err) {
    failures.push(`${file} is missing or unreadable (${err.code ?? 'unknown'})`);
    continue;
  }
  if (body.trim().length < 100) failures.push(`${file} is missing or incomplete`);
}
if (!commandReference.includes('schegent.exportAuditLog')) {
  failures.push('Command Palette reference is stale');
}
if (!release.includes('npm run verify:all')) failures.push('RELEASE.md omits verify:all');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Documentation/version checks passed for ${root.version}.`);
