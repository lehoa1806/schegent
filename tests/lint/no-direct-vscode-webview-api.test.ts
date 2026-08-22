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

function matchingFiles(pattern: RegExp): readonly string[] {
  return listSourceFiles(SCAN_ROOT)
    .filter((abs) => pattern.test(readFileSync(abs, 'utf8')))
    .map(toRepoRelative)
    .sort();
}

function findOffenders(pattern: RegExp): readonly string[] {
  return matchingFiles(pattern).filter((rel) => !ALLOWED_FILES.has(rel));
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

  // Vacuity control. Every assertion above passes when the scan finds nothing —
  // which is what a moved scan root, a renamed extension, or a pattern that
  // stopped matching all look like. The allowlisted adapter is the anchor: it
  // must appear, or the scan is broken rather than the tree clean.
  it('finds the transport adapter, so a broken scan cannot read as a clean tree', () => {
    expect(
      listSourceFiles(SCAN_ROOT).length,
      `No source files under ${SCAN_ROOT}. The scan root has moved or the extension ` +
        `filter no longer matches this tree.`
    ).toBeGreaterThan(50);
    expect(
      matchingFiles(/\bacquireVsCodeApi\b/),
      'The allowlisted adapter no longer matches acquireVsCodeApi. Either the adapter ' +
        'moved (update ALLOWED_FILES) or the pattern has stopped matching — in which ' +
        'case every assertion above is passing vacuously.'
    ).toContain('webview-ui/src/lib/vscode-transport.ts');
  });
});
