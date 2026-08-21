/**
 * Feature 106 (T592a, T592b, FR-036) — an independent scan of the webview source
 * tree, deliberately not the script's.
 *
 * `check-vsix-smoke.mjs` scans for authored code-split boundaries so it can
 * assert every one of them reached the package. Two tests need the same answer
 * for different reasons: the grounding test compares the two scans (a second
 * implementation is the only thing that can catch the first going quiet), and the
 * content-policy test needs an expected package listing that does not come from
 * the module under test. Both would otherwise import the script's own scan and
 * assert it agrees with itself.
 *
 * This is the same precedent as the `examples/` comparison one file over: the
 * `.DS_Store` exclusion is spelled out in both implementations on purpose.
 */

import * as fs from 'fs';
import * as path from 'path';

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const WEBVIEW_SRC = path.join(REPO_ROOT, 'webview-ui', 'src');

export function walk(dir: string, out: string[] = []): string[] {
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

function isAuthoredSource(file: string): boolean {
  if (!file.endsWith('.svelte') && !file.endsWith('.ts')) return false;
  return !file.includes('.test.') && !file.includes('.spec.');
}

/**
 * Runtime `import('./Thing.svelte')` only. A `typeof import(...)` is a type
 * position and emits no chunk, so counting it would demand a chunk the build
 * never produces.
 */
export function dynamicallyImportedComponents(): readonly string[] {
  const found = new Set<string>();
  for (const file of walk(WEBVIEW_SRC).filter(isAuthoredSource)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(typeof\s+)?import\(\s*['"]([^'"]+\.svelte)['"]\s*\)/g)) {
      if (match[1] !== undefined) continue;
      found.add(path.basename(match[2], '.svelte'));
    }
  }
  return [...found].sort();
}

export const WEBVIEW_ENTRY_PREFIX = 'extension/dist/webview/';

/**
 * A listing shaped like a real package: every hand-maintained entry, a chunk for
 * every authored boundary, and three numbered stylesheets contiguous from 2.
 *
 * Three is arbitrary — no requirement fixes the count, only the contiguity — and a
 * real build currently emits thirteen. The hand-maintained half comes from the
 * module because a reviewed list has nothing to be derived from (FR-010); the
 * chunk and stylesheet halves do not, which is what makes accepting this listing
 * an observation rather than a restatement of the pin.
 */
export async function plausiblePackagedNames(): Promise<string[]> {
  const { ALLOWED_VSIX_ENTRIES } = await import('../../../scripts/check-vsix-smoke.mjs');
  return [
    ...ALLOWED_VSIX_ENTRIES,
    ...dynamicallyImportedComponents().map((name) => `${WEBVIEW_ENTRY_PREFIX}chunks/${name}.js`),
    `${WEBVIEW_ENTRY_PREFIX}index2.css`,
    `${WEBVIEW_ENTRY_PREFIX}index3.css`,
    `${WEBVIEW_ENTRY_PREFIX}index4.css`
  ];
}
