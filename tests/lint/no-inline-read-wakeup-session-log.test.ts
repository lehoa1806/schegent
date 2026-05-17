// Feature 031 T009 — repo-grep regression test enforcing single-call-site
// discipline for `CMD_READ_WAKEUP_SESSION_LOG`.
//
// `CMD_READ_WAKEUP_SESSION_LOG` is the only IPC command authorised to read
// a sanitized wake-up session-log block from the webview. The SOLE call
// site of `postCommand(CMD_READ_WAKEUP_SESSION_LOG, …)` must be the shared
// helper at `webview-ui/src/lib/wakeup-session-log-ipc.ts` (created in
// T037). This test pins the allowlist; any drift fails the build.
//
// Mirrors the established pattern at
// `tests/lint/no-inline-save-wakeup-settings.test.ts` and
// `tests/lint/no-inline-phase-log-ipc.test.ts`.
//
// NOTE — this is the T009 scaffold: the helper file does NOT exist yet
// (T037 in Phase 4 creates it). Until then the first test asserts the
// constant is ONLY referenced by the IPC shim and (eventually) by the
// helper + its tests. The second test asserts the helper file's path
// is in the allowlist (and thus must exist before the test passes).
// Both tests are expected to fail-red until T037 lands.

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // The webview shim that re-exports `CMD_READ_WAKEUP_SESSION_LOG` from
  // `src/contracts/sidebar-ipc.ts` via a single `export *`. The shim
  // contains no logic; grep cannot follow re-exports so the file must
  // be allowlisted.
  'webview-ui/src/lib/messages.ts',
  // The shared helper (the SINGLE call site of
  // postCommand(CMD_READ_WAKEUP_SESSION_LOG, ...) — created in T037).
  'webview-ui/src/lib/wakeup-session-log-ipc.ts',
  // The helper's unit test (created alongside T037).
  'webview-ui/src/lib/__tests__/wakeup-session-log-ipc.test.ts'
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

describe('Feature 031 T009 — no inline CMD_READ_WAKEUP_SESSION_LOG references', () => {
  it('only the allowlisted files reference CMD_READ_WAKEUP_SESSION_LOG', () => {
    const matched = listMatchingFiles('CMD_READ_WAKEUP_SESSION_LOG');
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Offending files referencing CMD_READ_WAKEUP_SESSION_LOG:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('the shared helper file exists and is in the allowlist (red until T037)', () => {
    // The helper does not exist yet. This test fails until T037 creates
    // `webview-ui/src/lib/wakeup-session-log-ipc.ts`. The fail-red state
    // is the expected scaffold per the task description.
    const matched = listMatchingFiles('CMD_READ_WAKEUP_SESSION_LOG');
    expect(matched).toContain('webview-ui/src/lib/wakeup-session-log-ipc.ts');
  });

  it('no component file invokes postCommand(CMD_READ_WAKEUP_SESSION_LOG, ...) inline', () => {
    const matched = listMatchingFiles('postCommand(CMD_READ_WAKEUP_SESSION_LOG');
    const componentOffenders = matched.filter(
      (rel) =>
        rel.startsWith('webview-ui/src/components/') && !rel.includes('__tests__')
    );
    expect(componentOffenders).toEqual([]);
  });
});
