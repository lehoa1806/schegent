// Feature 056 Track 5 (FR-027 / FR-028 / SC-005) — Doc-drift guard.
//
// Operator-facing markdown docs MUST NOT reference symbols that have
// been removed from the source tree. Originally this test pinned the
// single symbol `WorkflowController.tryAutoDrain` (extracted into
// `AutoDrainCoordinator.drainIfIdle` in Track 7). The audit
// (2026-05-17) generalized the test into a table-driven allowlist so
// future symbol removals can be added with a one-line edit instead of
// a copy of the test file. SC-005 reads:
// "0 occurrences of `WorkflowController.tryAutoDrain` (or other
// documented removed symbols) in the operations docs."
//
// The `docs/features/*` and `specs/*` folders are intentionally
// out-of-scope (historical record); only operator-facing docs under
// `docs/operations/`, `README.md`, `ARCHITECTURE.md`, and the webview
// README are asserted.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * The allowlist of symbols that MUST NOT appear in operator-facing
 * docs. Each entry pairs the symbol with the PR / feature that
 * removed it so a future maintainer can trace the rationale.
 *
 * To add a removed symbol:
 *   1. Add a new entry to `REMOVED_SYMBOLS`.
 *   2. Confirm the symbol is genuinely gone from `src/` (grep first).
 *   3. Update any docs that still reference it BEFORE the test ships
 *      green — the test fails the build on the first appearance.
 */
const REMOVED_SYMBOLS: ReadonlyArray<{
  readonly symbol: string;
  readonly removedIn: string;
  readonly replacement?: string;
}> = Object.freeze([
  {
    symbol: 'tryAutoDrain',
    removedIn: 'feature 056 Track 7',
    replacement: 'AutoDrainCoordinator.drainIfIdle'
  }
]);

function walk(dir: string, accept: (p: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(abs, accept));
    } else if (entry.isFile() && accept(abs)) {
      found.push(abs);
    }
  }
  return found;
}

function collectDocTargets(): string[] {
  return [
    ...walk(path.join(REPO_ROOT, 'docs', 'operations'), (p) => p.endsWith('.md')),
    path.join(REPO_ROOT, 'README.md'),
    path.join(REPO_ROOT, 'ARCHITECTURE.md'),
    path.join(REPO_ROOT, 'webview-ui', 'README.md')
  ].filter((p) => fs.existsSync(p));
}

describe('Feature 056 Track 5 — operator docs are free of removed symbols', () => {
  const targets = collectDocTargets();
  for (const { symbol, removedIn, replacement } of REMOVED_SYMBOLS) {
    const label = replacement
      ? `${symbol} (removed in ${removedIn}; use ${replacement})`
      : `${symbol} (removed in ${removedIn})`;
    it(`does not reference ${label}`, () => {
      const offenders: Array<{ file: string; line: number; text: string }> = [];
      for (const file of targets) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, idx) => {
          if (line.includes(symbol)) {
            offenders.push({ file, line: idx + 1, text: line.trim() });
          }
        });
      }
      expect(offenders).toEqual([]);
    });
  }
});
