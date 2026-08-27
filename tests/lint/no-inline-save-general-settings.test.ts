// Feature 012 T052 — repo-grep regression test enforcing FR-031.
//
// After the dedup refactor, `CMD_SAVE_GENERAL_SETTINGS` is the only IPC
// command authorised to mutate `schegent.*` workspace settings as a
// transactional batch. To prevent drift back to the pre-refactor pattern
// (multiple components calling `postCommand(CMD_SAVE_GENERAL_SETTINGS,
// ...)` inline), this test pins the allowlist of files that may
// reference the constant.
//
// Allowed references:
//   - webview-ui/src/lib/messages.ts          (the IPC-constant declaration)
//   - webview-ui/src/lib/save-general-settings.ts (the shared helper)
//   - webview-ui/src/lib/__tests__/save-general-settings.test.ts (its test)
//
// Anything else fails this test.
//
// FR-R3-132 (T1502) — `webview-ui/src/lib/snapshot-types.ts` was allowlisted for a
// JSDoc mention of the command. The de-duplication deleted 66 declarations from
// that file, the mention went with them, and `allowlist-entries-still-apply.test.ts`
// caught the entry excusing something that no longer happens. Removed rather than
// left: a standing permission whose reason has expired pre-excuses the next
// violation written there.

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { matchingRelativePaths } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // Declaration site.
  // The shared helper (only call site of postCommand(CMD_SAVE_GENERAL_SETTINGS, ...)).
  'webview-ui/src/lib/save-general-settings.ts',
  // The helper's unit test.
  'webview-ui/src/lib/__tests__/save-general-settings.test.ts',
  // Black-box test that asserts the helper still posts CMD_SAVE_GENERAL_SETTINGS
  // for the autocompact field. Verifies the wire-format contract end-to-end.
  'webview-ui/src/components/settings/__tests__/GeneralSettingsTab.autocompact.test.ts',
  // Feature 019 — black-box test for the runtime-log controls. Asserts the
  // helper posts CMD_SAVE_GENERAL_SETTINGS with the runtime-log keyed payload.
  'webview-ui/src/components/settings/__tests__/runtime-log-controls.test.ts'
]);


const matchRel = (pattern: string): readonly string[] =>
  matchingRelativePaths(REPO_ROOT, SCAN_ROOT, pattern, { fixed: true });

describe('Feature 012 T052 — no inline CMD_SAVE_GENERAL_SETTINGS references', () => {
  it('only the allowlisted files reference CMD_SAVE_GENERAL_SETTINGS', () => {
    const matched = matchRel('CMD_SAVE_GENERAL_SETTINGS');
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(offenders, `Offending files referencing CMD_SAVE_GENERAL_SETTINGS:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the shared helper file exists and is in the allowlist', () => {
    const matched = matchRel('CMD_SAVE_GENERAL_SETTINGS');
    expect(matched).toContain('webview-ui/src/lib/save-general-settings.ts');
  });

  it('no component file under webview-ui/src/components references the constant', () => {
    const matched = matchRel('CMD_SAVE_GENERAL_SETTINGS');
    const componentOffenders = matched.filter((rel) =>
      rel.startsWith('webview-ui/src/components/') && !rel.includes('__tests__')
    );
    expect(componentOffenders).toEqual([]);
  });
});
