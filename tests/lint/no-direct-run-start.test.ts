// Feature 013 T033 — repo-grep regression enforcing FR-006/FR-007/FR-008.
//
// `GuardedRunService` is the SINGLE guarded entry point for run-starting
// and queue-mutating run-start paths. Direct calls to `queue.enqueue(`
// and `controller.startNew(` from command handlers or webview IPC
// handlers are forbidden — they bypass the validation/audit/lock
// boundary the service provides.
//
// This test scans `src/**/*.ts` for both patterns and fails if any file
// outside the allowlist matches. The allowlist is intentionally narrow:
// only the service itself, the queue/controller implementations that
// own those methods, and the queue-ops helpers that the service
// composes with.

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'src');

// Files allowed to reference `queue.enqueue(` or `controller.startNew(`.
// These are implementation files (the methods are defined here or are
// composed by the guarded service) — not command handlers.
const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // The single guarded entry point.
  'src/services/guarded-run-service.ts',
  // QueueManager defines `enqueue` itself.
  'src/queue/queue-manager.ts',
  // Queue ops helpers (clearCompleted/clearFailed/pause/resume/retry) — they
  // don't start a new run; they manipulate existing queue items.
  'src/commands/queue-ops.ts',
  // The controller defines `startNew` itself; the workflow-controller is
  // allowed to call `queue.enqueue` only as part of its own internal
  // bookkeeping (auto-drain, etc). Audit any call here carefully.
  'src/controller/workflow-controller.ts',
  // Feature 013 Wave 7 (T099): auto-drain orchestration extracted from
  // `WorkflowController`. Calls `this.controller.startNew(next, null)`
  // ONLY as the four-step gate's terminal step. This is system-internal
  // (not a user-initiated call) and the four-step gate (paused, inFlightId,
  // peekNextPending, lock.tryAcquire) provides the same invariants as
  // GuardedRunService for this internal promotion path.
  'src/services/auto-drain-coordinator.ts'
]);

function listMatchingFiles(pattern: string): readonly string[] {
  let out: string;
  try {
    out = execSync(
      `grep -rln --include="*.ts" "${pattern}" "${SCAN_ROOT}"`,
      { encoding: 'utf8' }
    );
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
    .map((abs) => (abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs));
}

describe('Feature 013 T033 — no direct queue.enqueue / controller.startNew', () => {
  it('only the allowlisted files reference queue.enqueue(', () => {
    const matched = listMatchingFiles('queue\\.enqueue(');
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Files calling queue.enqueue(...) outside the allowlist must go through GuardedRunService.\nOffenders:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('only the allowlisted files reference controller.startNew(', () => {
    const matched = listMatchingFiles('controller\\.startNew(');
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Files calling controller.startNew(...) outside the allowlist must go through GuardedRunService.\nOffenders:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('GuardedRunService is one of the matched files (sanity)', () => {
    const enqueueMatches = listMatchingFiles('queue\\.enqueue(');
    expect(enqueueMatches).toContain('src/services/guarded-run-service.ts');
  });
});
