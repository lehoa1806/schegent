// FR-R6-F11 T014 — the usage view over F06 (FR-006, research R2).
//
// WHAT THIS PINS:
//   - the view delegates to F06 at one revision: the first page fixes it and every later page
//     passes it as `asOfRevision`;
//   - the engine adds no measure: each row's measures equal F06's byte for byte, reported and
//     estimated cost stay apart per currency, and an unknown cost is never a known zero;
//   - invocations are `not-recorded`, and the legacy summary sits beside the rows, never in them;
//   - a compacted revision fails `accounting-revision-unavailable`, and no accounting port is
//     `accounting-unavailable`;
//   - F06 refusals, the row cap and the signal map to report outcomes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountingResult, Provenance } from '../../../src/contracts/usage-accounting/accounting-types';
import type { AccountingQueryRequest, AccountingQueryResponse } from '../../../src/contracts/usage-accounting/query-contract';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import type {
  AccountingMeasureInput,
  AccountingObservationInput
} from '../../../src/services/usage-accounting/observation-normalizer';
import {
  type UsageAccountingService,
  createUsageAccountingService
} from '../../../src/services/usage-accounting/usage-accounting-service';
import { validateReportQuery } from '../../../src/services/reporting/report-query-validator';
import {
  type AccountingPort,
  type UsageRequest,
  readUsage,
  usageRequestOf
} from '../../../src/services/reporting/report-usage';

const NOW = '2026-11-10T12:00:00.000Z';
/** 91 days later: every 2026-11-10 event is past the 90-day retention horizon. */
const LATER_NOW = '2027-02-09T12:00:00.000Z';
const CAP = 1_000;
const DEFAULT_GROUPING: UsageRequest = { groupBy: ['backend', 'model'] };

let conn: NodeSqliteConnection;
let now = NOW;

beforeEach(() => {
  now = NOW;
  conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
});

afterEach(() => {
  conn.close();
});

function service(): UsageAccountingService {
  return createUsageAccountingService({ conn, nowUtc: () => now, monotonicMs: () => 1, workspaceId: 'ws-1', bounds: {} });
}

interface AttemptSpec {
  readonly attemptId: string;
  readonly identity?: string;
  readonly rootId?: string;
  readonly backend?: string;
  readonly model?: string;
  readonly eventUtc?: string;
  readonly measures: readonly AccountingMeasureInput[];
}

function observation(spec: AttemptSpec): AccountingObservationInput {
  return {
    producerNamespace: 'schegent.phase-end/1',
    source: 'phase-end',
    sourceKind: 'phase-end',
    sourceIdentity: spec.identity ?? `${spec.attemptId}:0`,
    rootId: spec.rootId ?? `root-${spec.attemptId}`,
    attemptId: spec.attemptId,
    invocationOrdinal: 0,
    counterScope: 'invocation-delta',
    adapterVersion: 'test/1',
    dimensions: { backend: spec.backend ?? 'claude', modelRequested: spec.model ?? 'm-1', phaseId: 'implement' },
    eventUtc: spec.eventUtc ?? '2026-11-10T11:00:00.000Z',
    observedUtc: spec.eventUtc ?? '2026-11-10T11:00:00.000Z',
    measures: spec.measures
  };
}

