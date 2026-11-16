// The icon sprite's two rules, read from the source tree.
//
// 1. Every sprite reference in the webview names a symbol the sprite defines. A `<use>` that
//    points at a missing symbol draws nothing and raises no error, so nothing else would notice.
// 2. No component the sidebar loads references the sprite. Only the dashboard shell renders it;
//    the sidebar's startup bundle has no room for it.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..', '..', '..');
const SPRITE_PATH = resolve(__dirname, '..', 'SgSprite.svelte');
const SIDEBAR_ROOT = join(SRC, 'App.svelte');
const DASHBOARD_ROOT = join(SRC, 'dashboard', 'App.svelte');

const SYMBOL_ID = /<symbol id="([^"]+)"/g;
const REFERENCE = /#(i-[a-z]+)\b/g;
/** A reference built from parts, such as `#i-{name}`, which rule 1 could not read. */
const ASSEMBLED_REFERENCE = /#i-[{$]/;
const SVELTE_IMPORT = /from '(\.{1,2}\/[^']+\.svelte)'/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== '__tests__') sourceFiles(full, out);
      continue;
    }
    if (/\.(svelte|ts)$/.test(name) && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** The components a root reaches through static imports: what loads with it at startup. */
function staticComponents(root: string, seen = new Set<string>()): Set<string> {
  if (seen.has(root) || !existsSync(root)) return seen;
  seen.add(root);
  for (const match of readFileSync(root, 'utf8').matchAll(SVELTE_IMPORT)) {
    const target = match.at(1);
    if (target !== undefined) staticComponents(resolve(dirname(root), target), seen);
  }
  return seen;
}

const spriteSource = readFileSync(SPRITE_PATH, 'utf8');
const symbolIds = [...spriteSource.matchAll(SYMBOL_ID)].flatMap((match) => match.slice(1));
const callSites = sourceFiles(SRC).filter((file) => file !== SPRITE_PATH);

function referencesIn(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(REFERENCE)].flatMap((match) => match.slice(1));
}

describe('icon sprite', () => {
  it('defines each symbol once, under an id a reference can name', () => {
    expect(symbolIds.length).toBeGreaterThan(0);
    expect(new Set(symbolIds).size).toBe(symbolIds.length);
    for (const id of symbolIds) expect(id).toMatch(/^i-[a-z]+$/);
  });

  it('is rendered by the dashboard shell', () => {
    expect(staticComponents(DASHBOARD_ROOT).has(SPRITE_PATH)).toBe(true);
  });

  it('defines every symbol a call site references', () => {
    const defined = new Set(symbolIds);
    const missing: string[] = [];
    let references = 0;
    for (const file of callSites) {
      for (const id of referencesIn(file)) {
        references += 1;
        if (!defined.has(id)) missing.push(`${relative(SRC, file)}: #${id}`);
      }
    }
    // A scan that found no reference at all would pass the assertion below for the wrong reason.
    expect(references).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('is never referenced by an id assembled from parts', () => {
    const assembled = callSites
      .filter((file) => ASSEMBLED_REFERENCE.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(assembled).toEqual([]);
  });

  it('is not referenced by anything the sidebar loads', () => {
    const sidebar = [...staticComponents(SIDEBAR_ROOT)];
    // The sidebar root and its sections: fewer would mean the import walk stopped at the root.
    expect(sidebar.length).toBeGreaterThan(1);
    expect(sidebar).not.toContain(SPRITE_PATH);
    const offenders = sidebar
      .filter((file) => referencesIn(file).length > 0)
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
