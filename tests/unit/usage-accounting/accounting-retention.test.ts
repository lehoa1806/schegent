/**
 * FR-R6-F06 (T044, FR-016, research R10) — retention. Pruning keeps every open contribution's
 * source and every pending intent's observation, removes non-authoritative observations and
 * closed history past the horizon, and compacts the revisions below what it removed. The
 * retained-observation bound prunes first and refuses `store-full` only when nothing can go.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountingBounds } from '../../../src/contracts/usage-accounting/accounting-types';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import type { AccountingObservationInput } from '../../../src/services/usage-accounting/observation-normalizer';
import {
  type UsageAccountingService,
  createUsageAccountingService
} from '../../../src/services/usage-accounting/usage-accounting-service';

const INGEST_NOW = '2026-11-10T12:00:00.000Z';
/** 91 days after INGEST_NOW: every 2026-11-10 event is past the 90-day horizon. */
const LATER_NOW = '2027-02-09T12:00:00.000Z';
const YOUNG_EVENT = '2027-02-09T10:00:00.000Z';
const QUERY = { groupBy: ['backend'], from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' };
const ROOT = 'run-retain-1';
const ATTEMPT = '0b8f4c1e-5d2a-4f7b-9c36-1e2d3f4a5b60';
const SMALL_BOUND = 5;

let conn: NodeSqliteConnection;
let now = INGEST_NOW;
let failApply = false;

beforeEach(() => {
  now = INGEST_NOW;
  failApply = false;
  conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(INGEST_NOW));
});

afterEach(() => {
  if (conn.db.isOpen) conn.close();
});

function serviceWith(bounds: Partial<AccountingBounds> = {}): UsageAccountingService {
  return createUsageAccountingService({
    conn,
    nowUtc: () => now,
    monotonicMs: () => 1,
    workspaceId: 'ws-1',
    bounds,
    projectionFailpoint: () => {
      if (failApply) throw new Error('failpoint');
    }
  });
}

function costObservation(
  identity: string,
  provenance: 'estimated' | 'derived' | 'provider-reported',
  quantity: string,
  overrides: Partial<AccountingObservationInput> = {}
): AccountingObservationInput {
  return {
    producerNamespace: 'schegent.phase-end/1',
    source: 'phase-end',
    sourceKind: 'phase-end',
    sourceIdentity: `${ROOT}:${identity}`,
    rootId: ROOT,
    attemptId: ATTEMPT,
    invocationOrdinal: 0,
    counterScope: 'invocation-delta',
    adapterVersion: 'claude/1',
    dimensions: { backend: 'claude', phaseId: 'phase-a' },
    eventUtc: '2026-11-10T10:00:00.000Z',
    observedUtc: '2026-11-10T10:00:01.000Z',
    measures: [
      provenance === 'estimated'
        ? { measure: 'cost', quantity, unit: 'USD', provenance, pricingVersion: 'pricing-2026-11' }
        : { measure: 'cost', quantity, unit: 'USD', provenance }
    ],
    ...overrides
  };
}

function young(index: number): AccountingObservationInput {
  return costObservation(`young-${index}`, 'provider-reported', '0.10', {
    attemptId: `0b8f4c1e-5d2a-4f7b-9c36-1e2d3f4a5b${String(70 + index)}`,
    eventUtc: YOUNG_EVENT,
    observedUtc: YOUNG_EVENT
  });
}

function ingest(service: UsageAccountingService, input: AccountingObservationInput) {
  const result = service.ingestObservation(input);
  if (!result.ok) throw new Error(`ingest refused: ${result.refusal.code}`);
  return result.value;
}

function count(sql: string): number {
  return Number(conn.scalar(sql) ?? 0);
}

/** An estimate superseded by a reported actual: one non-authoritative observation, one closed row. */
function supersededEstimate(service: UsageAccountingService) {
  const estimate = ingest(service, costObservation('estimate', 'estimated', '0.50'));
  const actual = ingest(service, costObservation('actual', 'provider-reported', '0.20'));
  return { estimate, actual };
}

