// Feature 026 T010 — repo-grep regression test enforcing FR-003 single-call-site
// discipline for CMD_SAVE_PHASES.
//
// After T012 + T012a land, `CMD_SAVE_PHASES` is the only IPC command authorised
// to mutate the user-layer `schegent.phases` catalog from the webview, and the
// SOLE call site for `postCommand(CMD_SAVE_PHASES, ...)` is the shared helper
// at `webview-ui/src/lib/save-phases.ts`. To prevent drift back to inline
// `postCommand(CMD_SAVE_PHASES, …)` call sites in components, this test pins
// the allowlist of files that may reference the constant.
//
// This mirrors the established pattern at
// `tests/lint/no-inline-save-general-settings.test.ts`.

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // Declaration site (re-export shim).
  'webview-ui/src/lib/messages.ts',
  // The shared helper (only call site of postCommand(CMD_SAVE_PHASES, ...)).
  'webview-ui/src/lib/save-phases.ts',
  // The helper's unit test.
  'webview-ui/src/lib/__tests__/save-phases.test.ts',
  'webview-ui/src/lib/__tests__/save-catalog-command.test.ts',
  // PipelineBuilder.svelte may IMPORT the constant for type-binding via the
  // helper's argument shape but MUST NOT call postCommand(CMD_SAVE_PHASES, …)
  // inline — the test below explicitly scans component files for the
  // postCommand call pattern and bans it.
  'webview-ui/src/components/PipelineBuilder.svelte',
  // The component test file references the helper through CMD_SAVE_PHASES
  // identifier assertions.
  'webview-ui/src/components/__tests__/PipelineBuilder.test.ts'
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

describe('Feature 026 T010 — no inline CMD_SAVE_PHASES references', () => {
  it('only the allowlisted files reference CMD_SAVE_PHASES', () => {
    const matched = listMatchingFiles('CMD_SAVE_PHASES');
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Offending files referencing CMD_SAVE_PHASES:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('the shared helper file exists and is in the allowlist', () => {
    const matched = listMatchingFiles('CMD_SAVE_PHASES');
    expect(matched).toContain('webview-ui/src/lib/save-phases.ts');
  });

  it('no component file invokes postCommand(CMD_SAVE_PHASES, ...) inline', () => {
    // Specifically scan for the postCommand(CMD_SAVE_PHASES call pattern in
    // any component file (excluding __tests__/). The helper is the ONLY
    // permitted call site.
    const matched = listMatchingFiles('postCommand(CMD_SAVE_PHASES');
    const componentOffenders = matched.filter(
      (rel) =>
        rel.startsWith('webview-ui/src/components/') && !rel.includes('__tests__')
    );
    expect(componentOffenders).toEqual([]);
  });
});
