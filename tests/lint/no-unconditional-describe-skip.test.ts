import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SELF = resolve(__filename);
const ROOTS = [resolve(REPO_ROOT, 'tests'), resolve(REPO_ROOT, 'webview-ui', 'src')];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.svelte']);

function sourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const name of readdirSync(path)) {
      const child = resolve(path, name);
      const stat = statSync(child);
      if (stat.isDirectory()) {
        visit(child);
      } else if (SOURCE_EXTENSIONS.has(extname(child)) && child !== SELF) {
        files.push(child);
      }
    }
  };
  visit(root);
  return files;
}

describe('traceability governance — skipped-suite discipline', () => {
  it('forbids unconditional describe.skip suites', () => {
    const offenders = ROOTS.flatMap(sourceFiles)
      .filter((path) => /\bdescribe\.skip\s*\(/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(REPO_ROOT.length + 1));

    expect(
      offenders,
      `Unconditional skipped suites create false coverage. Use a documented conditional release-only gate or remove the obsolete suite:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
