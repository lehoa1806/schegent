// Feature 058 (US2, T006) — lint regression: NO source file under `src/`
// may directly index the first VS Code workspace folder with
// `workspaceFolders[0]` or `workspaceFolders?.[0]`. The literal patterns
// are permitted ONLY in `src/state/workspace-folder-picker.ts`, the
// single source-of-truth canonical-folder accessor introduced by 058
// (Option B per docs/plans/workspace-isolation-strategy.md).
//
// Permitted reads elsewhere:
//   - `workspaceFolders` (bare reference, used by the dashboard command —
//     it needs the full list, not the first folder).
//   - `workspaceFolders?.length` / `.length` (used as a "folders open?"
//     guard).
//
// The discipline mirrors the existing pinned-list regressions:
//   - tests/lint/mutating-command-name-gate.test.ts
//   - tests/lint/no-multi-queue-commands.test.ts
//
// The check uses `grep -rln` so any new offending file surfaces with a
// precise path. To resolve a failure: route the read through
// `getCanonicalWorkspaceRoot()` from `src/state/workspace-folder-picker.ts`.

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { filesMatching } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'src');

// The two literal patterns the lint regression forbids. Both forms have
// appeared historically (with and without optional chaining).
const FORBIDDEN_PATTERNS = ['workspaceFolders[0]', 'workspaceFolders?.[0]'] as const;

// Only the picker module is permitted to read first-folder. This list is
// intentionally short to keep drift visible.
const ALLOWED_FILES: ReadonlySet<string> = new Set(['src/state/workspace-folder-picker.ts']);

function listMatchingFiles(pattern: string): readonly string[] {
  const matches = new Set<string>();
  let out: string;
  try {
    // -F: fixed string match (so `[0]` and `?.[0]` are treated literally,
    // not as regex). -r: recursive. -l: list filenames. -n is omitted —
    // we surface lines via a second pass below for the failure message.
    out = filesMatching(SCAN_ROOT, pattern, { fixed: true }).join('\n');
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) return [];
    throw err;
  }
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const rel = trimmed.startsWith(REPO_ROOT + '/')
      ? trimmed.slice(REPO_ROOT.length + 1)
      : trimmed;
    matches.add(rel);
  }
  return [...matches];
}

describe('Feature 058 (US2, T006) — no direct first-workspace-folder reads outside the picker', () => {
  for (const pattern of FORBIDDEN_PATTERNS) {
    it(`'${pattern}' appears only in the allowlisted picker module`, () => {
      const matched = listMatchingFiles(pattern);
      const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
      expect(
        offenders,
        `Files reading '${pattern}' directly (route through getCanonicalWorkspaceRoot() instead):\n${offenders.join('\n')}`
      ).toEqual([]);
    });
  }
});