describe('pruneExpired (T044)', () => {
  it('removes a superseded observation and closed history past the horizon, keeping the open source', () => {
    const service = serviceWith();
    const { estimate, actual } = supersededEstimate(service);
    now = LATER_NOW;

    expect(service.pruneExpired()).toStrictEqual({ ok: true, value: { observationsPruned: 1, historyRowsPruned: 1 } });
    expect(conn.scalar('SELECT count(*) FROM accounting_observations WHERE observation_id = ?', estimate.observationId)).toBe(0);
    expect(conn.scalar('SELECT count(*) FROM accounting_observations WHERE observation_id = ?', actual.observationId)).toBe(1);
    expect(count('SELECT count(*) FROM accounting_contributions WHERE to_revision IS NOT NULL')).toBe(0);
    expect(count('SELECT count(*) FROM accounting_contributions WHERE to_revision IS NULL')).toBe(1);

    const latest = service.query(QUERY);
    expect(latest.ok && latest.value.rows.at(0)?.measures.find((item) => item.measure === 'cost')?.total).toBe('0.200000');
  });

  it('answers revision-compacted for a read below the compaction floor, and keeps the floor readable', () => {
    const service = serviceWith();
    const { estimate, actual } = supersededEstimate(service);
    now = LATER_NOW;
    service.pruneExpired();
    expect(service.query({ ...QUERY, asOfRevision: estimate.revision })).toMatchObject({
      ok: false,
      refusal: { code: 'revision-compacted' }
    });
    const floor = service.query({ ...QUERY, asOfRevision: actual.revision });
    expect(floor.ok && floor.value.revision).toBe(actual.revision);
  });

  it('is idempotent: a second prune removes nothing', () => {
    const service = serviceWith();
    supersededEstimate(service);
    now = LATER_NOW;
    service.pruneExpired();
    expect(service.pruneExpired()).toStrictEqual({ ok: true, value: { observationsPruned: 0, historyRowsPruned: 0 } });
  });

  it('keeps an observation whose projection intent is still pending', () => {
    const service = serviceWith();
    failApply = true;
    const pending = ingest(service, costObservation('pending', 'provider-reported', '0.30'));
    expect(pending.revision).toBeNull();
    failApply = false;
    now = LATER_NOW;
    ingest(service, young(0));
    expect(service.pruneExpired()).toStrictEqual({ ok: true, value: { observationsPruned: 0, historyRowsPruned: 0 } });
    expect(conn.scalar('SELECT count(*) FROM accounting_observations WHERE observation_id = ?', pending.observationId)).toBe(1);
    expect(count("SELECT count(*) FROM accounting_projection_intents WHERE state = 'pending'")).toBe(1);
  });

  it('never prunes the observation holding the highest ingest sequence, while compacting older expired selected observations', () => {
    const service = serviceWith();
    const first = ingest(service, costObservation('actual', 'provider-reported', '0.20'));
    const late = ingest(service, costObservation('estimate', 'estimated', '0.50'));
    now = LATER_NOW;
    // `actual` (ingest_seq 1, expired) is compacted while `late` (ingest_seq 2, highest) stays pinned.
    expect(service.pruneExpired()).toMatchObject({ ok: true, value: { observationsPruned: 1 } });
    expect(conn.scalar('SELECT count(*) FROM accounting_observations WHERE observation_id = ?', first.observationId)).toBe(0);
    expect(conn.scalar('SELECT count(*) FROM accounting_observations WHERE observation_id = ?', late.observationId)).toBe(1);
    expect(conn.scalar('SELECT selected_observation_id FROM accounting_contributions WHERE to_revision IS NULL')).toBeNull();
    const next = ingest(service, young(0));
    expect(conn.scalar('SELECT ingest_seq FROM accounting_observations WHERE observation_id = ?', next.observationId)).toBe(3);
  });

  it('refuses an observation older than the horizon as expired-source', () => {
    const service = serviceWith();
    now = LATER_NOW;
    expect(service.ingestObservation(costObservation('old', 'provider-reported', '0.20'))).toMatchObject({
      ok: false,
      refusal: { code: 'expired-source' }
    });
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(0);
  });

  it('prunes mildly future-skewed observations past horizonDays from ingest_utc via MIN(event_utc, ingested_utc) (16-05)', () => {
    const service = serviceWith();
    // 12 hours ahead of INGEST_NOW -> mild skew (clock_anomaly = 1).
    const skewed = ingest(
      service,
      costObservation('skewed-future', 'provider-reported', '0.25', {
        eventUtc: '2026-11-11T00:00:00.000Z',
        observedUtc: INGEST_NOW
      })
    );
    expect(conn.scalar('SELECT clock_anomaly FROM accounting_observations WHERE observation_id = ?', skewed.observationId)).toBe(1);

    // 90 days + 1 second after INGEST_NOW: ingested_utc is past horizon even though event_utc is still 11h59m59s within horizon.
    now = '2027-02-08T12:00:01.000Z';
    ingest(service, young(0));
    const pruned = service.pruneExpired();
    expect(pruned).toStrictEqual({ ok: true, value: { observationsPruned: 1, historyRowsPruned: 0 } });
    expect(conn.scalar('SELECT count(*) FROM accounting_observations WHERE observation_id = ?', skewed.observationId)).toBe(0);
    // Selected quantity survives compaction intact.
    const latest = service.query({ groupBy: ['backend'], from: '2026-11-11T00:00:00Z', to: '2026-11-12T00:00:00Z' });
    expect(latest.ok && latest.value.rows.at(0)?.measures.find((m) => m.measure === 'cost')?.total).toBe('0.250000');
  });
});

