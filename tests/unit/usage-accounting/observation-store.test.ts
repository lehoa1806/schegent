/**
 * FR-R6-F06 (T016, FR-001..005, FR-014, FR-015, NFR-002) — the ingest transaction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AccountingBounds,
  DEFAULT_ACCOUNTING_BOUNDS
} from '../../../src/contracts/usage-accounting/accounting-types';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import type { AccountingObservationInput } from '../../../src/services/usage-accounting/observation-normalizer';
import { ingestObservationRecord } from '../../../src/services/usage-accounting/observation-store';

const NOW = '2026-11-10T12:00:00.000Z';

let conn: NodeSqliteConnection;

beforeEach(() => {
  conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
});

afterEach(() => {
  conn.close();
});

function observation(overrides: Partial<AccountingObservationInput> = {}): AccountingObservationInput {
  return {
    producerNamespace: 'schegent.phase-end/1',
    source: 'phase-end',
    sourceKind: 'phase-end',
    sourceIdentity: 'run-1:phase-a:0',
    rootId: 'root-1',
    attemptId: 'attempt-1',
    invocationOrdinal: 0,
    counterScope: 'invocation-delta',
    adapterVersion: 'claude/1',
    dimensions: { backend: 'claude', modelReported: 'claude-sonnet-4-5', phaseId: 'phase-a' },
    eventUtc: '2026-11-10T11:59:00.000Z',
    observedUtc: '2026-11-10T11:59:01.000Z',
    measures: [
      { measure: 'input_tokens', quantity: 100, unit: 'count', provenance: 'provider-reported' },
      { measure: 'output_tokens', quantity: 40, unit: 'count', provenance: 'provider-reported' }
    ],
    ...overrides
  };
}

function ctx(bounds: Partial<AccountingBounds> = {}) {
  return {
    workspaceId: 'ws-1',
    nowUtc: NOW,
    monotonicMs: 1000,
    bounds: { ...DEFAULT_ACCOUNTING_BOUNDS, ...bounds }
  };
}

function count(sql: string, ...params: (string | number)[]): number {
  return Number(conn.scalar(sql, ...params) ?? 0);
}

function gapCount(kind: string, scope: string): number {
  return count('SELECT COALESCE(SUM(count), 0) FROM accounting_gaps WHERE gap_kind = ? AND scope_key = ?', kind, scope);
}

describe('observation store (T016)', () => {
  it('writes the observation, its measures, the attempt and a pending intent in one transaction', () => {
    const result = ingestObservationRecord(conn, observation(), ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.disposition).toBe('accepted');
    expect(result.value.ingestSeq).toBe(1);
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(1);
    expect(count('SELECT count(*) FROM accounting_observation_measures')).toBe(2);
    expect(count('SELECT count(*) FROM accounting_attempts')).toBe(1);
    expect(count("SELECT count(*) FROM accounting_projection_intents WHERE state = 'pending'")).toBe(1);
    expect(conn.db.isTransaction).toBe(false);
  });

  it('assigns monotonic ingest sequence numbers', () => {
    const seqs: (number | null)[] = [];
    for (let index = 0; index < 4; index += 1) {
      const result = ingestObservationRecord(conn, observation({ sourceIdentity: `run-1:phase-a:${String(index)}` }), ctx());
      seqs.push(result.ok ? result.value.ingestSeq : null);
    }
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it('stores no row for a same-content replay and calls it duplicate', () => {
    const first = ingestObservationRecord(conn, observation(), ctx());
    const replay = ingestObservationRecord(conn, observation(), ctx());
    expect(replay.ok).toBe(true);
    if (!replay.ok || !first.ok) return;
    expect(replay.value.disposition).toBe('duplicate');
    expect(replay.value.observationId).toBe(first.value.observationId);
    expect(replay.value.ingestSeq).toBeNull();
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(1);
    expect(count('SELECT count(*) FROM accounting_projection_intents')).toBe(1);
  });

  it('stores a different content under the same identity as a new revision, conflicting', () => {
    ingestObservationRecord(conn, observation(), ctx());
    const changed = observation({
      measures: [{ measure: 'input_tokens', quantity: 101, unit: 'count', provenance: 'provider-reported' }]
    });
    const result = ingestObservationRecord(conn, changed, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.disposition).toBe('conflicting');
    const revisions = conn.all<{ observation_revision: number }>(
      'SELECT observation_revision FROM accounting_observations ORDER BY ingest_seq'
    );
    expect(revisions.map((row) => row.observation_revision)).toEqual([1, 2]);
    const again = ingestObservationRecord(conn, changed, ctx());
    expect(again.ok && again.value.disposition).toBe('duplicate');
  });

  it('gives two unanchored observations distinct ids and holds them unattributed', () => {
    const unanchored = observation({ sourceIdentity: null });
    const first = ingestObservationRecord(conn, unanchored, ctx());
    const second = ingestObservationRecord(conn, unanchored, ctx());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.observationId).not.toBe(second.value.observationId);
    expect(first.value.disposition).toBe('unattributed');
    expect(count("SELECT count(*) FROM accounting_observations WHERE disposition = 'unattributed'")).toBe(2);
    expect(count('SELECT count(*) FROM accounting_projection_intents')).toBe(0);
  });

  it('refuses past the unattributed bound and counts the gap', () => {
    const bounds = { maxUnattributed: 3 };
    for (let index = 0; index < 3; index += 1) {
      const held = ingestObservationRecord(conn, observation({ sourceIdentity: null }), ctx(bounds));
      expect(held.ok).toBe(true);
    }
    const refused = ingestObservationRecord(conn, observation({ sourceIdentity: null }), ctx(bounds));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe('unattributed-limit');
    expect(gapCount('unattributed-limit', 'attempt-1')).toBe(1);
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(3);
  });

  it('folds a new gap key into global once the key bound is reached', () => {
    const bounds = { maxGapKeys: 2 };
    for (const attemptId of ['a-1', 'a-2', 'a-3', 'a-4']) {
      ingestObservationRecord(conn, observation({ attemptId, producerNamespace: 'schegent.export/otel' }), ctx(bounds));
    }
    expect(gapCount('telemetry-echo', 'a-1')).toBe(1);
    expect(gapCount('telemetry-echo', 'a-2')).toBe(1);
    expect(gapCount('telemetry-echo', 'global')).toBe(2);
    expect(count('SELECT count(*) FROM accounting_gaps')).toBe(3);
  });

  it('refuses an observation over 16 KiB or over 32 fields as too large', () => {
    const oversized = observation({ sourceIdentity: 'x'.repeat(17_000) });
    const bySize = ingestObservationRecord(conn, oversized, ctx());
    expect(bySize.ok).toBe(false);
    if (!bySize.ok) expect(bySize.refusal.code).toBe('observation-too-large');

    const wide = { ...observation(), ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`extra${String(index)}`, 1])) };
    const byFields = ingestObservationRecord(conn, wide as AccountingObservationInput, ctx());
    expect(byFields.ok).toBe(false);
    if (!byFields.ok) expect(byFields.refusal.code).toBe('observation-too-large');
    expect(gapCount('observation-too-large', 'attempt-1')).toBe(2);
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(0);
  });

  it('refuses a telemetry-export echo and counts it', () => {
    const echo = ingestObservationRecord(conn, observation({ producerNamespace: 'schegent.export/otel' }), ctx());
    expect(echo.ok).toBe(false);
    if (!echo.ok) expect(echo.refusal.code).toBe('telemetry-echo');
    const bySource = ingestObservationRecord(conn, observation({ source: 'telemetry-export' }), ctx());
    expect(bySource.ok).toBe(false);
    expect(gapCount('telemetry-echo', 'attempt-1')).toBe(2);
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(0);
  });

  it('flags an event more than 5 minutes ahead of ingest and keeps the event time', () => {
    const ahead = '2026-11-10T12:10:00.000Z';
    const result = ingestObservationRecord(conn, observation({ eventUtc: ahead }), ctx());
    expect(result.ok).toBe(true);
    const row = conn.get<{ clock_anomaly: number; event_utc: string }>(
      'SELECT clock_anomaly, event_utc FROM accounting_observations'
    );
    expect(row?.clock_anomaly).toBe(1);
    expect(row?.event_utc).toBe(ahead);
  });

  it('does not flag an event within the tolerance', () => {
    ingestObservationRecord(conn, observation({ eventUtc: '2026-11-10T12:04:00.000Z' }), ctx());
    expect(count('SELECT clock_anomaly FROM accounting_observations')).toBe(0);
  });

  it('refuses an event older than the horizon and counts it', () => {
    const result = ingestObservationRecord(conn, observation({ eventUtc: '2026-07-01T00:00:00.000Z' }), ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('expired-source');
    expect(gapCount('expired-source', 'attempt-1')).toBe(1);
  });

  it('refuses a non-integer counter and counts it', () => {
    const bad = observation({ measures: [{ measure: 'input_tokens', quantity: 1.5, unit: 'count', provenance: 'derived' }] });
    const result = ingestObservationRecord(conn, bad, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('invalid-counter');
    expect(gapCount('invalid-counter', 'attempt-1')).toBe(1);
  });

  it('refuses an attempt that is already bound to another root', () => {
    ingestObservationRecord(conn, observation(), ctx());
    const moved = ingestObservationRecord(conn, observation({ rootId: 'root-2', sourceIdentity: 'run-1:phase-a:9' }), ctx());
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.refusal).toEqual({ code: 'invalid-observation', detail: 'rootId' });
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(1);
  });

  it('excludes a secret-shaped dimension, stores the row and counts the exclusion', () => {
    const secret = 'sk-' + 'ant-api03-' + 'z'.repeat(40);
    const result = ingestObservationRecord(conn, observation({ dimensions: { backend: 'claude', modelReported: secret } }), ctx());
    expect(result.ok).toBe(true);
    const row = conn.get<{ model_reported: string | null }>('SELECT model_reported FROM accounting_observations');
    expect(row?.model_reported).toBeNull();
    expect(gapCount('dimension-excluded', 'attempt-1')).toBe(1);
    const stored = JSON.stringify(conn.all('SELECT * FROM accounting_observations'));
    expect(stored.includes(secret)).toBe(false);
  });

  it('stores money as exact micros with the reported scale', () => {
    const priced = observation({
      measures: [{ measure: 'cost', quantity: '0.123', unit: 'USD', provenance: 'provider-reported' }]
    });
    expect(ingestObservationRecord(conn, priced, ctx()).ok).toBe(true);
    const row = conn.get<{ q: string; reported_scale: number }>(
      "SELECT CAST(quantity AS TEXT) AS q, reported_scale FROM accounting_observation_measures WHERE measure = 'cost'"
    );
    expect(row).toEqual({ q: '123000', reported_scale: 3 });
  });

  it('refuses a malformed identity field and names only the field', () => {
    const result = ingestObservationRecord(conn, observation({ attemptId: '../escape' }), ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toEqual({ code: 'invalid-observation', detail: 'attemptId' });
  });
});
