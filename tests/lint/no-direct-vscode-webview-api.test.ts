import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  'webview-ui/src/lib/vscode-transport.ts'
]);

function toRepoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).replaceAll('\\', '/');
}

function listSourceFiles(dir: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(abs));
      continue;
    }
    if (
      (abs.endsWith('.ts') && !abs.endsWith('.test.ts'))
      || abs.endsWith('.svelte')
      || abs.endsWith('.svelte.ts')
    ) {
      files.push(abs);
    }
  }
  return files;
}

function findOffenders(pattern: RegExp): readonly string[] {
  return listSourceFiles(SCAN_ROOT)
    .filter((abs) => pattern.test(readFileSync(abs, 'utf8')))
    .map(toRepoRelative)
    .filter((rel) => !ALLOWED_FILES.has(rel))
    .sort();
}

describe('Feature 065 — no direct VS Code webview API outside adapter', () => {
  it('confines acquireVsCodeApi access to the VS Code transport adapter', () => {
    const offenders = findOffenders(/\bacquireVsCodeApi\b/);
    expect(
      offenders,
      `Offending files referencing acquireVsCodeApi:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('confines raw message event listeners to the VS Code transport adapter', () => {
    const offenders = findOffenders(/\baddEventListener\s*\(\s*['"]message['"]/);
    expect(
      offenders,
      `Offending files registering message listeners directly:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
