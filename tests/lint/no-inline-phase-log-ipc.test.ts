// Feature 020 T010 — grep regression: webview components must NOT
// import `CMD_READ_PHASE_LOG`, `CMD_START_PHASE_LOG_TAIL`,
// `CMD_STOP_PHASE_LOG_TAIL`, or `MSG_PHASE_LOG_ENTRY` directly. The
// SINGLE call site for these constants in webview code is the helper
// at `webview-ui/src/lib/phase-log-ipc.ts`.
//
// This mirrors the discipline already enforced for save-general,
// save-queue, save-wakeup, and phase-control commands.

import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const PHASE_LOG_IPC_CONSTANTS = [
  'CMD_READ_PHASE_LOG',
  'CMD_START_PHASE_LOG_TAIL',
  'CMD_STOP_PHASE_LOG_TAIL',
  'MSG_PHASE_LOG_ENTRY'
] as const;

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  'webview-ui/src/lib/messages.ts',
  'webview-ui/src/lib/phase-log-ipc.ts',
  'webview-ui/src/lib/__tests__/phase-log-ipc.test.ts',
  'webview-ui/src/lib/phase-log-store.svelte.ts'
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

describe('Feature 020 T010 — no inline phase-log IPC imports in webview', () => {
  for (const constant of PHASE_LOG_IPC_CONSTANTS) {
    it(`${constant} is referenced only by the shared helper and the messages shim`, () => {
      const matched = listMatchingFiles(constant);
      const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
      expect(
        offenders,
        `Offending files referencing ${constant}:\n${offenders.join('\n')}`
      ).toEqual([]);
    });
  }
});
