/**
 * FR-R6-F06 (T046, FR-012, US4 scenarios 1-2) — a root counts once. A failed attempt followed
 * by a successful one is one root and two attempts; the first attempt's usage stays counted;
 * each terminal transition appends a row under a new `outcome` revision, so the history is kept
 * in `transition_seq` order and the current outcome is the latest row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import type { AccountingObservationInput } from '../../../src/services/usage-accounting/observation-normalizer';
import {
  type UsageAccountingService,
  createUsageAccountingService
} from '../../../src/services/usage-accounting/usage-accounting-service';
import { createUsageAccountingWiring } from '../../../src/services/usage-accounting/usage-accounting-wiring';

const NOW = '2026-11-10T12:00:00.000Z';
const QUERY = { groupBy: [], from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' };
const ROOT = 'run-resumed-1';
const FIRST_ATTEMPT = '3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01';
const SECOND_ATTEMPT = '3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c02';
const FAILED_AT = '2026-11-10T10:10:00.000Z';
const SUCCEEDED_AT = '2026-11-10T11:10:00.000Z';

let conn: NodeSqliteConnection;

beforeEach(() => {
  conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
});

afterEach(() => {
  if (conn.db.isOpen) conn.close();
});

function service(): UsageAccountingService {
  return createUsageAccountingService({ conn, nowUtc: () => NOW, monotonicMs: () => 1, workspaceId: 'ws-1' });
}

function attemptUsage(attemptId: string, inputTokens: number, eventUtc: string): AccountingObservationInput {
  return {
    producerNamespace: 'schegent.phase-end/1',
    source: 'phase-end',
    sourceKind: 'phase-end',
    sourceIdentity: `${ROOT}:${attemptId}:phase-a:0`,
    rootId: ROOT,
    attemptId,
    invocationOrdinal: 0,
    counterScope: 'invocation-delta',
    adapterVersion: 'claude/1',
    dimensions: { backend: 'claude', phaseId: 'phase-a' },
    eventUtc,
    observedUtc: eventUtc,
    measures: [{ measure: 'input_tokens', quantity: inputTokens, unit: 'count', provenance: 'provider-reported' }]
  };
}

function transitions(rootId = ROOT) {
  return conn
    .all<{ transition_seq: number; outcome: string; terminal_utc: string; revision: number }>(
      'SELECT transition_seq, outcome, terminal_utc, revision FROM accounting_root_outcomes WHERE root_id = ? ORDER BY transition_seq',
      rootId
    )
    .map((row) => ({ ...row, transition_seq: Number(row.transition_seq), revision: Number(row.revision) }));
}

function resumedRoot(accounting: UsageAccountingService) {
  accounting.ingestObservation(attemptUsage(FIRST_ATTEMPT, 120, '2026-11-10T10:00:00.000Z'));
  accounting.recordAttemptOutcome({ attemptId: FIRST_ATTEMPT, outcome: 'failed' });
  const failed = accounting.recordRootOutcome({ rootId: ROOT, outcome: 'failed', terminalUtc: FAILED_AT });
  accounting.ingestObservation(attemptUsage(SECOND_ATTEMPT, 80, '2026-11-10T11:00:00.000Z'));
  accounting.recordAttemptOutcome({ attemptId: SECOND_ATTEMPT, outcome: 'succeeded' });
  const succeeded = accounting.recordRootOutcome({ rootId: ROOT, outcome: 'succeeded', terminalUtc: SUCCEEDED_AT });
  return { failed, succeeded };
}

describe('recordRootOutcome (T046)', () => {
  it('counts a failed-then-resumed root once, with two attempts, current outcome succeeded', () => {
    const accounting = service();
    const { failed, succeeded } = resumedRoot(accounting);
    expect(failed).toStrictEqual({ ok: true, value: { transitionSeq: 1, revision: expect.any(Number) } });
    expect(succeeded).toStrictEqual({ ok: true, value: { transitionSeq: 2, revision: expect.any(Number) } });
    if (!failed.ok || !succeeded.ok) throw new Error('unreachable');
    expect(succeeded.value.revision).toBeGreaterThan(failed.value.revision);
    expect(transitions().at(-1)?.outcome).toBe('succeeded');

    const answer = accounting.query(QUERY);
    if (!answer.ok) throw new Error(answer.refusal.code);
    expect(answer.value.revision).toBe(succeeded.value.revision);
    expect(answer.value.rows).toHaveLength(1);
    expect(answer.value.rows.at(0)).toMatchObject({ roots: 1, attempts: 2 });
  });

  it("keeps the first attempt's usage in the root's totals", () => {
    const accounting = service();
    resumedRoot(accounting);
    const answer = accounting.query(QUERY);
    if (!answer.ok) throw new Error(answer.refusal.code);
    expect(answer.value.rows.at(0)?.measures.find((item) => item.measure === 'input_tokens')?.total).toBe('200');
  });

  it('keeps the transition history in transition_seq order, one outcome revision each', () => {
    const accounting = service();
    const { failed, succeeded } = resumedRoot(accounting);
    if (!failed.ok || !succeeded.ok) throw new Error('unreachable');
    expect(transitions()).toStrictEqual([
      { transition_seq: 1, outcome: 'failed', terminal_utc: FAILED_AT, revision: failed.value.revision },
      { transition_seq: 2, outcome: 'succeeded', terminal_utc: SUCCEEDED_AT, revision: succeeded.value.revision }
    ]);
    const causes = conn.all<{ cause: string }>(
      'SELECT cause FROM accounting_revisions WHERE revision IN (?, ?)',
      failed.value.revision,
      succeeded.value.revision
    );
    expect(causes.map((row) => row.cause)).toStrictEqual(['outcome', 'outcome']);
  });

  it('answers a redelivered terminal transition with the recorded row and writes nothing', () => {
    const accounting = service();
    const first = accounting.recordRootOutcome({ rootId: ROOT, outcome: 'failed', terminalUtc: FAILED_AT });
    const revisions = Number(conn.scalar('SELECT count(*) FROM accounting_revisions') ?? 0);
    expect(accounting.recordRootOutcome({ rootId: ROOT, outcome: 'failed', terminalUtc: FAILED_AT })).toStrictEqual(first);
    expect(transitions()).toHaveLength(1);
    expect(Number(conn.scalar('SELECT count(*) FROM accounting_revisions') ?? 0)).toBe(revisions);
  });

  it('answers a late redelivery of an earlier transition with its row and keeps the current outcome (review R2)', () => {
    const accounting = service();
    const { failed, succeeded } = resumedRoot(accounting);
    const revisions = Number(conn.scalar('SELECT count(*) FROM accounting_revisions') ?? 0);
    expect(accounting.recordRootOutcome({ rootId: ROOT, outcome: 'failed', terminalUtc: FAILED_AT })).toStrictEqual(failed);
    expect(transitions().map((row) => row.outcome)).toStrictEqual(['failed', 'succeeded']);
    expect(Number(conn.scalar('SELECT count(*) FROM accounting_revisions') ?? 0)).toBe(revisions);
    if (!succeeded.ok) throw new Error('unreachable');
    expect(transitions().at(-1)?.revision).toBe(succeeded.value.revision);
  });

  it('does not move the ingest cutoff', () => {
    const accounting = service();
    accounting.ingestObservation(attemptUsage(FIRST_ATTEMPT, 120, '2026-11-10T10:00:00.000Z'));
    const before = accounting.query(QUERY);
    accounting.recordRootOutcome({ rootId: ROOT, outcome: 'failed', terminalUtc: FAILED_AT });
    const after = accounting.query(QUERY);
    if (!before.ok || !after.ok) throw new Error('query refused');
    expect(after.value.cutoffIngestSeq).toBe(before.value.cutoffIngestSeq);
  });

  it('refuses a malformed request as invalid-observation and records nothing', () => {
    const accounting = service();
    const cases: readonly [unknown, string][] = [
      [null, 'request'],
      [{ rootId: ROOT, outcome: 'failed', terminalUtc: FAILED_AT, extra: 1 }, 'request'],
      [{ rootId: '', outcome: 'failed', terminalUtc: FAILED_AT }, 'rootId'],
      [{ rootId: 'r'.repeat(129), outcome: 'failed', terminalUtc: FAILED_AT }, 'rootId'],
      [{ rootId: ROOT, outcome: 'superseded', terminalUtc: FAILED_AT }, 'outcome'],
      [{ rootId: ROOT, outcome: 'failed', terminalUtc: '2026-11-10 10:10' }, 'terminalUtc'],
      [{ rootId: ROOT, outcome: 'failed', terminalUtc: '2026-11-10T10:10:00+01:00' }, 'terminalUtc']
    ];
    for (const [request, detail] of cases) {
      expect(accounting.recordRootOutcome(request)).toMatchObject({ ok: false, refusal: { code: 'invalid-observation', detail } });
    }
    expect(transitions()).toHaveLength(0);
  });
});

describe('onTerminalRun (T046)', () => {
  function wired(accounting: UsageAccountingService) {
    let drain: (() => void) | undefined;
    const wiring = createUsageAccountingWiring({
      service: accounting,
      auditWriter: { subscribe: () => ({ dispose: () => undefined }) },
      subscriptions: { push: () => undefined },
      logger: { warn: vi.fn() },
      nowUtc: () => NOW,
      schedule: (next) => {
        drain = next;
      }
    });
    return {
      wiring,
      drain: () => {
        drain?.();
        drain = undefined;
      }
    };
  }

  it('records a terminal run as a root transition on the next drain', () => {
    const { wiring, drain } = wired(service());
    wiring.onTerminalRun({ runId: ROOT, status: 'failed', endedAtMs: Date.parse(FAILED_AT) });
    wiring.onTerminalRun({ runId: ROOT, status: 'completed', endedAtMs: Date.parse(SUCCEEDED_AT) });
    expect(transitions()).toHaveLength(0);
    drain();
    expect(transitions().map((row) => [row.outcome, row.terminal_utc])).toStrictEqual([
      ['failed', FAILED_AT],
      ['succeeded', SUCCEEDED_AT]
    ]);
  });

  it('maps canceled to cancelled, stamps a missing end time with the clock, and ignores a paused run', () => {
    const { wiring, drain } = wired(service());
    wiring.onTerminalRun({ runId: 'run-canceled-1', status: 'canceled', endedAtMs: null });
    wiring.onTerminalRun({ runId: 'run-paused-1', status: 'paused', endedAtMs: 1 });
    drain();
    expect(transitions('run-canceled-1').map((row) => [row.outcome, row.terminal_utc])).toStrictEqual([['cancelled', NOW]]);
    expect(transitions('run-paused-1')).toHaveLength(0);
  });
});
