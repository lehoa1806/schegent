/**
 * Grounds the pinned VSIX chunk list in the webview source tree.
 *
 * `vsix-content-policy.test.ts` feeds `ALLOWED_VSIX_ENTRIES` to its own
 * validator, so it passes by construction however stale the pin becomes. The
 * only check that compares the pin against reality is `package:smoke`, which
 * sits at the very end of `npm run ci` behind `test:visual` — so when the
 * visual suite broke, the pin drifted through features 081-095 unnoticed and
 * surfaced as nine unpinned chunks and seven unpinned stylesheets at once.
 *
 * These two checks need no build, so they run in `npm run test`:
 *
 *   1. every pinned chunk names a module that exists under `webview-ui/src/`
 *      — catches a pin left behind by a deleted surface;
 *   2. every dynamically imported surface has a pinned chunk — catches the
 *      case that actually happened, a new lazily-loaded route (092's
 *      `QueueDetailTier` / `RunDetailTier`) shipped without re-pinning.
 *
 * This does not replace `package:smoke`. Vite also emits shared chunks it
 * extracts on its own (`format.js`, `WorkflowRun.js`, the `indexN.css`
 * stylesheets), and those are not derivable from source without building, so
 * only the archive check sees them. The point is to front-load the two
 * directions that drift in practice, not to claim the pin is fully verified
 * here.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WEBVIEW_SRC = path.join(REPO_ROOT, 'webview-ui', 'src');
const CHUNK_PREFIX = 'extension/dist/webview/chunks/';

/** A chunk may be emitted from a component, a module, or a stylesheet. */
const SOURCE_EXTENSIONS = ['.svelte', '.ts', '.css'] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
      continue;
    }
    out.push(full);
  }
  return out;
}

const SOURCE_FILES = walk(WEBVIEW_SRC);

function sourceExistsFor(basename: string): boolean {
  return SOURCE_FILES.some((file) =>
    SOURCE_EXTENSIONS.some((ext) => path.basename(file) === `${basename}${ext}`)
  );
}

async function pinnedChunkBasenames(): Promise<readonly string[]> {
  const { ALLOWED_VSIX_ENTRIES } = await import('../../../scripts/check-vsix-smoke.mjs');
  return ALLOWED_VSIX_ENTRIES.filter((name) => name.startsWith(CHUNK_PREFIX)).map((name) =>
    path.basename(name, '.js')
  );
}

/**
 * Runtime `import('./Thing.svelte')` only. A `typeof import(...)` is a type
 * position and emits no chunk, so counting it would demand a pin for something
 * the build never produces.
 */
function dynamicallyImportedComponents(): readonly string[] {
  const found = new Set<string>();
  for (const file of SOURCE_FILES) {
    if (!file.endsWith('.svelte') && !file.endsWith('.ts')) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(typeof\s+)?import\(\s*['"]([^'"]+\.svelte)['"]\s*\)/g)) {
      if (match[1] !== undefined) continue;
      found.add(path.basename(match[2], '.svelte'));
    }
  }
  return [...found].sort();
}

describe('the pinned VSIX chunk list is grounded in the webview source tree', () => {
  it('every pinned chunk names a module that exists', async () => {
    const orphaned = (await pinnedChunkBasenames()).filter((name) => !sourceExistsFor(name));
    expect(
      orphaned,
      'these chunks are pinned but have no source module; the surface was removed without unpinning it'
    ).toEqual([]);
  });

  it('every lazily-loaded surface is pinned', async () => {
    const pinned = new Set(await pinnedChunkBasenames());
    const unpinned = dynamicallyImportedComponents().filter((name) => !pinned.has(name));
    expect(
      unpinned,
      `these components are dynamically imported but absent from ALLOWED_VSIX_ENTRIES; ` +
        `add extension/dist/webview/chunks/<name>.js for each`
    ).toEqual([]);
  });

  it('finds the dynamic imports it claims to check', () => {
    // A regex that stops matching would make the check above vacuously green,
    // which is the same failure mode this file exists to close.
    expect(dynamicallyImportedComponents().length).toBeGreaterThan(0);
  });
});
