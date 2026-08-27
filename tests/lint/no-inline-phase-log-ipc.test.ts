// Feature 020 T010 — grep regression: webview components must NOT
// import `CMD_READ_PHASE_LOG`, `CMD_START_PHASE_LOG_TAIL`,
// `CMD_STOP_PHASE_LOG_TAIL`, or `MSG_PHASE_LOG_ENTRY` directly. The
// SINGLE call site for these constants in webview code is the helper
// at `webview-ui/src/lib/phase-log-ipc.ts`.
//
// This mirrors the discipline already enforced for save-general,
// save-queue and phase-control commands.

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { matchingRelativePaths } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const PHASE_LOG_IPC_CONSTANTS = [
  'CMD_READ_PHASE_LOG',
  'CMD_START_PHASE_LOG_TAIL',
  'CMD_STOP_PHASE_LOG_TAIL',
  'MSG_PHASE_LOG_ENTRY'
] as const;

/**
 * The shared helper this gate exists to funnel every constant through. It
 * references all of them by definition, so the scan must find it — that is what
 * makes it a usable anchor.
 */
const HELPER_MODULE = 'webview-ui/src/lib/phase-log-ipc.ts';

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  'webview-ui/src/lib/messages.ts',
  'webview-ui/src/lib/phase-log-ipc.ts',
  'webview-ui/src/lib/phase-log-store.svelte.ts'
]);


const matchRel = (pattern: string): readonly string[] =>
  matchingRelativePaths(REPO_ROOT, SCAN_ROOT, pattern, { fixed: true });

describe('Feature 020 T010 — no inline phase-log IPC imports in webview', () => {
  for (const constant of PHASE_LOG_IPC_CONSTANTS) {
    it(`${constant} is referenced only by the shared helper and the messages shim`, () => {
      const matched = matchRel(constant);
      // Vacuity control, asserted BEFORE the offender filter. A renamed or
      // deleted constant matches nothing, therefore offends nothing, and the
      // assertion below passes while proving the opposite of what it claims.
      // The shared helper references every one of these, so it must match.
      expect(
        matched,
        `${constant} was not found in ${HELPER_MODULE}. Either the constant was ` +
          `renamed — in which case this list is stale — or the scan is broken, ` +
          `and the offender check below is passing over an empty set.`
      ).toContain(HELPER_MODULE);

      const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
      expect(
        offenders,
        `Offending files referencing ${constant}:\n${offenders.join('\n')}`
      ).toEqual([]);
    });
  }
});
