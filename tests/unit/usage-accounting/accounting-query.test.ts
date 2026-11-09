/**
 * FR-R6-F06 (T021, US1 scenarios 1-5, FR-017, FR-018, FR-020, FR-022, NFR-003) — bounded,
 * revisioned aggregate reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountingBounds, Provenance } from '../../../src/contracts/usage-accounting/accounting-types';
import { PROVIDER_QUALIFICATIONS } from '../../../src/contracts/usage-accounting/provider-qualifications';
import type { AccountingQueryResponse, AccountingRow } from '../../../src/contracts/usage-accounting/query-contract';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import type {
  AccountingMeasureInput,
  AccountingObservationInput
} from '../../../src/services/usage-accounting/observation-normalizer';
import {
  type UsageAccountingService,
  createUsageAccountingService
} from '../../../src/services/usage-accounting/usage-accounting-service';

const NOW = '2026-11-10T12:00:00.000Z';

let conn: NodeSqliteConnection;

beforeEach(() => {
  conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
});

afterEach(() => {
  conn.close();
});

function service(bounds: Partial<AccountingBounds> = {}): UsageAccountingService {
  return createUsageAccountingService({ conn, nowUtc: () => NOW, monotonicMs: () => 1, workspaceId: 'ws-1', bounds });
}

interface AttemptSpec {
  readonly attemptId: string;
  readonly rootId?: string;
  readonly backend?: string;
  readonly model?: string;
  readonly phaseId?: string;
  readonly eventUtc?: string;
  readonly measures: readonly AccountingMeasureInput[];
}

function observation(spec: AttemptSpec): AccountingObservationInput {
  return {
    producerNamespace: 'schegent.phase-end/1',
    source: 'phase-end',
    sourceKind: 'phase-end',
    sourceIdentity: `${spec.attemptId}:0`,
    rootId: spec.rootId ?? `root-${spec.attemptId}`,
    attemptId: spec.attemptId,
    counterScope: 'invocation-delta',
    adapterVersion: 'test/1',
    dimensions: { backend: spec.backend ?? 'claude', modelRequested: spec.model ?? 'm-1', phaseId: spec.phaseId ?? 'implement' },
    eventUtc: spec.eventUtc ?? '2026-11-10T11:00:00.000Z',
    observedUtc: spec.eventUtc ?? '2026-11-10T11:00:00.000Z',
    measures: spec.measures
  };
}

function ingest(accounting: UsageAccountingService, spec: AttemptSpec): void {
  const result = accounting.ingestObservation(observation(spec));
  if (!result.ok || result.value.revision === null) throw new Error(`fixture ingest failed: ${JSON.stringify(result)}`);
}

function tokens(input: number, output: number): AccountingMeasureInput[] {
  return [
    { measure: 'input_tokens', quantity: input, unit: 'count', provenance: 'provider-reported' },
    { measure: 'output_tokens', quantity: output, unit: 'count', provenance: 'provider-reported' }
  ];
}

function cost(amount: string, unit = 'USD', provenance: Provenance = 'provider-reported'): AccountingMeasureInput {
  return {
    measure: 'cost',
    quantity: amount,
    unit,
    provenance,
    ...(provenance === 'estimated' ? { pricingVersion: 'pricing-2026-11' } : {})
  };
}

function okValue(result: ReturnType<UsageAccountingService['query']>): AccountingQueryResponse {
  if (!result.ok) throw new Error(`query refused: ${JSON.stringify(result.refusal)}`);
  return result.value;
}

function measureOf(row: AccountingRow | undefined, measure: string, unit?: string) {
  return row?.measures.find((item) => item.measure === measure && (unit === undefined || item.unit === unit));
}

describe('accounting query: US1 scenarios', () => {
  it('scenario 1: tokens for both, one known cost, partial coverage 1 of 2', () => {
    const accounting = service();
    ingest(accounting, { attemptId: 'a-1', measures: [...tokens(100, 40), cost('0.25')] });
    ingest(accounting, { attemptId: 'a-2', measures: tokens(10, 4) });
    const response = okValue(accounting.query({ groupBy: ['backend'] }));
    expect(response.revision).toBe(2);
    expect(response.policyVersion).toBe(1);
    expect(response.rows).toHaveLength(1);
    const row = response.rows.at(0);
    expect(row?.key).toEqual({ backend: 'claude' });
    expect(row?.attempts).toBe(2);
    expect(row?.roots).toBe(2);
    expect(measureOf(row, 'input_tokens')).toMatchObject({ total: '110', completeness: 'known', coverage: { known: 2, denominator: 2 } });
    expect(measureOf(row, 'cost')).toMatchObject({
      unit: 'USD',
      total: '0.250000',
      reportedTotal: '0.250000',
      estimatedTotal: '0.000000',
      completeness: 'partial',
      coverage: { known: 1, denominator: 2 }
    });
  });

  it('scenario 2: a reported zero cost is known', () => {
    const accounting = service();
    ingest(accounting, { attemptId: 'a-1', measures: [...tokens(1, 1), cost('0')] });
    const row = okValue(accounting.query({ groupBy: [] })).rows.at(0);
    expect(measureOf(row, 'cost')).toMatchObject({ total: '0.000000', completeness: 'known', coverage: { known: 1, denominator: 1 } });
  });

  it('scenario 3: an estimate lands only in the estimated total and keeps the reported lane partial', () => {
    const accounting = service();
    ingest(accounting, { attemptId: 'a-1', measures: [...tokens(1, 1), cost('0.50')] });
    ingest(accounting, { attemptId: 'a-2', measures: [...tokens(1, 1), cost('0.20', 'USD', 'estimated')] });
    const row = okValue(accounting.query({ groupBy: [] })).rows.at(0);
    expect(measureOf(row, 'cost')).toMatchObject({
      total: '0.500000',
      reportedTotal: '0.500000',
      estimatedTotal: '0.200000',
      completeness: 'partial',
      coverage: { known: 1, denominator: 2 }
    });
    const pricing = conn.scalar("SELECT pricing_version FROM accounting_observation_measures WHERE measure = 'cost' AND provenance = 'estimated'");
    expect(pricing).toBe('pricing-2026-11');
  });

  it('scenario 4: two currencies give two totals and no combined amount', () => {
    const accounting = service();
    ingest(accounting, { attemptId: 'a-1', measures: [cost('1.00', 'USD')] });
    ingest(accounting, { attemptId: 'a-2', measures: [cost('2.00', 'EUR')] });
    const row = okValue(accounting.query({ groupBy: [] })).rows.at(0);
    const costs = row?.measures.filter((item) => item.measure === 'cost').map((item) => [item.unit, item.total]);
    expect(costs).toEqual([
      ['EUR', '2.000000'],
      ['USD', '1.000000']
    ]);
  });

  it('scenario 5: a subset-of-input cache count stays distinct from input', () => {
    const accounting = service();
    ingest(accounting, {
      attemptId: 'a-1',
      backend: 'codex',
      measures: [
        ...tokens(100, 10),
        { measure: 'cache_read_tokens', quantity: 60, unit: 'count', provenance: 'provider-reported', cacheRelation: 'subset-of-input' }
      ]
    });
    const row = okValue(accounting.query({ groupBy: ['backend'] })).rows.at(0);
    expect(measureOf(row, 'input_tokens')?.total).toBe('100');
    expect(measureOf(row, 'cache_read_tokens')?.total).toBe('60');
  });
});

describe('accounting query: bounds and paging', () => {
  it('groups by up to three dimensions over a half-open event-time range', () => {
    const accounting = service();
    ingest(accounting, { attemptId: 'a-1', model: 'm-1', eventUtc: '2026-11-01T00:00:00.000Z', measures: tokens(1, 1) });
    ingest(accounting, { attemptId: 'a-2', model: 'm-2', eventUtc: '2026-11-01T23:59:59.999Z', measures: tokens(2, 1) });
    ingest(accounting, { attemptId: 'a-3', model: 'm-2', eventUtc: '2026-11-02T00:00:00.000Z', measures: tokens(4, 1) });
    const response = okValue(
      accounting.query({
        groupBy: ['backend', 'model', 'utcDay'],
        from: '2026-11-01T00:00:00Z',
        to: '2026-11-02T00:00:00Z'
      })
    );
    expect(response.rows.map((row) => [row.key, measureOf(row, 'input_tokens')?.total])).toEqual([
      [{ backend: 'claude', model: 'm-1', utcDay: '2026-11-01' }, '1'],
      [{ backend: 'claude', model: 'm-2', utcDay: '2026-11-01' }, '2']
    ]);
    const filtered = okValue(accounting.query({ groupBy: [], filters: { model: 'm-2' } }));
    expect(measureOf(filtered.rows.at(0), 'input_tokens')?.total).toBe('6');
  });

  it('refuses a limit above 200', () => {
    expect(service().query({ groupBy: [], limit: 201 })).toEqual({ ok: false, refusal: { code: 'invalid-query', detail: 'limit' } });
  });

  it('pages with a keyset cursor without duplicates or gaps', () => {
    const accounting = service();
    for (let index = 0; index < 7; index += 1) {
      ingest(accounting, { attemptId: `a-${String(index)}`, phaseId: `phase-${String(index)}`, measures: tokens(index + 1, 1) });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = okValue(accounting.query({ groupBy: ['phaseId'], limit: 3, ...(cursor !== undefined ? { cursor } : {}) }));
      seen.push(...page.rows.map((row) => String(row.key.phaseId)));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(['phase-0', 'phase-1', 'phase-2', 'phase-3', 'phase-4', 'phase-5', 'phase-6']);
    expect(accounting.query({ groupBy: ['phaseId'], cursor: 'not-a-cursor' })).toEqual({
      ok: false,
      refusal: { code: 'invalid-query', detail: 'cursor' }
    });
  });

  it('refuses an exact sum above int64 as aggregate-overflow', () => {
    const accounting = service();
    const near = (2n ** 63n - 10n).toString();
    ingest(accounting, { attemptId: 'a-1', measures: [{ measure: 'input_tokens', quantity: near, unit: 'count', provenance: 'provider-reported' }] });
    ingest(accounting, { attemptId: 'a-2', measures: [{ measure: 'input_tokens', quantity: near, unit: 'count', provenance: 'provider-reported' }] });
    expect(accounting.query({ groupBy: [] })).toEqual({ ok: false, refusal: { code: 'aggregate-overflow' } });
  });

  it('refuses an aborted read as deadline-exceeded', () => {
    const accounting = service();
    ingest(accounting, { attemptId: 'a-1', measures: tokens(1, 1) });
    const controller = new AbortController();
    controller.abort();
    expect(accounting.query({ groupBy: [] }, controller.signal)).toEqual({ ok: false, refusal: { code: 'deadline-exceeded' } });
  });

  it('refuses an encoded response above the byte bound', () => {
    const accounting = service({ maxResponseBytes: 1024 });
    for (let index = 0; index < 12; index += 1) {
      ingest(accounting, { attemptId: `a-${String(index)}`, phaseId: `phase-${String(index)}`, measures: [...tokens(1, 1), cost('1')] });
    }
    expect(accounting.query({ groupBy: ['phaseId'], limit: 200 })).toEqual({ ok: false, refusal: { code: 'response-too-large' } });
  });

  it('reports occupancy as the latest value, never a sum', () => {
    const accounting = service();
    const occupancy = (used: number): AccountingMeasureInput[] => [
      { measure: 'context_used', quantity: used, unit: 'count', provenance: 'provider-reported' },
      { measure: 'context_size', quantity: 200_000, unit: 'count', provenance: 'provider-reported' }
    ];
    ingest(accounting, { attemptId: 'a-1', eventUtc: '2026-11-10T10:00:00.000Z', measures: occupancy(5_000) });
    ingest(accounting, { attemptId: 'a-2', eventUtc: '2026-11-10T11:00:00.000Z', measures: occupancy(9_000) });
    const row = okValue(accounting.query({ groupBy: [] })).rows.at(0);
    expect(measureOf(row, 'context_used')).toMatchObject({ total: '9000', completeness: 'known', coverage: { known: 2, denominator: 2 } });
    expect(measureOf(row, 'context_size')?.total).toBe('200000');
  });

  it('reads as of an earlier revision', () => {
    const accounting = service();
    ingest(accounting, { attemptId: 'a-1', measures: tokens(1, 1) });
    ingest(accounting, { attemptId: 'a-2', measures: tokens(2, 1) });
    const early = okValue(accounting.query({ groupBy: [], asOfRevision: 1 }));
    expect(early.revision).toBe(1);
    expect(early.rows.at(0)?.attempts).toBe(1);
    expect(accounting.query({ groupBy: [], asOfRevision: 9 })).toEqual({ ok: false, refusal: { code: 'invalid-query', detail: 'asOfRevision' } });
  });

  it('answers an empty store with revision 0 and no rows', () => {
    expect(okValue(service().query({ groupBy: ['backend'] }))).toEqual({
      revision: 0,
      cutoffIngestSeq: 0,
      policyVersion: 1,
      calculationVersion: 1,
      rows: [],
      unattributedCount: 0,
      gaps: []
    });
  });

  it('counts unattributed observations and summarizes gaps by kind', () => {
    const accounting = service();
    accounting.ingestObservation({ ...observation({ attemptId: 'x', measures: tokens(1, 1) }), rootId: null, attemptId: null, sourceIdentity: null });
    accounting.ingestObservation({ ...observation({ attemptId: 'a-1', measures: tokens(1, 1) }), producerNamespace: 'schegent.export/1' });
    const response = okValue(accounting.query({ groupBy: [] }));
    expect(response.unattributedCount).toBe(1);
    expect(response.gaps).toEqual([{ kind: 'telemetry-echo', count: 1 }]);
    const gaps = accounting.readGaps({ limit: 10 });
    expect(gaps.ok && gaps.value.gaps.map((gap) => [gap.kind, gap.scopeKey, gap.count])).toEqual([['telemetry-echo', 'a-1', 1]]);
  });

  it('looks up an attempt\'s contributions by attempt, not by a revision range scan (NFR-003)', () => {
    const accounting = service();
    ingest(accounting, { attemptId: 'a-1', phaseId: 'plan', measures: [...tokens(1, 1), cost('0.10')] });
    ingest(accounting, { attemptId: 'a-2', phaseId: 'implement', measures: [...tokens(2, 1), cost('0.20')] });
    const all = vi.spyOn(conn, 'all');
    const get = vi.spyOn(conn, 'get');
    okValue(accounting.query({ groupBy: ['phaseId'], filters: { backend: 'claude' }, limit: 1 }));
    const reads = [...all.mock.calls, ...get.mock.calls].filter((call) => String(call.at(0)).includes('accounting_contributions c'));
    all.mockRestore();
    get.mockRestore();
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const [sql, ...params] of reads) {
      const details = conn.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${String(sql)}`, ...(params as never[])).map((row) => row.detail);
      const firstAttemptStep = details.findIndex((detail) => / a( |$)/u.test(detail));
      const nestedContributionSteps = details.filter((detail, index) => index > firstAttemptStep && /^SEARCH c /u.test(detail));
      expect(nestedContributionSteps.length).toBeGreaterThan(0);
      for (const detail of nestedContributionSteps) expect(detail).toContain('(attempt_id=?');
    }
  });
});

describe('provider qualifications (FR-020)', () => {
  it('returns the registry, kept apart from observed data', () => {
    const accounting = service();
    ingest(accounting, { attemptId: 'a-1', measures: tokens(1, 1) });
    expect(accounting.readQualifications()).toEqual({ ok: true, value: PROVIDER_QUALIFICATIONS });
    const response = okValue(accounting.query({ groupBy: [] }));
    expect(JSON.stringify(response)).not.toContain('fixture-verified');
  });
});