function ingest(accounting: UsageAccountingService, spec: AttemptSpec): number {
  const result = accounting.ingestObservation(observation(spec));
  if (!result.ok || result.value.revision === null) throw new Error('fixture ingest failed');
  return result.value.revision;
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

function seedThreeGroups(accounting: UsageAccountingService): void {
  ingest(accounting, { attemptId: 'a-1', backend: 'codex', model: 'm-1', measures: [...tokens(5, 1), cost('0.10')] });
  ingest(accounting, { attemptId: 'a-2', backend: 'claude', model: 'm-2', measures: [...tokens(7, 2), cost('0.20', 'EUR')] });
  ingest(accounting, { attemptId: 'a-3', backend: 'claude', model: 'm-1', measures: tokens(9, 3) });
}

/** A port that records every request it forwards. */
function recording(port: AccountingPort, afterFirst?: () => void) {
  const requests: (AccountingQueryRequest & { readonly limit: number })[] = [];
  const recorder: AccountingPort = {
    query(request, signal) {
      requests.push(request);
      const result = port.query(request, signal);
      if (requests.length === 1) afterFirst?.();
      return result;
    }
  };
  return { recorder, requests };
}

function refusingPort(code: string): AccountingPort {
  return {
    query: () => ({ ok: false, refusal: { code } }) as AccountingResult<AccountingQueryResponse>
  };
}

describe('FR-R6-F11 T014 — usage view', () => {
  it('copies F06 rows without touching a measure, sorted by key, invocations not-recorded', () => {
    const accounting = service();
    seedThreeGroups(accounting);
    const result = readUsage(accounting, DEFAULT_GROUPING, { cap: CAP });
    if (!result.ok) throw new Error('usage read failed');
    const direct = accounting.query({ groupBy: ['backend', 'model'], limit: 200 });
    if (!direct.ok) throw new Error('direct read failed');

    expect(result.value.revision).toBe(direct.value.revision);
    expect(result.value.rows.map((row) => row.key)).toEqual([
      { backend: 'claude', model: 'm-1' },
      { backend: 'claude', model: 'm-2' },
      { backend: 'codex', model: 'm-1' }
    ]);
    for (const row of result.value.rows) {
      expect(row.kind).toBe('usage');
      expect(row.invocations).toBe('not-recorded');
      const source = direct.value.rows.find((item) => JSON.stringify(item.key) === JSON.stringify(row.key));
      expect(JSON.stringify(row.measures)).toBe(JSON.stringify(source?.measures));
      expect(row.attempts).toBe(source?.attempts);
      expect(row.roots).toBe(source?.roots);
    }
  });

  it('keeps reported and estimated cost apart per currency, and an unknown cost is never a known zero', () => {
    const accounting = service();
    ingest(accounting, { attemptId: 'a-1', measures: [...tokens(1, 1), cost('0.50')] });
    ingest(accounting, { attemptId: 'a-2', measures: [...tokens(1, 1), cost('0.20', 'USD', 'estimated')] });
    ingest(accounting, { attemptId: 'a-3', measures: [...tokens(1, 1), cost('0.30', 'EUR')] });
    ingest(accounting, { attemptId: 'a-4', model: 'm-2', measures: tokens(1, 1) });
    const result = readUsage(accounting, DEFAULT_GROUPING, { cap: CAP });
    if (!result.ok) throw new Error('usage read failed');

    const first = result.value.rows.at(0);
    const usd = first?.measures.find((item) => item.measure === 'cost' && item.unit === 'USD');
    const eur = first?.measures.find((item) => item.measure === 'cost' && item.unit === 'EUR');
    expect(usd).toMatchObject({ reportedTotal: '0.500000', estimatedTotal: '0.200000' });
    expect(eur).toMatchObject({ reportedTotal: '0.300000' });

    const tokensOnly = result.value.rows.at(1);
    expect(tokensOnly?.key).toEqual({ backend: 'claude', model: 'm-2' });
    const knownCosts = (tokensOnly?.measures ?? []).filter((item) => item.measure === 'cost' && item.completeness === 'known');
    expect(knownCosts).toEqual([]);
  });

  it('fixes the revision on the first page and passes it as asOfRevision to every later page', () => {
    const accounting = service();
    seedThreeGroups(accounting);
    const fixed = Number(conn.scalar('SELECT max(revision) FROM accounting_revisions'));
    const { recorder, requests } = recording(accounting, () => {
      ingest(accounting, { attemptId: 'a-late', backend: 'codex', model: 'm-1', measures: tokens(100, 100) });
    });
    const result = readUsage(recorder, DEFAULT_GROUPING, { cap: CAP, pageLimit: 1 });
    if (!result.ok) throw new Error('usage read failed');

    expect(requests).toHaveLength(3);
    expect(requests.at(0)?.asOfRevision).toBeUndefined();
    expect(requests.slice(1).every((request) => request.asOfRevision === fixed && request.cursor !== undefined)).toBe(true);
    expect(requests.every((request) => request.includeLegacy === true && request.limit === 1)).toBe(true);
    expect(result.value.revision).toBe(fixed);
    expect(result.value.rows.at(2)?.attempts).toBe(1);
  });

  it('passes a captured asOfRevision on the first page too', () => {
    const accounting = service();
    const captured = ingest(accounting, { attemptId: 'a-1', measures: tokens(1, 1) });
    ingest(accounting, { attemptId: 'a-2', measures: tokens(1, 1) });
    const result = readUsage(accounting, { ...DEFAULT_GROUPING, asOfRevision: captured }, { cap: CAP });
    if (!result.ok) throw new Error('usage read failed');
    expect(result.value.revision).toBe(captured);
    expect(result.value.rows.at(0)?.attempts).toBe(1);
  });

  it('reads a captured revision 0 (nothing committed yet) as no rows, never as a refusal', () => {
    const accounting = service();
    const { recorder, requests } = recording(accounting);
    const empty = readUsage(recorder, { ...DEFAULT_GROUPING, asOfRevision: 0 }, { cap: CAP });
    if (!empty.ok) throw new Error(`usage read failed: ${JSON.stringify(empty)}`);
    expect(empty.value.revision).toBe(0);
    expect(empty.value.rows).toEqual([]);

    ingest(accounting, { attemptId: 'a-later', measures: tokens(1, 1) });
    const pinned = readUsage(recorder, { groupBy: [], rootIds: ['root-a-later'], asOfRevision: 0 }, { cap: CAP });
    if (!pinned.ok) throw new Error(`usage read failed: ${JSON.stringify(pinned)}`);
    expect(pinned.value.revision).toBe(0);
    expect(pinned.value.rows).toEqual([]);
    expect(requests.every((request) => request.asOfRevision !== 0)).toBe(true);
  });

  it('carries the legacy summary beside the rows, never in them', () => {
    const accounting = service();
    ingest(accounting, { attemptId: 'a-1', measures: [...tokens(1, 1), cost('0.10')] });
    conn.run(
      `INSERT OR REPLACE INTO accounting_legacy_epoch (epoch_id, state, imported_runs, legacy_cost_micros, started_utc)
       VALUES (1, 'complete', 3, 1250000, ?)`,
      NOW
    );
    const result = readUsage(accounting, DEFAULT_GROUPING, { cap: CAP });
    if (!result.ok) throw new Error('usage read failed');
    expect(result.value.legacy).toEqual({ runCount: 3, costMicros: '1250000', detail: 'unavailable' });
    expect(result.value.rows).toHaveLength(1);
    expect(result.value.rows.at(0)?.attempts).toBe(1);
  });

  it('maps the report query: range, backend and model filters, rootIds and groupBy', () => {
    const accounting = service();
    ingest(accounting, { attemptId: 'a-1', rootId: 'root-x', backend: 'codex', model: 'm-1', measures: tokens(1, 1) });
    ingest(accounting, { attemptId: 'a-2', rootId: 'root-y', backend: 'codex', model: 'm-1', measures: tokens(2, 2) });
    ingest(accounting, { attemptId: 'a-3', rootId: 'root-x', backend: 'claude', model: 'm-1', measures: tokens(4, 4) });
    ingest(accounting, {
      attemptId: 'a-4',
      rootId: 'root-x',
      backend: 'codex',
      model: 'm-1',
      eventUtc: '2026-10-01T00:00:00.000Z',
      measures: tokens(8, 8)
    });
    const validated = validateReportQuery(
      {
        view: 'usage',
        range: { startMs: Date.parse('2026-11-01T00:00:00.000Z'), endMs: Date.parse('2026-11-11T00:00:00.000Z') },
        filters: { rootId: ['root-x'], backend: ['codex'], model: ['m-1'] },
        groupBy: ['utcDay']
      },
      { nowMs: Date.parse(NOW), hostTimezone: 'UTC' }
    );
    if (!validated.ok) throw new Error('query refused');
    const request = usageRequestOf(validated.value);
    expect(request).toEqual({
      groupBy: ['utcDay'],
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-11T00:00:00.000Z',
      backend: 'codex',
      model: 'm-1',
      rootIds: ['root-x']
    });
    const result = readUsage(accounting, request, { cap: CAP });
    if (!result.ok) throw new Error('usage read failed');
    expect(result.value.rows).toHaveLength(1);
    expect(result.value.rows.at(0)?.key).toEqual({ utcDay: '2026-11-10' });
    expect(result.value.rows.at(0)?.measures.find((item) => item.measure === 'input_tokens')?.total).toBe('1');
  });

  it('reads an ungrouped total in one request with no cursor', () => {
    const accounting = service();
    seedThreeGroups(accounting);
    const { recorder, requests } = recording(accounting);
    const result = readUsage(recorder, { groupBy: [] }, { cap: CAP, pageLimit: 1 });
    if (!result.ok) throw new Error('usage read failed');
    expect(requests).toHaveLength(1);
    expect(result.value.rows.map((row) => row.key)).toEqual([{}]);
    expect(result.value.rows.at(0)?.attempts).toBe(3);
  });

  it('fails accounting-revision-unavailable at a compacted revision', () => {
    const accounting = service();
    const estimate = ingest(accounting, {
      attemptId: 'a-1',
      identity: 'root-a-1:estimate',
      rootId: 'root-a-1',
      measures: [cost('0.50', 'USD', 'estimated')]
    });
    ingest(accounting, { attemptId: 'a-1', identity: 'root-a-1:actual', rootId: 'root-a-1', measures: [cost('0.20')] });
    now = LATER_NOW;
    accounting.pruneExpired();
    const result = readUsage(accounting, { ...DEFAULT_GROUPING, asOfRevision: estimate }, { cap: CAP });
    expect(result).toEqual({ ok: false, outcome: 'failed', reason: 'accounting-revision-unavailable' });
  });

  it('refuses accounting-unavailable when there is no accounting port', () => {
    expect(readUsage(null, DEFAULT_GROUPING, { cap: CAP })).toEqual({
      ok: false,
      outcome: 'refused',
      reason: 'accounting-unavailable'
    });
  });

  it('ends limited snapshot-rows past the row cap', () => {
    const accounting = service();
    seedThreeGroups(accounting);
    expect(readUsage(accounting, DEFAULT_GROUPING, { cap: 2, pageLimit: 1 })).toEqual({
      ok: false,
      outcome: 'limited',
      limit: 'snapshot-rows'
    });
  });

  it('maps F06 refusals and the signal to report outcomes', () => {
    expect(readUsage(refusingPort('deadline-exceeded'), DEFAULT_GROUPING, { cap: CAP })).toEqual({
      ok: false,
      outcome: 'limited',
      limit: 'deadline-exceeded'
    });
    expect(readUsage(refusingPort('response-too-large'), DEFAULT_GROUPING, { cap: CAP })).toEqual({
      ok: false,
      outcome: 'limited',
      limit: 'working-data'
    });
    expect(readUsage(refusingPort('store-unavailable'), DEFAULT_GROUPING, { cap: CAP })).toEqual({
      ok: false,
      outcome: 'refused',
      reason: 'accounting-unavailable'
    });
    for (const code of ['store-error', 'aggregate-overflow', 'invalid-query']) {
      expect(readUsage(refusingPort(code), DEFAULT_GROUPING, { cap: CAP })).toEqual({
        ok: false,
        outcome: 'failed',
        reason: 'source-read-failed'
      });
    }
    const controller = new AbortController();
    controller.abort();
    const accounting = service();
    expect(readUsage(accounting, DEFAULT_GROUPING, { cap: CAP, signal: controller.signal })).toEqual({
      ok: false,
      outcome: 'cancelled'
    });
    expect(readUsage(refusingPort('deadline-exceeded'), DEFAULT_GROUPING, { cap: CAP, signal: controller.signal })).toEqual({
      ok: false,
      outcome: 'cancelled'
    });
  });
});
