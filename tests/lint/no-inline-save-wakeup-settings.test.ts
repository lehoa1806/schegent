// Feature 014 T006 — repo-grep regression test enforcing FR-020.
//
// `CMD_SAVE_WAKEUP_SETTINGS` is the only IPC command authorised to
// mutate the four `schegent.wakeUp.*` Global-scope settings keys and
// drive the OS-native daemon. To prevent drift back to a pre-refactor
// pattern (multiple components calling `postCommand(CMD_SAVE_WAKEUP_SETTINGS,
// ...)` inline), this test pins the allowlist of webview files that may
// reference the constant.
//
// Allowed references:
//   - webview-ui/src/lib/messages.ts                    (the IPC-constant re-export shim)
//   - webview-ui/src/lib/save-wakeup-settings.ts        (the SINGLE shared helper)
//   - webview-ui/src/lib/__tests__/save-wakeup-settings.test.ts (its test)
//
// Anything else fails this test.

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // The webview shim that re-exports `CMD_SAVE_WAKEUP_SETTINGS` from
  // `src/contracts/sidebar-ipc.ts`. Mentions the literal only via the
  // single `export *` re-export, but grep does not parse re-exports —
  // so the shim must be allowlisted.
  'webview-ui/src/lib/messages.ts',
  // The shared helper (the SINGLE call site for
  // postCommand(CMD_SAVE_WAKEUP_SETTINGS, ...)).
  'webview-ui/src/lib/save-wakeup-settings.ts',
  // The helper's unit test (asserts wire-format contract).
  'webview-ui/src/lib/__tests__/save-wakeup-settings.test.ts'
]);

function listMatchingFiles(): readonly string[] {
  let out: string;
  try {
    out = execSync(
      `grep -rln "CMD_SAVE_WAKEUP_SETTINGS" "${SCAN_ROOT}"`,
      { encoding: 'utf8' }
    );
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
    .map((abs) => abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs);
}

describe('Feature 014 T006 — no inline CMD_SAVE_WAKEUP_SETTINGS references', () => {
  it('only the allowlisted files reference CMD_SAVE_WAKEUP_SETTINGS', () => {
    const matched = listMatchingFiles();
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Offending files referencing CMD_SAVE_WAKEUP_SETTINGS:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('no component file under webview-ui/src/components references the constant', () => {
    const matched = listMatchingFiles();
    const componentOffenders = matched.filter((rel) =>
      rel.startsWith('webview-ui/src/components/') && !rel.includes('__tests__')
    );
    expect(componentOffenders).toEqual([]);
  });

  // Feature 031 T020 — pin the WakeupModelSelector to the same
  // single-call-site discipline. The new component MUST route saves
  // through `webview-ui/src/lib/save-wakeup-settings.ts` rather than
  // inlining `postCommand(CMD_SAVE_WAKEUP_SETTINGS, …)`.
  it('WakeupModelSelector.svelte does NOT inline CMD_SAVE_WAKEUP_SETTINGS', () => {
    const matched = listMatchingFiles();
    const wakeupComponentOffenders = matched.filter(
      (rel) =>
        rel.startsWith('webview-ui/src/components/settings/wakeup/') &&
        rel.endsWith('.svelte')
    );
    expect(
      wakeupComponentOffenders,
      `Wake-up component files inlining CMD_SAVE_WAKEUP_SETTINGS:\n${wakeupComponentOffenders.join('\n')}`
    ).toEqual([]);
  });
});
