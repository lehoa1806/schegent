// Feature 030 T030 (US2) — repo-grep regression test enforcing the
// single-call-site discipline for the three reorder IPC commands.
//
// After T033 + T034 land, `CMD_REORDER_TASK`, `CMD_MOVE_QUEUE_ITEM_UP`,
// and `CMD_MOVE_QUEUE_ITEM_DOWN` are the only IPC commands that drive
// queue reorder from the webview, and the SOLE call site for
// `postCommand(CMD_REORDER_TASK, ...)` / `postCommand(CMD_MOVE_QUEUE_ITEM_UP, ...)` /
// `postCommand(CMD_MOVE_QUEUE_ITEM_DOWN, ...)` is the shared helper at
// `webview-ui/src/lib/reorder-task.ts`. To prevent drift back to inline
// `postCommand(CMD_REORDER_TASK, …)` call sites in components, this
// test pins the allowlist of files that may reference these constants.
//
// This mirrors the established pattern at
// `tests/lint/no-inline-phase-breakpoint-ipc.test.ts`.

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { matchingRelativePaths } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // Declaration site (re-export shim).
  'webview-ui/src/lib/messages.ts',
  // The shared helper (only call site of postCommand for the three commands).
  'webview-ui/src/lib/reorder-task.ts',
  // The helper's unit test.
  'webview-ui/src/lib/__tests__/reorder-task.test.ts',
  // QueueItem component reorder unit test references the constants
  // through assertions but does not invoke postCommand inline — it
  // calls the shared helper exports.
  'webview-ui/src/components/__tests__/QueueItem.reorder.test.ts',
  // QueueDetailTier's reorder coverage (feature 097 restoration of this
  // capability onto QueueDetailRows.svelte) asserts the same way: against
  // the shared helper's dispatched commands, never an inline postCommand.
  'webview-ui/src/components/drilldown/__tests__/QueueDetailTier.test.ts'
]);


const matchRel = (pattern: string): readonly string[] =>
  matchingRelativePaths(REPO_ROOT, SCAN_ROOT, pattern, { fixed: true });

describe('Feature 030 T030 — no inline reorder IPC references', () => {
  it('only the allowlisted files reference CMD_REORDER_TASK', () => {
    const matched = matchRel('CMD_REORDER_TASK');
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Offending files referencing CMD_REORDER_TASK:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('only the allowlisted files reference CMD_MOVE_QUEUE_ITEM_UP', () => {
    const matched = matchRel('CMD_MOVE_QUEUE_ITEM_UP');
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Offending files referencing CMD_MOVE_QUEUE_ITEM_UP:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('only the allowlisted files reference CMD_MOVE_QUEUE_ITEM_DOWN', () => {
    const matched = matchRel('CMD_MOVE_QUEUE_ITEM_DOWN');
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Offending files referencing CMD_MOVE_QUEUE_ITEM_DOWN:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('the shared helper file exists and is in the allowlist', () => {
    const matched = matchRel('CMD_REORDER_TASK');
    expect(matched).toContain('webview-ui/src/lib/reorder-task.ts');
  });

  it('no component file invokes postCommand(CMD_REORDER_TASK, ...) inline', () => {
    // Specifically scan for the postCommand(CMD_REORDER_TASK call pattern in
    // any component file (excluding __tests__/). The helper is the ONLY
    // permitted call site.
    const matched = matchRel('postCommand(CMD_REORDER_TASK');
    const componentOffenders = matched.filter(
      (rel) =>
        rel.startsWith('webview-ui/src/components/') && !rel.includes('__tests__')
    );
    expect(componentOffenders).toEqual([]);
  });

  it('no component file invokes postCommand(CMD_MOVE_QUEUE_ITEM_UP, ...) inline', () => {
    const matched = matchRel('postCommand(CMD_MOVE_QUEUE_ITEM_UP');
    const componentOffenders = matched.filter(
      (rel) =>
        rel.startsWith('webview-ui/src/components/') && !rel.includes('__tests__')
    );
    expect(componentOffenders).toEqual([]);
  });

  it('no component file invokes postCommand(CMD_MOVE_QUEUE_ITEM_DOWN, ...) inline', () => {
    const matched = matchRel('postCommand(CMD_MOVE_QUEUE_ITEM_DOWN');
    const componentOffenders = matched.filter(
      (rel) =>
        rel.startsWith('webview-ui/src/components/') && !rel.includes('__tests__')
    );
    expect(componentOffenders).toEqual([]);
  });
});