describe('retained-observation bound & post-horizon compaction (T044, FR-R7-16 16-07)', () => {
  it('compacts aged selected observations near the bound, preserves quantities/gaps, and refuses store-full when saturated within horizon', () => {
    const service = serviceWith({ maxRetainedObservations: SMALL_BOUND });
    supersededEstimate(service);
    now = LATER_NOW;
    for (let index = 0; index < SMALL_BOUND - 2; index += 1) ingest(service, young(index));
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(SMALL_BOUND);

    // Next ingest triggers pruneExpired: both expired rows (estimate + selected actual) are reclaimed,
    // leaving 3 young + 1 new = 4 retained rows while preserving actual's selected quantity.
    ingest(service, young(SMALL_BOUND));
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(SMALL_BOUND - 1);
    const oldTotal = service.query(QUERY);
    expect(oldTotal.ok && oldTotal.value.rows.at(0)?.measures.find((item) => item.measure === 'cost')?.total).toBe('0.200000');

    // Fill the remaining slot with a within-horizon observation (now 5 of 5 are within horizon).
    ingest(service, young(SMALL_BOUND + 1));
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(SMALL_BOUND);

    // Saturated by within-horizon observations -> explicit store-full refusal + counted ingest-failed gap.
    expect(service.ingestObservation(young(SMALL_BOUND + 2))).toMatchObject({ ok: false, refusal: { code: 'store-full' } });
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(SMALL_BOUND);
    expect(count("SELECT COALESCE(SUM(count), 0) FROM accounting_gaps WHERE gap_kind = 'ingest-failed'")).toBe(1);
  });

  it('unwedges a capacity-full store of aged selected observations without losing quantities or gaps', () => {
    const service = serviceWith({ maxRetainedObservations: SMALL_BOUND });
    for (let index = 0; index < SMALL_BOUND; index += 1) {
      ingest(
        service,
        costObservation(`aged-selected-${String(index)}`, 'provider-reported', '1.00', {
          attemptId: `0b8f4c1e-5d2a-4f7b-9c36-1e2d3f4a5b0${String(index)}`
        })
      );
    }
    service.recordGaps('dimension-excluded', 2);
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(SMALL_BOUND);

    now = LATER_NOW;
    // Before 16-07, all 5 selected observations permanently wedged the store at `store-full`.
    // Now the 4 aged non-max-seq selected observations compact cleanly so new ingests succeed.
    const admitted = service.ingestObservation(young(0));
    expect(admitted.ok).toBe(true);
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(2); // highest aged + new young
    expect(count('SELECT count(*) FROM accounting_contributions WHERE to_revision IS NULL AND selected_observation_id IS NULL')).toBe(4);

    const agedQuery = service.query(QUERY);
    expect(agedQuery.ok).toBe(true);
    if (!agedQuery.ok) return;
    expect(agedQuery.value.rows.at(0)?.measures.find((m) => m.measure === 'cost')?.total).toBe('5.000000');
    expect(agedQuery.value.gaps).toContainEqual({ kind: 'dimension-excluded', count: 2 });
  });

  it('preserves conflicting completeness after expired non-selected conflicting evidence is pruned and reevaluated (16-07)', () => {
    const service = serviceWith();
    // O1 is recent (T0), O2 disagrees at the same rank (`derived`) with an event time 89 days earlier.
    ingest(
      service,
      costObservation('winner', 'derived', '0.20', {
        eventUtc: '2026-11-10T10:00:00.000Z',
        observedUtc: '2026-11-10T10:00:01.000Z'
      })
    );
    const conflicting = ingest(
      service,
      costObservation('rival', 'derived', '0.95', {
        eventUtc: '2026-08-13T10:00:00.000Z',
        observedUtc: '2026-11-10T10:00:02.000Z'
      })
    );
    expect(
      conn.scalar("SELECT completeness FROM accounting_contributions WHERE to_revision IS NULL AND measure = 'cost'")
    ).toBe('conflicting');
    const attemptQuery = { groupBy: ['backend'] as const, filters: { backend: 'claude' as const } };
    const beforeQuery = service.query(attemptQuery);
    expect(beforeQuery.ok && beforeQuery.value.rows.at(0)?.measures.find((m) => m.measure === 'cost')?.completeness).toBe('conflicting');

    // Advance 3 days: rival's event_utc is now 92 days old (> 90-day horizon), while winner is 3 days old.
    now = '2026-11-13T12:00:00.000Z';
    ingest(
      service,
      costObservation('sentinel-seq', 'provider-reported', '0.10', {
        rootId: 'run-sentinel',
        attemptId: '0b8f4c1e-5d2a-4f7b-9c36-1e2d3f4a5b99',
        eventUtc: '2026-11-13T10:00:00.000Z',
        observedUtc: '2026-11-13T10:00:01.000Z'
      })
    ); // ensures rival is not MAX(ingest_seq)
    expect(service.pruneExpired()).toMatchObject({ ok: true, value: { observationsPruned: 1 } });
    expect(conn.scalar('SELECT count(*) FROM accounting_observations WHERE observation_id = ?', conflicting.observationId)).toBe(0);

    // A later corroborating derived observation triggers recomputeInvocation on the same invocation.
    ingest(
      service,
      costObservation('corroborator', 'derived', '0.20', {
        eventUtc: '2026-11-13T11:00:00.000Z',
        observedUtc: '2026-11-13T11:00:01.000Z'
      })
    );
    // Disagreement history MUST NOT silently flip back to `known`.
    expect(
      conn.scalar("SELECT completeness FROM accounting_contributions WHERE to_revision IS NULL AND measure = 'cost'")
    ).toBe('conflicting');
    const afterReeval = service.query(attemptQuery);
    expect(afterReeval.ok && afterReeval.value.rows.at(0)?.measures.find((m) => m.measure === 'cost')?.completeness).toBe('conflicting');

    // A strictly higher-ranked (`provider-reported`) observation may still resolve the lower-ranked conflict.
    ingest(
      service,
      costObservation('authoritative', 'provider-reported', '0.22', {
        eventUtc: '2026-11-13T11:05:00.000Z',
        observedUtc: '2026-11-13T11:05:01.000Z'
      })
    );
    expect(
      conn.scalar("SELECT completeness FROM accounting_contributions WHERE to_revision IS NULL AND measure = 'cost'")
    ).toBe('known');
    const resolved = service.query({ ...attemptQuery, rootIds: [ROOT] });
    expect(resolved.ok && resolved.value.rows.at(0)?.measures.find((m) => m.measure === 'cost')).toMatchObject({
      total: '0.220000',
      completeness: 'known'
    });
  });
});
