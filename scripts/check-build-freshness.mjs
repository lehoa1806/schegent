#!/usr/bin/env node
/**
 * Feature 106 (T593, FR-019 to FR-022) — packaging refuses to run on stale output.
 *
 * `vsce package` reads `dist/`. It does not build it, and it does not care how old
 * it is, so `package:smoke` has always been able to pass on output from an earlier
 * checkout — or fail on it, which is worse, because the failure names packaged
 * content that the current source tree never produced. Feature 098's REL-03
 * resync started exactly there.
 *
 * Two comparisons, one per build half, because the two halves have different
 * output semantics. The webview build sets `emptyOutDir: true`, so every file
 * under `dist/webview/` is rewritten in one run and the newest of them dates the
 * build. The host build overwrites a single file in place, so `dist/extension.js`
 * dates itself. One comparison over both would let a fresh host bundle vouch for
 * a webview build from last week.
 *
 * The source scan skips tests (T593a). A refusal a reader learns to ignore is
 * worse than no refusal, and editing a test cannot change what gets packaged.
 */
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

import { STAGE_PACKAGING } from './check-vsix-smoke.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const BUILD_HALVES = Object.freeze([
  Object.freeze({
    half: 'host',
    output: 'dist/extension.js',
    sources: Object.freeze(['src']),
    rebuild: 'npm run build:host'
  }),
  Object.freeze({
    half: 'webview',
    output: 'dist/webview',
    sources: Object.freeze(['webview-ui/src']),
    rebuild: 'npm run build:webview'
  })
]);

const SKIPPED_DIRECTORIES = new Set(['__tests__', 'node_modules', '.vite']);

function isTestFile(name) {
  return name.includes('.test.') || name.includes('.spec.');
}

/**
 * The newest file at or beneath `path`, or `null` when there is nothing to date.
 *
 * `null` is the refusal signal in both directions: absent output, and a source
 * scan that found nothing. Returning a sentinel time instead — 0 for a missing
 * source tree, `Infinity` for missing output — would make each of those read as
 * "fresh", which is the vacuity this feature exists to remove.
 */
function newestFile(path, { skipTests }) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return null;
  }
  if (!stats.isDirectory()) {
    return { path, mtimeMs: stats.mtimeMs };
  }
  let newest = null;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const deeper = newestFile(join(path, entry.name), { skipTests });
      if (deeper !== null && (newest === null || deeper.mtimeMs > newest.mtimeMs)) newest = deeper;
      continue;
    }
    if (skipTests && isTestFile(entry.name)) continue;
    const full = join(path, entry.name);
    const mtimeMs = statSync(full).mtimeMs;
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
  }
  return newest;
}

function newestSource(root, sources) {
  let newest = null;
  for (const source of sources) {
    const found = newestFile(join(root, source), { skipTests: true });
    if (found !== null && (newest === null || found.mtimeMs > newest.mtimeMs)) newest = found;
  }
  return newest;
}

/**
 * The found files are reported under `newestOutput`/`newestSource` rather than
 * `output`/`source`. Feature 106 (T597c) had them as the latter, which shadowed
 * the configured `output` path with the file object, so the refusal named
 * `[object Object]` where the path belonged and `(null)` for absent output. The
 * declaration file encoded the same collision — `string & (FoundFile | null)` is
 * `never` — so the type was no help either. Distinct names cannot collide.
 */
export function buildFreshness(root = REPO_ROOT) {
  return BUILD_HALVES.map((half) => {
    const newestOutput = newestFile(join(root, half.output), { skipTests: false });
    const newestSource_ = newestSource(root, half.sources);
    const found = { newestOutput, newestSource: newestSource_ };
    if (newestOutput === null) return { ...half, state: 'absent', ...found };
    if (newestSource_ === null) return { ...half, state: 'unscannable', ...found };
    if (newestOutput.mtimeMs < newestSource_.mtimeMs) return { ...half, state: 'stale', ...found };
    return { ...half, state: 'fresh', ...found };
  });
}

function asPosix(root, path) {
  return relative(root, path).split(sep).join('/');
}

function shown(root, found) {
  if (found === null) return 'nothing';
  return `${asPosix(root, found.path)} at ${new Date(found.mtimeMs).toISOString()}`;
}

/**
 * The host half's output is one file, so naming the configured path and then the
 * dated file repeats itself — `dist/extension.js newest dist/extension.js at …`.
 * The webview half's is a directory, where the dated file is the one piece of
 * information the reader cannot work out, so it stays.
 */
function shownOutput(root, half) {
  const found = shown(root, half.newestOutput);
  if (half.newestOutput !== null && asPosix(root, half.newestOutput.path) === half.output) {
    return found;
  }
  return `${half.output} newest ${found}`;
}

function refusalLine(root, half) {
  if (half.state === 'absent') {
    return `${half.half} build output is absent (${half.output}) — run ${half.rebuild}`;
  }
  if (half.state === 'unscannable') {
    return (
      `${half.half} source scan found no file under ${half.sources.join(', ')} — ` +
      `refusing rather than reporting fresh`
    );
  }
  return (
    `${half.half} build output is older than its sources: ${shownOutput(root, half)}, ` +
    `source ${shown(root, half.newestSource)} — run ${half.rebuild}`
  );
}

/**
 * Feature 106 (FR-021, SC-012) — the refusal does not repair.
 *
 * It states which half is stale and which command rebuilds it, and creates,
 * changes and removes nothing. A check that quietly rebuilt would make the next
 * run pass without anyone having decided that the output should change.
 */
export function assertBuildOutputIsFresh(root = REPO_ROOT) {
  const refusals = buildFreshness(root).filter((half) => half.state !== 'fresh');
  if (refusals.length === 0) return;
  throw new Error(
    `${STAGE_PACKAGING} refusing to package: ${refusals.length} of ${BUILD_HALVES.length} ` +
      `build halves not current\n` +
      refusals.map((half) => `  ${refusalLine(root, half)}`).join('\n')
  );
}
