import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { filesMatching } from './source-scan';

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
  // defeat that gate, which is the stronger of the two invariants. Its queue
  // cannot go missing regardless — `PhaseTracker.svelte` takes it as a required
  // prop and the payload type demands it.
] as const;

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  'webview-ui/src/lib/messages.ts',
  'webview-ui/src/lib/phase-control.ts',
  'webview-ui/src/components/__tests__/PhaseControlMenu.test.ts'
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

describe('Feature 017 — no inline phase-control command dispatch', () => {
  for (const constant of PHASE_CONTROL_CONSTANTS) {
    it(`${constant} is referenced only by the shared helper and tests`, () => {
      const matched = listMatchingFiles(constant);
      const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
      expect(offenders, `Offending files referencing ${constant}:\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});
