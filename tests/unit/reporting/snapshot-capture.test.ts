// FR-R6-F11 T012 — the run snapshot capture (research R1, R12).
//
// WHAT THIS PINS:
//   - roots are selected by `created_at_ms` in `[start, min(end, cutoff))`, in one workspace;
//   - each filter narrows the roots, and the attempts follow their roots;
//   - `terminal_reason` maps to a failure cause, and free text is never kept;
//   - more than `cap` roots or attempts gives `snapshot-rows`;
//   - the read is one transaction, rolled back on a failure, and writes nothing.

import { describe, expect, it } from 'vitest';
import type { ReportFilters } from '../../../src/contracts/reporting/report-query';
import {
  captureRunSnapshot,
  type CaptureConnection,
  type CaptureRequest,
  type CapturedRuns
} from '../../../src/services/reporting/snapshot-capture';
import type { NodeSqliteConnection } from '../../../src/services/sqlite-store';
import { FIXTURE_WORKSPACE, seedAttempt, seedRun, withStore } from './report-fixture';

const CAP = 100;

function request(overrides: Partial<CaptureRequest> = {}): CaptureRequest {
  return {
    workspaceId: FIXTURE_WORKSPACE,
    range: { startMs: 1_000, endMs: 5_000 },
    cutoffMs: 10_000,
    filters: {},
    cap: CAP,
    ...overrides
  };
}

function captured(conn: CaptureConnection, req: CaptureRequest): CapturedRuns {
  const result = captureRunSnapshot(conn, req);
  if (!result.ok) {
    throw new Error(`expected a capture, got ${result.outcome}`);
  }
  return result.value;
}

function rootIds(conn: CaptureConnection, req: CaptureRequest): readonly string[] {
  return captured(conn, req).roots.map((root) => root.rootId);
}

function seedFilterFixture(conn: NodeSqliteConnection): void {
  seedRun(conn, { runId: 'r1', createdAtMs: 1_100, workflowId: 'wf-a', frozenClosureId: 'fz-1', status: 'failed' });
  seedRun(conn, { runId: 'r2', createdAtMs: 1_200, workflowId: 'wf-b', frozenClosureId: 'fz-2', status: 'succeeded' });
  seedRun(conn, { runId: 'r3', createdAtMs: 1_300, workflowId: 'wf-a', frozenClosureId: 'fz-2', status: 'succeeded' });
  seedAttempt(conn, { attemptId: 'a1', runId: 'r1', stepIndex: 0, attemptNumber: 1, startedAtMs: 1_110 });
  seedAttempt(conn, { attemptId: 'a2', runId: 'r2', stepIndex: 0, attemptNumber: 1, startedAtMs: 1_210 });
  seedAttempt(conn, { attemptId: 'a3', runId: 'r3', stepIndex: 0, attemptNumber: 1, startedAtMs: 1_310 });
}

function recording(conn: NodeSqliteConnection, failOn?: string): { conn: CaptureConnection; execs: string[] } {
  const execs: string[] = [];
  const wrapped: CaptureConnection = {
    exec: (sql) => {
      execs.push(sql);
      conn.exec(sql);
    },
    all: <T>(sql: string, ...params: (string | number)[]): T[] => {
      if (failOn !== undefined && sql.includes(failOn)) {
        throw new Error('simulated read failure');
      }
      return conn.all<T>(sql, ...params);
    }
  };
  return { conn: wrapped, execs };
}

