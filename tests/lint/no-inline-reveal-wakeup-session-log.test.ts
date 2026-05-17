// Feature 031 T050 — repo-grep regression test enforcing single-call-site
// discipline for `CMD_REVEAL_WAKEUP_SESSION_LOG`.
//
// `CMD_REVEAL_WAKEUP_SESSION_LOG` is the only IPC command authorised to
// open the OS file manager at the wake-up session-log file from the
// webview. The SOLE call site of `postCommand(CMD_REVEAL_WAKEUP_SESSION_LOG, …)`
// must be the shared helper at
// `webview-ui/src/lib/reveal-wakeup-session-log.ts`. This test pins the
// allowlist; any drift fails the build.
//
// Mirrors the established pattern at
// `tests/lint/no-inline-read-wakeup-session-log.test.ts`.

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // The webview shim that re-exports `CMD_REVEAL_WAKEUP_SESSION_LOG`
  // from `src/contracts/sidebar-ipc.ts` via a single `export *`. The
  // shim contains no logic; grep cannot follow re-exports so the file
  // must be allowlisted.
  'webview-ui/src/lib/messages.ts',
  // The shared helper (the SINGLE call site of
  // postCommand(CMD_REVEAL_WAKEUP_SESSION_LOG, ...)).
  'webview-ui/src/lib/reveal-wakeup-session-log.ts'
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

describe('Feature 031 T050 — no inline CMD_REVEAL_WAKEUP_SESSION_LOG references', () => {
  it('only the allowlisted files reference CMD_REVEAL_WAKEUP_SESSION_LOG', () => {
    const matched = listMatchingFiles('CMD_REVEAL_WAKEUP_SESSION_LOG');
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Offending files referencing CMD_REVEAL_WAKEUP_SESSION_LOG:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('the shared helper file exists and is in the allowlist', () => {
    const matched = listMatchingFiles('CMD_REVEAL_WAKEUP_SESSION_LOG');
    expect(matched).toContain('webview-ui/src/lib/reveal-wakeup-session-log.ts');
  });

  it('no component file invokes postCommand(CMD_REVEAL_WAKEUP_SESSION_LOG, ...) inline', () => {
    const matched = listMatchingFiles('postCommand(CMD_REVEAL_WAKEUP_SESSION_LOG');
    const componentOffenders = matched.filter(
      (rel) =>
        rel.startsWith('webview-ui/src/components/') && !rel.includes('__tests__')
    );
    expect(componentOffenders).toEqual([]);
  });
});
