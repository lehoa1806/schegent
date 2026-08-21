// Feature 064 — T017 (US3) — Clean All disk-integrity regression.
//
// Pins the invariant from spec §SC-005 and the hard rule in CLAUDE.md
// ("Never implement task or phase deletion by erasing
// .schegent/audit.log"): the Clean All workflow must NOT truncate, rewrite,
// or erase any pre-existing bytes of `.schegent/audit.log`. It is permitted
// to APPEND exactly one new `queue-cleared-all` JSONL line.
//
// The test:
//   1. Seeds `.schegent/audit.log` via AuditLogWriter.append() with three
//      known events (mixed eventTypes) so the log has a non-trivial
//      pre-existing body.
//   2. Records the byte length L and SHA-256 H of the log file at rest.
//   3. Invokes `runClearAll` with a fake `QueueManager.clearAll()` that
//      reports a non-no-op `CleanAllResult` (so the orchestrator emits the
//      single `queue-cleared-all` audit append).
//   4. Re-reads the file and asserts:
//        a. SHA-256 of the FIRST L bytes equals H (prefix unchanged).
//        b. The remainder parses as EXACTLY one JSONL record with
//           `eventType === 'queue-cleared-all'`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import { runClearAll, type ClearAllCtx } from '../../src/commands/clear-all';
import type { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import type { QueueManager, CleanAllResult } from '../../src/queue/queue-manager';
import type { WorkspaceStateStore } from '../../src/state/workspace-state';
import type { WorkspaceLockManager } from '../../src/state/lock';
import type { Notifier } from '../../src/ui/notifications';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('Clean All preserves on-disk .schegent/audit.log (Feature 064 T017 / SC-005)', () => {
  let tmpRoot: string;
  let audit: AuditLogWriter;
  let logger: SanitizedLogger;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-clean-all-disk-'));
    logger = new SanitizedLogger();
    audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('preserves every pre-existing byte and appends exactly one queue-cleared-all line', async () => {
    // 1. Seed the audit log with three known entries.
    await audit.append({
      runId: 'run-seed-1',
      phase: 'speckit-plan',
      iteration: 0,
      eventType: 'phase-start',
      payload: { summary: 'starting plan' },
      outcome: 'info'
    });
    await audit.append({
      runId: 'run-seed-1',
      phase: 'speckit-plan',
      iteration: 0,
      eventType: 'cli-invocation',
      payload: { command: 'claude --plan' },
      outcome: 'info'
    });
    await audit.append({
      runId: 'run-seed-1',
      phase: 'speckit-plan',
      iteration: 0,
      eventType: 'phase-end',
      payload: { summary: 'plan complete' },
      outcome: 'info'
    });

    const logPath = audit.logPath;
    expect(logPath).toBe(path.join(tmpRoot, '.schegent', 'audit.log'));

    // 2. Snapshot the seeded prefix.
    const prefix = await fs.readFile(logPath);
    const L = prefix.length;
    const H = sha256(prefix);
    expect(L).toBeGreaterThan(0);

    // Sanity: the seed wrote three newline-terminated JSONL records.
    expect(prefix.toString('utf8').split('\n').filter(Boolean).length).toBe(3);

    // 3. Build a ClearAllCtx whose QueueManager reports a non-no-op result
    // (so runClearAll emits the canonical queue-cleared-all audit append).
    const activeResult: CleanAllResult = {
      removed: { pending: 2, completed: 1, failed: 0, canceled: 0 },
      inflightAborted: false,
      runnerAcked: false,
      pauseCleared: true,
      pauseSource: 'operator',
      activeRunCleared: false,
      watchdogCleared: false,
      wasNoop: false
    };
    const ctx: ClearAllCtx = {
      controller: {
        get running() {
          return false;
        },
        cancelActive: vi.fn()
      } as unknown as SchegentWorkflowController,
      store: {} as unknown as WorkspaceStateStore,
      queue: {
        clearAll: vi.fn(async () => activeResult)
      } as unknown as QueueManager,
      audit,
      lock: {
        hasPrimacy: vi.fn(async () => true),
        release: vi.fn(async () => undefined)
      } as unknown as WorkspaceLockManager,
      notifier: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as unknown as Notifier,
      logger
    };

    const outcome = await runClearAll(ctx);
    expect(outcome).toEqual({ ok: true });

    // 4. Re-read the log and assert the prefix is byte-identical.
    const after = await fs.readFile(logPath);
    expect(after.length).toBeGreaterThanOrEqual(L);
    const afterPrefix = after.subarray(0, L);
    expect(sha256(afterPrefix)).toBe(H);

    // 5. The suffix is exactly one valid `queue-cleared-all` JSONL line.
    const suffix = after.subarray(L).toString('utf8');
    const suffixLines = suffix.split('\n').filter((l) => l.length > 0);
    expect(suffixLines).toHaveLength(1);
    const parsed = JSON.parse(suffixLines[0]) as Record<string, unknown>;
    expect(parsed.eventType).toBe('queue-cleared-all');
    expect(parsed.runId).toBe('queue:default');
    expect(parsed.outcome).toBe('info');
    expect(parsed.payload).toMatchObject({
      removedPending: 2,
      removedInFlight: 0,
      pauseStateCleared: true,
      runnerState: 'no-active-run',
      watchdogBackoffCleared: false
    });
  });

  it("does not touch the log when clearAll returns wasNoop: true", async () => {
    await audit.append({
      runId: 'run-seed-noop',
      phase: 'speckit-plan',
      iteration: 0,
      eventType: 'phase-start',
      payload: { summary: 'starting' },
      outcome: 'info'
    });
    const logPath = audit.logPath;
    const before = await fs.readFile(logPath);
    const H = sha256(before);

    const noopResult: CleanAllResult = {
      removed: { pending: 0, completed: 0, failed: 0, canceled: 0 },
      inflightAborted: false,
      runnerAcked: false,
      pauseCleared: false,
      pauseSource: null,
      activeRunCleared: false,
      watchdogCleared: false,
      wasNoop: true
    };
    const ctx: ClearAllCtx = {
      controller: {
        get running() {
          return false;
        },
        cancelActive: vi.fn()
      } as unknown as SchegentWorkflowController,
      store: {} as unknown as WorkspaceStateStore,
      queue: {
        clearAll: vi.fn(async () => noopResult)
      } as unknown as QueueManager,
      audit,
      lock: {
        hasPrimacy: vi.fn(async () => true),
        release: vi.fn(async () => undefined)
      } as unknown as WorkspaceLockManager,
      notifier: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as unknown as Notifier,
      logger
    };
    const outcome = await runClearAll(ctx);
    expect(outcome).toEqual({ ok: true });

    const after = await fs.readFile(logPath);
    expect(after.length).toBe(before.length);
    expect(sha256(after)).toBe(H);
  });
});
