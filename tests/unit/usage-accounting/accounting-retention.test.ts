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

function costObservation(identity: string, provenance: 'estimated' | 'provider-reported', quantity: string, overrides: Partial<AccountingObservationInput> = {}): AccountingObservationInput {
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

  it('never prunes the observation holding the highest ingest sequence', () => {
    const service = serviceWith();
    ingest(service, costObservation('actual', 'provider-reported', '0.20'));
    const late = ingest(service, costObservation('estimate', 'estimated', '0.50'));
    now = LATER_NOW;
    expect(service.pruneExpired()).toMatchObject({ ok: true, value: { observationsPruned: 0 } });
    expect(conn.scalar('SELECT count(*) FROM accounting_observations WHERE observation_id = ?', late.observationId)).toBe(1);
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
});

describe('retained-observation bound (T044)', () => {
  it('prunes near the bound, then answers store-full when nothing more can go', () => {
    const service = serviceWith({ maxRetainedObservations: SMALL_BOUND });
    supersededEstimate(service);
    now = LATER_NOW;
    for (let index = 0; index < SMALL_BOUND - 2; index += 1) ingest(service, young(index));
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(SMALL_BOUND);

    ingest(service, young(SMALL_BOUND));
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(SMALL_BOUND);

    expect(service.ingestObservation(young(SMALL_BOUND + 1))).toMatchObject({ ok: false, refusal: { code: 'store-full' } });
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(SMALL_BOUND);
  });
});
