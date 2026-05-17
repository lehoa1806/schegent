import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const PHASE_CONTROL_CONSTANTS = [
  'CMD_PAUSE_PHASE',
  'CMD_RESUME_PHASE',
  'CMD_RESTART_PHASE'
] as const;

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  'webview-ui/src/lib/messages.ts',
  'webview-ui/src/lib/phase-control.ts',
  'webview-ui/src/components/__tests__/PhaseControlMenu.test.ts'
]);

function listMatchingFiles(pattern: string): readonly string[] {
  let out: string;
  try {
    out = execSync(`grep -rln "${pattern}" "${SCAN_ROOT}"`, { encoding: 'utf8' });
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
