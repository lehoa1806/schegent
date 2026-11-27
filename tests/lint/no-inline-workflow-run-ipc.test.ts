// Feature 088 T042 — the connected-run family has one webview call site.
//
// The hard rule is "never add inline postCommand(...) calls for IPC families
// that have a shared helper", and this is that rule for `CMD_LAUNCH_WORKFLOW`
// and `CMD_CONTINUE_WORKFLOW`. It matters more here than for a settings write,
// for a reason specific to this family: `CMD_CONTINUE_WORKFLOW` carries an
// `expectedRevision`, and the compare-and-set it feeds is the ONLY idempotency
// mechanism the family has (contract, *Idempotency*). A second call site is a
// second place that decides which revision to echo back — and one that echoed a
// guessed or stale value would turn a duplicate submission into a second child
// run rather than a refusal.
//
// Mirrors the established per-family scans (`no-inline-run-launcher-ipc`,
// `no-inline-save-phases`, `no-inline-process-yaml-ipc`).

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { matchingRelativePaths } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');
const HELPER = 'webview-ui/src/lib/workflow-run-ipc.ts';

const COMMANDS = ['CMD_LAUNCH_WORKFLOW', 'CMD_CONTINUE_WORKFLOW'] as const;

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // The shared helper — the only file that may name either command at all.
  HELPER
  // `webview-ui/src/lib/messages.ts` is deliberately absent: it is a bare
  // `export *` shim, so it never contains the literal and can never match.
]);



const matchRel = (pattern: string): readonly string[] =>
  matchingRelativePaths(REPO_ROOT, SCAN_ROOT, pattern, { fixed: true });

describe('Feature 088 T042 — no inline connected-run command references', () => {
  for (const command of COMMANDS) {
    it(`only the shared helper references ${command}`, () => {
      const matched = matchRel(command);
      const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
      expect(
        offenders,
        `Offending files referencing ${command}:\n${offenders.join('\n')}`
      ).toEqual([]);
    });

    it(`the shared helper is found by the scan for ${command}`, () => {
      // The positive control: an empty result must mean "nothing else references
      // it", never "the scan did not run".
      expect(matchRel(command)).toContain(HELPER);
    });

    it(`no component invokes postCommand(${command}, ...) inline`, () => {
      const matched = matchRel(`postCommand(${command}`);
      const componentOffenders = matched.filter((rel) =>
        rel.startsWith('webview-ui/src/components/')
      );
      expect(componentOffenders).toEqual([]);
    });
  }

  it('the connected-run components reach the host only through the helper', () => {
    // The surface is three components deep; this pins that none of them grew its
    // own transport, whatever it might name the command.
    const posted = matchRel('postCommand(').filter((rel) =>
      rel.startsWith('webview-ui/src/components/WorkflowRun/')
    );
    expect(posted).toEqual([]);
  });
});
