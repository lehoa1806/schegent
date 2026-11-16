/**
 * Components read colour, type and borders through the `--schegent-*` tokens in
 * `lib/theme.css`, never a `--vscode-*` variable of their own.
 *
 * The token layer is where a VS Code variable gets its fallback, its high
 * contrast override and its text-safe mix (saturated accents never colour
 * small text). A component that reads the variable directly skips all three,
 * and a theme that leaves the variable unset paints it with the browser's
 * initial value instead. Variables the layer did not yet carry get a token
 * there first.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPONENTS_DIR = join(__dirname, '..');
const SOURCE_EXTENSIONS = ['.svelte', '.css', '.ts'];
const RAW_READ = 'var(--vscode-';

function componentSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...componentSources(path));
      continue;
    }
    if (entry.name.endsWith('.test.ts')) continue;
    if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) files.push(path);
  }
  return files;
}

function rawReads(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      line.includes(RAW_READ) ? [`${relative(COMPONENTS_DIR, file)} line ${index + 1}`] : []
    );
}

describe('the theme token layer', () => {
  it('finds component sources to scan', () => {
    expect(componentSources(COMPONENTS_DIR).length).toBeGreaterThan(100);
  });

  it('is the only reader of VS Code theme variables', () => {
    const offenders = componentSources(COMPONENTS_DIR).flatMap(rawReads);
    expect(offenders).toEqual([]);
  });
});
