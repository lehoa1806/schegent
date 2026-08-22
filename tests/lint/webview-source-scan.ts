// FR-R3-033 — the shared webview source scan.
//
// Two per-family inline-IPC gates used to resolve their file sets by spawning
// `rg`. Ripgrep is in no `devDependencies`, no workflow install step, and no
// prerequisite list, so `npm run test:host` — and therefore the `ci:fast` that
// CONTRIBUTING names as the review expectation — could not pass from a clean
// checkout that followed the documented setup. The other 86 gates in this
// directory walk the tree with `node:fs` or parse it with the TypeScript
// compiler; those two were the outliers.
//
// The subprocess is gone. The two properties that made those gates trustworthy
// are not:
//
//   * They failed CLOSED. A missing binary rethrew rather than yielding an
//     empty match set, and a vacuous pass would have been far worse than a red
//     gate. The equivalent here is `filesReferencing`'s contract: a scan that
//     resolves no files at all is a failure for the caller to assert on, and
//     `scanWebviewSources` refuses to return an empty tree.
//   * They asserted a known helper was found. That control is what makes the
//     negative assertion mean anything, and it belongs to the callers, which
//     keep it verbatim.
//
// One walk serves every literal. Walking per literal would turn one subprocess
// into three full traversals on every `test:host` run.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = 'webview-ui/src';

/**
 * Directory names never scanned.
 *
 * Every entry here is a directory this repository's `.gitignore` actually
 * ignores at any depth, because the ripgrep version skipped exactly what git
 * ignores and this walk has to resolve the same set. Getting that wrong is a
 * silent false negative: a violation living in a skipped directory that ripgrep
 * would have reported.
 *
 * Two names were in an earlier draft and are deliberately absent:
 *
 *   * `build` — `.gitignore` anchors it as `/build/`, root only, with its own
 *     comment explaining that an unanchored form would swallow
 *     `tests/unit/build/`. A `build` directory under `webview-ui/src` is
 *     therefore tracked, and ripgrep scans it.
 *   * `.svelte-kit` — not in `.gitignore` at all.
 *
 * Skipping either would have made this gate blind inside a plausibly-named
 * directory. `components/Builder` already exists in this tree.
 */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage']);

export interface ScannedFile {
  /** Repo-relative path, matching what the ripgrep version reported. */
  readonly path: string;
  readonly contents: string;
}

let cached: readonly ScannedFile[] | undefined;

/**
 * Every file under `webview-ui/src`, read once per process.
 *
 * Symlinks are not followed: `statSync` on a symlinked directory would resolve
 * through it and could walk out of the scan root entirely, which is both a
 * different result set and an unbounded one.
 */
export function scanWebviewSources(): readonly ScannedFile[] {
  if (cached) return cached;
  const found: ScannedFile[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(resolve(REPO_ROOT, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(child);
        continue;
      }
      if (!entry.isFile()) continue;
      found.push({ path: child, contents: readFileSync(resolve(REPO_ROOT, child), 'utf8') });
    }
  };
  walk(SCAN_ROOT);
  if (found.length === 0) {
    // Fail closed. An empty tree means the scan root moved or the walk is
    // broken, and every caller's "no disallowed call sites" assertion would
    // pass vacuously on it.
    throw new Error(
      `webview source scan resolved no files under ${SCAN_ROOT}. This scan replaced a ripgrep ` +
        `spawn and inherits its fail-closed contract: an empty result is a broken scan, not a ` +
        `clean tree.`
    );
  }
  cached = found;
  return cached;
}

/** Repo-relative paths of every scanned file naming `literal`, sorted. */
export function filesReferencing(literal: string): readonly string[] {
  return scanWebviewSources()
    .filter((file) => file.contents.includes(literal))
    .map((file) => file.path)
    .sort();
}
