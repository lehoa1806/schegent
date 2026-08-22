// Feature 028 T043 — grep regression: webview components must NOT
// import `CMD_SET_PHASE_BREAKPOINT` or `CMD_CLEAR_PHASE_BREAKPOINT`
// directly. The SINGLE call site for these constants in webview code is
// the helper at `webview-ui/src/lib/phase-breakpoint-ipc.ts`.
//
// This mirrors the discipline already enforced for save-general,
// save-queue, save-phases, phase-control, and phase-log IPC commands.

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { filesMatching } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const PHASE_BREAKPOINT_IPC_CONSTANTS = [
  'CMD_SET_PHASE_BREAKPOINT',
  'CMD_CLEAR_PHASE_BREAKPOINT'
] as const;

/**
 * The shared helper this gate exists to funnel every constant through. It
 * references all of them by definition, so the scan must find it — that is what
 * makes it a usable anchor.
 */
const HELPER_MODULE = 'webview-ui/src/lib/phase-breakpoint-ipc.ts';

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  'webview-ui/src/lib/messages.ts',
  'webview-ui/src/lib/phase-breakpoint-ipc.ts'
]);

function listMatchingFiles(pattern: string): readonly string[] {
  let out: string;
  try {
    out = filesMatching(SCAN_ROOT, pattern, { fixed: true }).join('\n');
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) return [];
    throw err;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((abs) => (abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs));
}

describe('Feature 028 T043 — no inline phase-breakpoint IPC imports in webview', () => {
  for (const constant of PHASE_BREAKPOINT_IPC_CONSTANTS) {
    it(`${constant} is referenced only by the shared helper and the messages shim`, () => {
      const matched = listMatchingFiles(constant);
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
