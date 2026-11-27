/**
 * FR-R6-F06 (T042, FR-010, FR-019, US3 scenarios 1-4) — a correction replaces a contribution
 * under a new revision, never adds to it; the earlier revision stays reproducible; the same
 * correction twice changes the projection once; an actual supersedes an estimate; and a
 * correction past the horizon, past the per-contribution limit, or with free text is refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import type { AccountingObservationInput } from '../../../src/services/usage-accounting/observation-normalizer';
import { readOpenContributions } from '../../../src/services/usage-accounting/projection';
import { createUsageAccountingService } from '../../../src/services/usage-accounting/usage-accounting-service';

const INGEST_NOW = '2026-11-10T12:00:00.000Z';
const PAST_HORIZON_NOW = '2027-02-10T12:00:00.000Z';
const QUERY = { groupBy: ['backend'], from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' };
const ROOT = 'run-correct-1';
const ATTEMPT = '7c3e4f50-6172-4c83-9d94-be05f6071803';
const CORRECTION_LIMIT = 64;
const LONGEST_REASON = `a${'b'.repeat(63)}`;

let conn: NodeSqliteConnection;
let now = INGEST_NOW;

beforeEach(() => {
  now = INGEST_NOW;
  conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(INGEST_NOW));
});

afterEach(() => {
  if (conn.db.isOpen) conn.close();
});

function service() {
  return createUsageAccountingService({ conn, nowUtc: () => now, monotonicMs: () => 1, workspaceId: 'ws-1' });
}

function observation(overrides: Partial<AccountingObservationInput> = {}): AccountingObservationInput {
  return {
    producerNamespace: 'schegent.phase-end/1',
    source: 'phase-end',
    sourceKind: 'phase-end',
    sourceIdentity: `${ROOT}:phase-a:0`,
    rootId: ROOT,
    attemptId: ATTEMPT,
    invocationOrdinal: 0,
    counterScope: 'invocation-delta',
    adapterVersion: 'claude/1',
    dimensions: { backend: 'claude', phaseId: 'phase-a' },
    eventUtc: '2026-11-10T10:00:00.000Z',
    observedUtc: '2026-11-10T10:00:01.000Z',
    measures: [
      { measure: 'input_tokens', quantity: 100, unit: 'count', provenance: 'provider-reported' },
      { measure: 'output_tokens', quantity: 40, unit: 'count', provenance: 'provider-reported' }
    ],
    ...overrides
  };
}

function ingested(input: AccountingObservationInput = observation()): string {
  const result = service().ingestObservation(input);
  if (!result.ok) throw new Error(`ingest refused: ${result.refusal.code}`);
  return result.value.observationId;
}

function correction(targetObservationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetObservationId,
    measure: 'input_tokens',
    replacementQuantity: 60,
    unit: 'count',
    reasonCode: 'provider-revision',
    actor: 'provider',
    ...overrides
  };
}

function answer(asOfRevision?: number) {
  const result = service().query(asOfRevision === undefined ? QUERY : { ...QUERY, asOfRevision });
  if (!result.ok) throw new Error(`query refused: ${result.refusal.code}`);
  return result.value;
}

function measureOf(value: ReturnType<typeof answer>, measure: string) {
  return value.rows.at(0)?.measures.find((item) => item.measure === measure);
}

function count(sql: string): number {
  return Number(conn.scalar(sql) ?? 0);
}

describe('applyCorrection (T042)', () => {
  it('replaces the contribution under a higher revision, and the total goes down', () => {
    const target = ingested();
    const before = answer();
    expect(measureOf(before, 'input_tokens')?.total).toBe('100');

    const corrected = service().applyCorrection(correction(target));
    expect(corrected).toStrictEqual({ ok: true, value: { correctionId: expect.any(Number), revision: before.revision + 1 } });

    const after = answer();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.cutoffIngestSeq).toBe(before.cutoffIngestSeq);
    expect(measureOf(after, 'input_tokens')).toMatchObject({ total: '60', completeness: 'known' });
    expect(measureOf(after, 'output_tokens')?.total).toBe('40');
    const open = readOpenContributions(conn).filter((row) => row.measure === 'input_tokens');
    expect(open).toHaveLength(1);
    expect(open.at(0)).toMatchObject({ quantity: 60n, selectedObservationId: null, correctionId: expect.any(Number) });
    expect(count("SELECT count(*) FROM accounting_revisions WHERE cause = 'correction'")).toBe(1);
  });

  it('reproduces the earlier revision unchanged, with its cutoff', () => {
    const target = ingested();
    const before = answer();
    service().applyCorrection(correction(target));
    const pinned = answer(before.revision);
    expect(pinned.revision).toBe(before.revision);
    expect(pinned.cutoffIngestSeq).toBe(before.cutoffIngestSeq);
    expect(pinned.rows).toStrictEqual(before.rows);
  });

  it('changes the projection once when the same correction arrives twice', () => {
    const target = ingested();
    const first = service().applyCorrection(correction(target));
    const revisions = count('SELECT count(*) FROM accounting_revisions');
    const second = service().applyCorrection(correction(target));
    expect(second).toStrictEqual(first);
    expect(count('SELECT count(*) FROM accounting_corrections')).toBe(1);
    expect(count('SELECT count(*) FROM accounting_revisions')).toBe(revisions);
    expect(measureOf(answer(), 'input_tokens')?.total).toBe('60');
  });

  it('withdraws a value to unknown with a null replacement', () => {
    const target = ingested();
    service().applyCorrection(correction(target, { replacementQuantity: null, actor: 'operator', reasonCode: 'mistaken-entry' }));
    expect(measureOf(answer(), 'input_tokens')).toMatchObject({ completeness: 'unknown', coverage: { known: 0, denominator: 1 } });
  });

  it('keeps a correction ahead of a later observation for the same figure', () => {
    const target = ingested();
    service().applyCorrection(correction(target));
    ingested(observation({ sourceIdentity: `${ROOT}:phase-a:0:late`, eventUtc: '2026-11-10T10:05:00.000Z' }));
    expect(measureOf(answer(), 'input_tokens')?.total).toBe('60');
  });

  it('lets an actual supersede an estimate, never adding the two (scenario 3)', () => {
    ingested(
      observation({
        measures: [{ measure: 'cost', quantity: '0.50', unit: 'USD', provenance: 'estimated', pricingVersion: 'pricing-2026-11' }]
      })
    );
    expect(measureOf(answer(), 'cost')).toMatchObject({ estimatedTotal: '0.500000' });
    ingested(
      observation({
        sourceIdentity: `${ROOT}:phase-a:0:actual`,
        measures: [{ measure: 'cost', quantity: '0.20', unit: 'USD', provenance: 'provider-reported' }]
      })
    );
    const cost = measureOf(answer(), 'cost');
    expect(cost).toMatchObject({ total: '0.200000', reportedTotal: '0.200000', estimatedTotal: '0.000000', completeness: 'known' });
    expect(readOpenContributions(conn).filter((row) => row.measure === 'cost')).toHaveLength(1);
  });

  it('refuses a target past the horizon, or missing, and changes no total', () => {
    const target = ingested();
    now = PAST_HORIZON_NOW;
    const revisions = count('SELECT count(*) FROM accounting_revisions');
    expect(service().applyCorrection(correction(target))).toMatchObject({
      ok: false,
      refusal: { code: 'beyond-correction-horizon' }
    });
    expect(service().applyCorrection(correction('no-such-observation'))).toMatchObject({
      ok: false,
      refusal: { code: 'beyond-correction-horizon' }
    });
    expect(count('SELECT count(*) FROM accounting_corrections')).toBe(0);
    expect(count('SELECT count(*) FROM accounting_revisions')).toBe(revisions);
    now = INGEST_NOW;
    expect(measureOf(answer(), 'input_tokens')?.total).toBe('100');
  });

  it('refuses the 65th correction of one contribution', () => {
    const target = ingested();
    for (let index = 1; index <= CORRECTION_LIMIT; index += 1) {
      expect(service().applyCorrection(correction(target, { replacementQuantity: index }))).toMatchObject({ ok: true });
    }
    expect(service().applyCorrection(correction(target, { replacementQuantity: 999 }))).toMatchObject({
      ok: false,
      refusal: { code: 'correction-limit' }
    });
    expect(count('SELECT count(*) FROM accounting_corrections')).toBe(CORRECTION_LIMIT);
    expect(measureOf(answer(), 'input_tokens')?.total).toBe(String(CORRECTION_LIMIT));
  });

  it('holds the reason code to its pattern', () => {
    const target = ingested();
    for (const reasonCode of ['Provider-Revision', '', '9-starts-with-a-digit', 'has space', `${LONGEST_REASON}x`, 7]) {
      expect(service().applyCorrection(correction(target, { reasonCode }))).toMatchObject({
        ok: false,
        refusal: { code: 'invalid-correction', detail: 'reasonCode' }
      });
    }
    expect(service().applyCorrection(correction(target, { reasonCode: LONGEST_REASON }))).toMatchObject({ ok: true });
  });

  it('refuses a free-text actor and never stores it', () => {
    const target = ingested();
    const freeText = ['jane', 'example.org'].join('@');
    expect(service().applyCorrection(correction(target, { actor: freeText }))).toMatchObject({
      ok: false,
      refusal: { code: 'invalid-correction', detail: 'actor' }
    });
    expect(count('SELECT count(*) FROM accounting_corrections')).toBe(0);
  });

  it('refuses a bad measure, unit, quantity or shape as invalid-correction', () => {
    const target = ingested();
    const cases: readonly [Record<string, unknown>, string][] = [
      [correction(target, { measure: 'tokens' }), 'measure'],
      [correction(target, { unit: 'USD' }), 'unit'],
      [correction(target, { measure: 'cache_read_tokens' }), 'measure'],
      [correction(target, { replacementQuantity: -1 }), 'replacementQuantity'],
      [correction(target, { replacementQuantity: 1.5 }), 'replacementQuantity'],
      [correction(target, { extra: true }), 'request'],
      [correction(target, { targetObservationId: 42 }), 'targetObservationId']
    ];
    for (const [request, detail] of cases) {
      expect(service().applyCorrection(request)).toMatchObject({ ok: false, refusal: { code: 'invalid-correction', detail } });
    }
    expect(service().applyCorrection(null)).toMatchObject({ ok: false, refusal: { code: 'invalid-correction', detail: 'request' } });
    expect(count('SELECT count(*) FROM accounting_corrections')).toBe(0);
  });
});

describe('applyCorrection: the open-contribution lookup (SC-003)', () => {
  it('searches the full open-contribution index key', () => {
    const target = ingested(observation({ invocationOrdinal: 5 }));
    const reads = vi.spyOn(conn, 'get');
    expect(service().applyCorrection(correction(target))).toMatchObject({ ok: true });
    const lookups = reads.mock.calls.filter((call) => /FROM accounting_contributions[\s\S]*to_revision IS NULL/u.test(String(call.at(0))));
    reads.mockRestore();
    expect(lookups.length).toBeGreaterThan(0);
    for (const [sql, ...params] of lookups) {
      const plan = conn.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${String(sql)}`, ...(params as never[]));
      expect(plan.map((row) => row.detail).join(' ')).toContain('idx_accounting_contributions_open (attempt_id=? AND <expr>=? AND measure=? AND unit=?)');
    }
  });
});