describe('FR-R6-F11 T012 — run snapshot capture', () => {
  it('selects roots created in [start, min(end, cutoff)) in its own workspace, oldest first', () => {
    withStore((conn) => {
      seedRun(conn, { runId: 'before', createdAtMs: 999 });
      seedRun(conn, { runId: 'at-start', createdAtMs: 1_000 });
      seedRun(conn, { runId: 'mid', createdAtMs: 2_999 });
      seedRun(conn, { runId: 'at-cutoff', createdAtMs: 3_000 });
      seedRun(conn, { runId: 'late', createdAtMs: 4_000 });
      seedRun(conn, { runId: 'other-ws', createdAtMs: 1_500, workspaceId: 'ws-2' });
      expect(rootIds(conn, request({ cutoffMs: 3_000 }))).toEqual(['at-start', 'mid']);
      expect(rootIds(conn, request({ range: { startMs: 1_000, endMs: 3_000 } }))).toEqual(['at-start', 'mid']);
      expect(rootIds(conn, request())).toEqual(['at-start', 'mid', 'at-cutoff', 'late']);
    });
  });

  it('breaks a created-time tie by root identity', () => {
    withStore((conn) => {
      seedRun(conn, { runId: 'r-b', createdAtMs: 2_000 });
      seedRun(conn, { runId: 'r-a', createdAtMs: 2_000 });
      expect(rootIds(conn, request())).toEqual(['r-a', 'r-b']);
    });
  });

  it.each<[string, ReportFilters, readonly string[]]>([
    ['workflowId', { workflowId: ['wf-a'] }, ['r1', 'r3']],
    ['frozenDefinitionId', { frozenDefinitionId: ['fz-2'] }, ['r2', 'r3']],
    ['outcome', { outcome: ['failed'] }, ['r1']],
    ['rootId', { rootId: ['r2', 'r3'] }, ['r2', 'r3']],
    ['two filters together', { workflowId: ['wf-a'], frozenDefinitionId: ['fz-2'] }, ['r3']],
    ['several values of one filter', { workflowId: ['wf-a', 'wf-b'] }, ['r1', 'r2', 'r3']]
  ])('narrows roots and their attempts by %s', (_name, filters, expected) => {
    withStore((conn) => {
      seedFilterFixture(conn);
      const result = captured(conn, request({ filters }));
      expect(result.roots.map((root) => root.rootId)).toEqual([...expected]);
      expect([...new Set(result.attempts.map((attempt) => attempt.rootId))]).toEqual([...expected]);
    });
  });

  it('copies the root and attempt fields, with attempts in root, step and attempt order', () => {
    withStore((conn) => {
      seedRun(conn, {
        runId: 'r1',
        createdAtMs: 1_100,
        workflowId: 'wf-a',
        frozenClosureId: 'fz-1',
        status: 'failed',
        startedAtMs: 1_150,
        completedAtMs: 1_900,
        terminalReason: 'phase_timeout'
      });
      seedAttempt(conn, { attemptId: 'a-s1', runId: 'r1', stepIndex: 1, attemptNumber: 1, startedAtMs: 1_500, phaseId: 'plan' });
      seedAttempt(conn, {
        attemptId: 'a-s0-2',
        runId: 'r1',
        stepIndex: 0,
        attemptNumber: 2,
        startedAtMs: 1_300,
        status: 'failed',
        exitCode: 3,
        completedAtMs: 1_400
      });
      seedAttempt(conn, { attemptId: 'a-s0-1', runId: 'r1', stepIndex: 0, attemptNumber: 1, startedAtMs: 1_200, phaseId: 'phase-0' });
      const result = captured(conn, request());
      expect(result.roots).toEqual([
        {
          rootId: 'r1',
          workflowId: 'wf-a',
          frozenDefinitionId: 'fz-1',
          status: 'failed',
          startedAtMs: 1_150,
          completedAtMs: 1_900,
          createdAtMs: 1_100,
          failureCause: 'phase_timeout'
        }
      ]);
      expect(result.attempts.map((attempt) => attempt.attemptId)).toEqual(['a-s0-1', 'a-s0-2', 'a-s1']);
      expect(result.attempts.at(1)).toEqual({
        attemptId: 'a-s0-2',
        rootId: 'r1',
        stepIndex: 0,
        phaseId: 'phase-0',
        attemptNumber: 2,
        status: 'failed',
        exitCode: 3,
        startedAtMs: 1_300,
        completedAtMs: 1_400
      });
      expect(result.attempts.at(2)?.phaseId).toBe('plan');
      expect(Object.isFrozen(result.roots)).toBe(true);
      expect(Object.isFrozen(result.attempts.at(0))).toBe(true);
    });
  });

  it('maps a recorded cause to itself, null to not-recorded and free text to other, keeping no text', () => {
    withStore((conn) => {
      const freeText = 'disk full at /Users/someone/secret-project';
      seedRun(conn, { runId: 'known', createdAtMs: 1_100, status: 'failed', terminalReason: 'cap_exhausted' });
      seedRun(conn, { runId: 'unset', createdAtMs: 1_200, status: 'aborted', terminalReason: null });
      seedRun(conn, { runId: 'free', createdAtMs: 1_300, status: 'cancelled', terminalReason: freeText });
      const result = captured(conn, request());
      expect(result.roots.map((root) => root.failureCause)).toEqual(['cap_exhausted', 'not-recorded', 'other']);
      expect(JSON.stringify(result)).not.toContain('secret-project');
    });
  });

  it('gives snapshot-rows when roots or attempts exceed the cap, and captures at the cap', () => {
    withStore((conn) => {
      seedRun(conn, { runId: 'r1', createdAtMs: 1_100 });
      seedRun(conn, { runId: 'r2', createdAtMs: 1_200 });
      seedRun(conn, { runId: 'r3', createdAtMs: 1_300 });
      expect(captureRunSnapshot(conn, request({ cap: 2 }))).toEqual({
        ok: false,
        outcome: 'limited',
        limit: 'snapshot-rows'
      });
      expect(captured(conn, request({ cap: 3 })).roots).toHaveLength(3);
      for (const attemptNumber of [1, 2, 3, 4]) {
        seedAttempt(conn, { attemptId: `a${String(attemptNumber)}`, runId: 'r1', stepIndex: 0, attemptNumber, startedAtMs: 1_100 });
      }
      expect(captureRunSnapshot(conn, request({ cap: 3 }))).toEqual({
        ok: false,
        outcome: 'limited',
        limit: 'snapshot-rows'
      });
      expect(captured(conn, request({ cap: 4 })).attempts).toHaveLength(4);
    });
  });

  it('reads in one transaction and writes nothing', () => {
    withStore((conn) => {
      seedFilterFixture(conn);
      const before = conn.scalar<number>('SELECT total_changes()');
      const probe = recording(conn);
      captured(probe.conn, request());
      expect(probe.execs).toEqual(['BEGIN', 'COMMIT']);
      expect(conn.scalar<number>('SELECT total_changes()')).toBe(before);
    });
  });

  it('rolls the transaction back and rethrows when a read fails', () => {
    withStore((conn) => {
      seedFilterFixture(conn);
      const probe = recording(conn, 'JOIN attempts');
      expect(() => captureRunSnapshot(probe.conn, request())).toThrow('simulated read failure');
      expect(probe.execs).toEqual(['BEGIN', 'ROLLBACK']);
      expect(conn.scalar<number>('SELECT 1')).toBe(1);
    });
  });
});
