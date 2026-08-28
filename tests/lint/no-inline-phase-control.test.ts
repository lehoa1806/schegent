import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { matchingRelativePaths } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const PHASE_CONTROL_CONSTANTS = [
  'CMD_PAUSE_PHASE',
  'CMD_RESUME_PHASE',
  'CMD_RESTART_PHASE'
  // Feature 093 (T080) considered adding CMD_RETRY_PHASE_NOW here and did not:
  // it is a destructive command, and `destructive-actions.lint.test.ts` requires
  // its dispatch to share a scope with the `useConfirm` that gates it. Routing
  // it through the shared helper would put the two in different modules and
  // defeat that gate, which is the stronger of the two invariants. That reason
  // is unchanged; the example given for it is gone. `PhaseTracker.svelte` was
  // named here as the dispatcher that takes the queue as a required prop, and
  // FR-R3-140 deleted it as unreachable from either bundle entry point. The
  // webview dispatches this command from nowhere now, so the constant's absence
  // from the list above is currently moot — it earns its place back the moment
  // a reachable component sends it.
] as const;

/**
 * The shared helper this gate exists to funnel every constant through. It
 * references all of them by definition, so the scan must find it — that is what
 * makes it a usable anchor.
 */
const HELPER_MODULE = 'webview-ui/src/lib/phase-control.ts';

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  'webview-ui/src/lib/messages.ts',
  'webview-ui/src/lib/phase-control.ts',
  'webview-ui/src/components/__tests__/PhaseControlMenu.test.ts'
]);


const matchRel = (pattern: string): readonly string[] =>
  matchingRelativePaths(REPO_ROOT, SCAN_ROOT, pattern, { fixed: true });

describe('Feature 017 — no inline phase-control command dispatch', () => {
  for (const constant of PHASE_CONTROL_CONSTANTS) {
    it(`${constant} is referenced only by the shared helper and tests`, () => {
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
      expect(offenders, `Offending files referencing ${constant}:\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});
