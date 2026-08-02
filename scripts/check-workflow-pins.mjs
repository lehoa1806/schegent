import { readFileSync, readdirSync } from 'node:fs';

const workflows = readdirSync('.github/workflows')
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => `.github/workflows/${name}`)
  .sort();
const failures = [];

for (const file of workflows) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    const match = line.match(/\buses:\s*([^\s#]+)@([^\s#]+)/);
    if (!match || match[1].startsWith('./')) continue;
    if (!/^[0-9a-f]{40}$/.test(match[2])) {
      failures.push(`${file}:${index + 1}: ${match[1]}@${match[2]}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Workflow actions must use immutable 40-character commit SHAs:\n${failures.join('\n')}`);
  process.exit(1);
}

console.log(`Workflow action pin check passed (${workflows.length} workflows).`);
