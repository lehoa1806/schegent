// Feature 030 (US3, T038) — grep regression: NO source file under `src/`
// or `webview-ui/` may reference the seven multi-queue command constants
// removed by the single-queue migration. The legacy command literals are
// permitted to appear ONLY in:
//
//   - the v5 → v6 migrator (read-only legacy compat) and its unit test
//   - documentation/comments in the sidebar IPC contract module
//     (`src/contracts/sidebar-ipc.ts`) and its runtime validators
//     (`src/contracts/runtime-validators.ts`) where the removal is
//     documented in code comments
//   - this lint regression itself (which mentions the constants in its
//     test body)
//
// The discipline mirrors the other "no inline …" lint guards under
// `tests/lint/`. The check uses `grep -rln` so any new offending file
// surfaces with a precise path.

import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOTS = [
  resolve(REPO_ROOT, 'src'),
  resolve(REPO_ROOT, 'webview-ui', 'src')
];

const REMOVED_COMMANDS = [
  'CMD_CREATE_QUEUE',
  'CMD_RENAME_QUEUE',
  'CMD_DELETE_QUEUE',
  'CMD_SAVE_QUEUE_SETTINGS',
  'CMD_SET_QUEUE_SCHEDULE',
  'CMD_CLEAR_QUEUE_SCHEDULE',
  'CMD_MOVE_TASK'
] as const;

// Allowlist pinned in the test, per the Phase 5 task description (T038).
// The migrator module + its unit test are read-only legacy adapters for
// pre-v6 state — they may continue to mention the literal command names
// in comments / migration prose. The contracts modules retain historical
// comments documenting the removal (no executable references).
const ALLOWED_FILES: ReadonlySet<string> = new Set([
  'src/state/queue-state-migrator.ts',
  'tests/unit/state/queue-state-migrator-v5-to-v6.test.ts',
  'src/contracts/sidebar-ipc.ts',
  'src/contracts/runtime-validators.ts'
]);

function listMatchingFiles(pattern: string): readonly string[] {
  const matches = new Set<string>();
  for (const root of SCAN_ROOTS) {
    let out: string;
    try {
      out = execSync(`grep -rln "${pattern}" "${root}"`, { encoding: 'utf8' });
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string };
      if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) continue;
      throw err;
    }
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const rel = trimmed.startsWith(REPO_ROOT + '/')
        ? trimmed.slice(REPO_ROOT.length + 1)
        : trimmed;
      matches.add(rel);
    }
  }
  return [...matches];
}

describe('Feature 030 (US3, T038) — no multi-queue command references in src/ or webview-ui/', () => {
  for (const constant of REMOVED_COMMANDS) {
    it(`${constant} is not referenced outside the allowlisted migrator + contracts documentation`, () => {
      const matched = listMatchingFiles(constant);
      const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
      expect(
        offenders,
        `Offending files referencing ${constant}:\n${offenders.join('\n')}`
      ).toEqual([]);
    });
  }
});
