// Feature 073 T005 — repo-grep regression test enforcing single-call-site
// discipline for `CMD_READ_METRICS`.
//
// `CMD_READ_METRICS` is the only IPC command authorised to read the
// aggregated metrics-dashboard payload from the webview. The SOLE call
// site of `postCommand(CMD_READ_METRICS, …)` must be the shared helper at
// `webview-ui/src/lib/metrics-ipc.ts` (created in T012). This test pins
// the allowlist; any drift fails the build.
//
// Mirrors the established pattern at
// `tests/lint/no-inline-phase-log-ipc.test.ts`
// (contracts/cmd-read-metrics.md's "Invariants (test-enforced)" section).

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // The webview shim that re-exports `CMD_READ_METRICS` from
  // `src/contracts/sidebar-ipc.ts` via a single `export *`. The shim
  // contains no logic; grep cannot follow re-exports so the file must
  // be allowlisted.
  'webview-ui/src/lib/messages.ts',
  // The shared helper — the SINGLE call site of
  // postCommand(CMD_READ_METRICS, ...).
  'webview-ui/src/lib/metrics-ipc.ts'
]);

function listMatchingFiles(pattern: string): readonly string[] {
  let out: string;
  try {
    out = execSync(`grep -rln "${pattern}" "${SCAN_ROOT}"`, { encoding: 'utf8' });
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) {
      return [];
    }
    if (e.status === 2) {
      return [];
    }
    throw err;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((abs) =>
      abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs
    );
}

describe('Feature 073 T005 — no inline CMD_READ_METRICS references', () => {
  it('only the allowlisted files reference CMD_READ_METRICS', () => {
    const matched = listMatchingFiles('CMD_READ_METRICS');
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Offending files referencing CMD_READ_METRICS:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('the shared helper file exists and is in the allowlist', () => {
    const matched = listMatchingFiles('CMD_READ_METRICS');
    expect(matched).toContain('webview-ui/src/lib/metrics-ipc.ts');
  });

  it('no component file invokes postCommand(CMD_READ_METRICS, ...) inline', () => {
    const matched = listMatchingFiles('postCommand(CMD_READ_METRICS');
    const componentOffenders = matched.filter(
      (rel) =>
        rel.startsWith('webview-ui/src/components/') && !rel.includes('__tests__')
    );
    expect(componentOffenders).toEqual([]);
  });
});
