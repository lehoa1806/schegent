import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((file) => !file.startsWith('tests/') && !file.endsWith('package-lock.json'));
const signatures = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/
];
const findings = [];
for (const file of files) {
  let body;
  try { body = readFileSync(file, 'utf8'); } catch { continue; }
  if (signatures.some((signature) => signature.test(body))) findings.push(file);
}
if (findings.length) {
  console.error(`Potential secrets found in:\n${findings.join('\n')}`);
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} tracked files).`);
