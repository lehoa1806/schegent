import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const COMPONENT_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');
const MAX_LINES = 500;

function collectSvelteFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectSvelteFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.svelte')) files.push(path);
  }
  return files;
}

describe('Feature 078 repository-wide Svelte LOC budget', () => {
  for (const path of collectSvelteFiles(COMPONENT_ROOT)) {
    const label = relative(REPO_ROOT, path);
    it(`${label} stays at or below ${MAX_LINES} physical lines`, () => {
      const source = readFileSync(path, 'utf8');
      const lines = source.length === 0 ? 0 : source.split(/\r?\n/).length;
      expect(lines, `${label} has ${lines} physical lines`).toBeLessThanOrEqual(MAX_LINES);
    });
  }
});
