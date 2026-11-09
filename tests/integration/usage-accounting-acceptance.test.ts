// FR-R6-F06 (T051) — acceptance criteria F06-AC-01..F06-AC-09, one case each, plus SC-003/NFR-005.
//
// Every case runs against a real temp workspace: a file-backed SQLite store bootstrapped through
// `SchemaBootstrapService`, and the accounting facade over it. A restart is a second connection
// opened on the same database file. The one injected fault is the projection failpoint (AC-07),
// the test seam the facade exposes because a crash between two statements cannot be produced on
// demand.
//
// The NFR-003 query budget is owned by tests/perf/usage-accounting-query.test.ts.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CMD_READ_USAGE_ACCOUNTING } from '../../src/contracts/sidebar-ipc';
import type { CommandAckMessage, ReadUsageAccountingCommand, UsageAccountingReader } from '../../src/contracts/sidebar-ipc';
import type { AccountingQueryResponse } from '../../src/contracts/usage-accounting/query-contract';
import {
  createUsageAccountingReader,
  queryUsageAccounting,
  readUsageAccountingGaps,
  readUsageAccountingQualifications
} from '../../src/headless/usage-accounting-api';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../src/services/sqlite-store';
import { metricsRollupLegacySource } from '../../src/services/usage-accounting/legacy-epoch';
import type { AccountingObservationInput } from '../../src/services/usage-accounting/observation-normalizer';
import { PhaseEndCorrelator } from '../../src/services/usage-accounting/phase-end-ingestion';
import { readOpenContributions } from '../../src/services/usage-accounting/projection';
import {
  type UsageAccountingService,
  type UsageAccountingServiceDeps,
  createUsageAccountingService
} from '../../src/services/usage-accounting/usage-accounting-service';
import { handler } from '../../src/ui/sidebar/commands/cmd-read-usage-accounting';
import { ACP_ATTEMPT, acpBinding, acpUpdate } from '../fixtures/usage-accounting/acp-usage-updates';
import {
  LEGACY_RUN_COUNT,
  legacyCostMicros,
  legacyRunId,
  writeLegacyRollup
} from '../fixtures/usage-accounting/legacy-rollup';
import { CLAUDE_ATTEMPT, CLAUDE_PHASE_END, cliInvocationRow, phaseEndRow } from '../fixtures/usage-accounting/phase-end-rows';

const NOW = '2026-11-10T12:00:00.000Z';
const QUERY = { groupBy: [], from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' };
const ROOT = 'run-acceptance-1';
const ATTEMPTS = [
  '8d4f5061-7283-4d94-aea5-cf1607182901',
  '9e506172-8394-4ea5-bfb6-d02718293a02',
  'af617283-94a5-4fb6-80c7-e1382930ab03'
] as const;
const INVOCATIONS_PER_ATTEMPT = 4;
const SHUFFLE_SEED = 20261110;

/** SC-003 / NFR-005: money additions, corrections, and the fractional digits a value may carry. */
const MONEY_ADDITIONS = 100_000;
const MONEY_CORRECTIONS = 1_000;
const MAX_MONEY_SCALE = 6;
const MAX_WHOLE_UNITS = 1_000;
const MICROS_PER_UNIT = 1_000_000n;
const DRIFT_TIMEOUT_MS = 600_000;

let workspaceRoot: string;
const opened: NodeSqliteConnection[] = [];

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'f06-acceptance-'));
});

afterEach(() => {
  for (const conn of opened.splice(0)) if (conn.db.isOpen) conn.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function openStore(name = 'schegent.db'): NodeSqliteConnection {
  const conn = new NodeSqliteConnection({ databasePath: join(workspaceRoot, name) });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
  opened.push(conn);
  return conn;
}

function serviceOn(
  conn: NodeSqliteConnection,
  extra: Partial<Omit<UsageAccountingServiceDeps, 'conn'>> = {}
): UsageAccountingService {
  return createUsageAccountingService({ conn, nowUtc: () => NOW, monotonicMs: () => 1, workspaceId: 'ws-1', ...extra });
}

function answerOf(service: UsageAccountingService, request: unknown = QUERY): AccountingQueryResponse {
  const answer = service.query(request);
  if (!answer.ok) throw new Error(`query refused: ${answer.refusal.code}`);
  return answer.value;
}

function measureOf(answer: AccountingQueryResponse, measure: string) {
  return answer.rows.at(0)?.measures.find((item) => item.measure === measure);
}

function count(conn: NodeSqliteConnection, sql: string): number {
  return Number(conn.scalar(sql) ?? 0);
}

function observation(overrides: Partial<AccountingObservationInput> = {}): AccountingObservationInput {
  return {
    producerNamespace: 'schegent.phase-end/1',
    source: 'phase-end',
    sourceKind: 'phase-end',
    sourceIdentity: `${ROOT}:phase-a:0`,
    rootId: ROOT,
    attemptId: ATTEMPTS[0],
    invocationOrdinal: 0,
    counterScope: 'invocation-delta',
    adapterVersion: 'claude/1',
    dimensions: { backend: 'claude', modelReported: 'claude-opus-5-5', phaseId: 'phase-a' },
    eventUtc: '2026-11-10T10:00:00.000Z',
    observedUtc: '2026-11-10T10:00:01.000Z',
    measures: [
      { measure: 'input_tokens', quantity: 100, unit: 'count', provenance: 'provider-reported' },
      { measure: 'output_tokens', quantity: 40, unit: 'count', provenance: 'provider-reported' }
    ],
    ...overrides
  };
}

function ingested(service: UsageAccountingService, input: AccountingObservationInput): string {
  const result = service.ingestObservation(input);
  if (!result.ok) throw new Error(`ingest refused: ${result.refusal.code}`);
  return result.value.observationId;
}

/** A deterministic Fisher-Yates shuffle (an LCG), so a red run reproduces. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const pick = state % (index + 1);
    const held = out.at(index) as T;
    out[index] = out.at(pick) as T;
    out[pick] = held;
  }
  return out;
}

/** Three attempts of one root, four invocations each, every figure distinct. */
function stream(): AccountingObservationInput[] {
  const length = ATTEMPTS.length * INVOCATIONS_PER_ATTEMPT;
  return Array.from({ length }, (_, index) => {
    const attemptId = ATTEMPTS.at(index % ATTEMPTS.length) as string;
    const ordinal = Math.floor(index / ATTEMPTS.length);
    const minute = String(index).padStart(2, '0');
    return observation({
      sourceIdentity: `${ROOT}:${attemptId}:${ordinal}`,
      attemptId,
      invocationOrdinal: ordinal,
      eventUtc: `2026-11-10T10:${minute}:00.000Z`,
      observedUtc: `2026-11-10T10:${minute}:01.000Z`,
      measures: [
        { measure: 'input_tokens', quantity: 100 + index, unit: 'count', provenance: 'provider-reported' },
        { measure: 'output_tokens', quantity: 7 * (index + 1), unit: 'count', provenance: 'provider-reported' },
        { measure: 'cost', quantity: `0.0${String(index + 10)}`, unit: 'USD', provenance: 'provider-reported' }
      ]
    });
  });
}

/** The projection with the order-dependent fields (ids, revisions) left out. */
function canonicalOf(conn: NodeSqliteConnection) {
  const contributions = readOpenContributions(conn).map((row) => ({
    attemptId: row.attemptId,
    invocationOrdinal: row.invocationOrdinal,
    measure: row.measure,
    unit: row.unit,
    quantity: row.quantity === null ? null : String(row.quantity),
    completeness: row.completeness,
    provenance: row.provenance,
    costOrigin: row.costOrigin
  }));
  return { rows: answerOf(serviceOn(conn)).rows, contributions };
}

function phaseEndSnapshot(row: ReturnType<typeof phaseEndRow>, runId = 'run-f06-1') {
  const correlator = new PhaseEndCorrelator();
  correlator.observe(cliInvocationRow({ runId }));
  const snapshot = correlator.observe(row);
  if (snapshot === undefined) throw new Error('no snapshot');
  return snapshot;
}

function sidebarAck(reader: UsageAccountingReader | undefined, query: unknown) {
  const acks: (CommandAckMessage & { result?: unknown })[] = [];
  const ctx = {
    deps: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: (text: string) => text },
      ...(reader === undefined ? {} : { usageAccounting: reader })
    },
    postAck: async (message: CommandAckMessage) => {
      acks.push(message);
      return true;
    },
    correlationId: 'f06-acceptance-1'
  } as unknown as Parameters<typeof handler>[0];
  const command = {
    type: CMD_READ_USAGE_ACCOUNTING,
    correlationId: 'f06-acceptance-1',
    payload: { query }
  } as ReadUsageAccountingCommand;
  return { run: () => handler(ctx, command), acks };
}

/** A non-negative decimal with 0..6 fractional digits, and its exact micro-units. */
function randomMoney(next: () => number): { text: string; micros: bigint } {
  const whole = Math.floor(next() * MAX_WHOLE_UNITS);
  const scale = Math.floor(next() * (MAX_MONEY_SCALE + 1));
  const fraction = scale === 0 ? '' : String(Math.floor(next() * 10 ** scale)).padStart(scale, '0');
  const text = scale === 0 ? String(whole) : `${String(whole)}.${fraction}`;
  const fractionMicros = scale === 0 ? 0n : BigInt(fraction) * 10n ** BigInt(MAX_MONEY_SCALE - scale);
  return { text, micros: BigInt(whole) * MICROS_PER_UNIT + fractionMicros };
}

function formatMicros(micros: bigint): string {
  const whole = micros / MICROS_PER_UNIT;
  const fraction = (micros % MICROS_PER_UNIT).toString().padStart(MAX_MONEY_SCALE, '0');
  return `${whole.toString()}.${fraction}`;
}

/** A seeded uniform generator in [0, 1). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('usage accounting acceptance (T051)', () => {
  it('F06-AC-01: duplicate, out-of-order and replayed observations project as the canonical order does', () => {
    const canonical = openStore('canonical.db');
    const canonicalService = serviceOn(canonical);
    for (const item of stream()) ingested(canonicalService, item);
    const expected = canonicalOf(canonical);
    expect(expected.rows.at(0)).toMatchObject({ attempts: ATTEMPTS.length, roots: 1 });

    const live = shuffled(stream(), SHUFFLE_SEED);
    const half = live.length / 2;
    const first = openStore();
    const firstService = serviceOn(first);
    for (const item of [...live.slice(0, half), ...live.slice(0, half)]) firstService.ingestObservation(item);
    first.close();

    const reopened = openStore();
    const reopenedService = serviceOn(reopened);
    const dispositions = shuffled(stream(), SHUFFLE_SEED + 1).map((item) => {
      const result = reopenedService.ingestObservation(item);
      return result.ok ? result.value.disposition : result.refusal.code;
    });
    expect(dispositions.filter((value) => value === 'duplicate')).toHaveLength(half);
    expect(dispositions.filter((value) => value === 'accepted')).toHaveLength(live.length - half);
    expect(canonicalOf(reopened)).toStrictEqual(expected);
  });

  it('F06-AC-02: a cumulative cost with no baseline is unknown, never the full figure', () => {
    const conn = openStore();
    const service = serviceOn(conn);
    const absent = phaseEndRow({ payload: { attemptId: CLAUDE_ATTEMPT, totalCostUsd: 7.25, inputTokens: 300 } });
    expect(service.ingestPhaseEnd(phaseEndSnapshot(absent))).toMatchObject({ ok: true, value: { disposition: 'accepted' } });

    const answer = answerOf(service);
    const cost = measureOf(answer, 'cost');
    expect(cost).toMatchObject({ completeness: 'unknown', coverage: { known: 0, denominator: 1 } });
    expect(cost?.total).not.toBe('7.250000');
    expect(measureOf(answer, 'input_tokens')).toMatchObject({ total: '300', completeness: 'known' });
    expect(conn.scalar("SELECT unknown_reason FROM accounting_observation_measures WHERE measure = 'cost'")).toBe(
      'unattributed-session-baseline'
    );

    const subtracted = serviceOn(openStore('subtracted.db'));
    subtracted.ingestPhaseEnd(phaseEndSnapshot(CLAUDE_PHASE_END));
    expect(measureOf(answerOf(subtracted), 'cost')).toMatchObject({ total: '0.412500', completeness: 'known' });
  });

  it('F06-AC-03: an overlapping source corroborates instead of adding, and a telemetry echo is refused', () => {
    const conn = openStore();
    const service = serviceOn(conn);
    ingested(service, observation());
    const overlap = service.ingestObservation(
      observation({ source: 'fixture', sourceKind: 'fixture', producerNamespace: 'schegent.fixture/1', sourceIdentity: 'fixture:evt-1' })
    );
    if (!overlap.ok) throw new Error(overlap.refusal.code);
    // FR-008: the projection, not admission, decides the evidence; the stored row carries it.
    expect(
      conn.scalar(`SELECT disposition FROM accounting_observations WHERE observation_id = '${overlap.value.observationId}'`)
    ).toBe('corroborating');
    expect(measureOf(answerOf(service), 'input_tokens')).toMatchObject({ total: '100', completeness: 'known' });

    const before = count(conn, 'SELECT count(*) FROM accounting_observations');
    const echo = service.ingestObservation(
      observation({ producerNamespace: 'schegent.export/otel', sourceIdentity: 'otel:evt-1' })
    );
    expect(echo).toMatchObject({ ok: false, refusal: { code: 'telemetry-echo' } });
    expect(count(conn, 'SELECT count(*) FROM accounting_observations')).toBe(before);
    expect(measureOf(answerOf(service), 'input_tokens')?.total).toBe('100');
    const gaps = service.readGaps({});
    if (!gaps.ok) throw new Error(gaps.refusal.code);
    expect(gaps.value.gaps.filter((gap) => gap.kind === 'telemetry-echo').map((gap) => gap.count)).toStrictEqual([1]);
  });

  it('F06-AC-04: retries and repairs count once per attempt, and the root once', () => {
    const conn = openStore();
    const service = serviceOn(conn);
    const outcomes = ['failed', 'failed', 'succeeded'] as const;
    ATTEMPTS.forEach((attemptId, index) => {
      const usage = observation({
        attemptId,
        sourceIdentity: `${ROOT}:${attemptId}:0`,
        eventUtc: `2026-11-10T1${String(index)}:00:00.000Z`,
        measures: [{ measure: 'input_tokens', quantity: 100 * (index + 1), unit: 'count', provenance: 'provider-reported' }]
      });
      ingested(service, usage);
      expect(service.ingestObservation(usage)).toMatchObject({ ok: true, value: { disposition: 'duplicate' } });
      service.recordAttemptOutcome({ attemptId, outcome: outcomes[index] });
    });
    const failed = service.recordRootOutcome({ rootId: ROOT, outcome: 'failed', terminalUtc: '2026-11-10T10:30:00.000Z' });
    const succeeded = service.recordRootOutcome({ rootId: ROOT, outcome: 'succeeded', terminalUtc: '2026-11-10T12:30:00.000Z' });
    expect(service.recordRootOutcome({ rootId: ROOT, outcome: 'succeeded', terminalUtc: '2026-11-10T12:30:00.000Z' })).toStrictEqual(
      succeeded
    );
    expect(failed.ok && succeeded.ok).toBe(true);

    const answer = answerOf(service);
    expect(answer.rows).toHaveLength(1);
    expect(answer.rows.at(0)).toMatchObject({ attempts: ATTEMPTS.length, roots: 1 });
    expect(measureOf(answer, 'input_tokens')?.total).toBe('600');
    expect(count(conn, 'SELECT count(*) FROM accounting_root_outcomes')).toBe(2);
    const failedOnly = answerOf(service, { ...QUERY, filters: { attemptOutcome: 'failed' } });
    expect(failedOnly.rows.at(0)).toMatchObject({ attempts: 2, roots: 1 });
  });

  it('F06-AC-05: a correction creates a new revision, and the earlier revision stays reproducible after a restart', () => {
    const store = openStore();
    const service = serviceOn(store);
    const target = ingested(service, observation());
    const before = answerOf(service);

    const corrected = service.applyCorrection({
      targetObservationId: target,
      measure: 'input_tokens',
      replacementQuantity: 60,
      unit: 'count',
      reasonCode: 'provider-revision',
      actor: 'provider'
    });
    expect(corrected).toMatchObject({ ok: true, value: { revision: before.revision + 1 } });
    const after = answerOf(service);
    expect(after.revision).toBe(before.revision + 1);
    expect(measureOf(after, 'input_tokens')?.total).toBe('60');

    store.close();
    const reopened = serviceOn(openStore());
    expect(answerOf(reopened, { ...QUERY, asOfRevision: before.revision })).toStrictEqual(before);
    expect(answerOf(reopened)).toStrictEqual(after);
  });

  it('F06-AC-06: the legacy epoch is imported once, kept apart from observed totals, and never overlaps', async () => {
    await writeLegacyRollup(workspaceRoot);
    const conn = openStore();
    const service = serviceOn(conn);
    ingested(service, observation({ measures: [{ measure: 'cost', quantity: '0.5', unit: 'USD', provenance: 'provider-reported' }] }));
    const source = metricsRollupLegacySource(workspaceRoot);

    const first = await service.importLegacyEpoch(source);
    expect(first).toStrictEqual({ ok: true, value: { state: 'complete', importedRuns: LEGACY_RUN_COUNT, reconciliation: 'matched' } });
    expect(await serviceOn(conn).importLegacyEpoch(source)).toStrictEqual(first);
    expect(count(conn, "SELECT count(*) FROM accounting_revisions WHERE cause = 'legacy-import'")).toBe(1);

    const answer = answerOf(service, { ...QUERY, includeLegacy: true });
    expect(measureOf(answer, 'cost')?.total).toBe('0.500000');
    expect(answer.legacy).toMatchObject({ runCount: LEGACY_RUN_COUNT, costMicros: String(legacyCostMicros()) });
    expect(answerOf(service).legacy).toBeUndefined();
    expect(service.recordRootOutcome({ rootId: legacyRunId(5), outcome: 'succeeded', terminalUtc: NOW })).toStrictEqual({
      ok: false,
      refusal: { code: 'legacy-epoch-overlap' }
    });
  });

  it('F06-AC-07: a crash between the fact and its projection is recovered by the rebuild after a restart', () => {
    const clean = openStore('clean.db');
    const cleanService = serviceOn(clean);
    for (const item of stream()) ingested(cleanService, item);
    const expected = canonicalOf(clean);

    const crashed = openStore();
    const failing = serviceOn(crashed, {
      projectionFailpoint: () => {
        throw new Error('injected crash');
      }
    });
    for (const item of stream()) {
      expect(failing.ingestObservation(item)).toMatchObject({ ok: true, value: { disposition: 'accepted', revision: null } });
    }
    expect(count(crashed, "SELECT count(*) FROM accounting_projection_intents WHERE state = 'pending'")).toBe(stream().length);
    expect(count(crashed, 'SELECT count(*) FROM accounting_contributions')).toBe(0);
    crashed.close();

    const reopened = openStore();
    serviceOn(reopened);
    expect(count(reopened, "SELECT count(*) FROM accounting_projection_intents WHERE state = 'pending'")).toBe(0);
    expect(canonicalOf(reopened)).toStrictEqual(expected);
  });

  it('F06-AC-08: the headless and sidebar reads answer identically, and the null reader is store-unavailable', async () => {
    const service = serviceOn(openStore());
    for (const item of stream()) ingested(service, item);
    const reader = createUsageAccountingReader(service);
    const grouped = { ...QUERY, groupBy: ['backend', 'phaseId'] };

    for (const query of [QUERY, grouped, { ...QUERY, limit: 0 }]) {
      const headless = queryUsageAccounting(reader, query);
      const sidebar = sidebarAck(reader, query);
      await sidebar.run();
      expect(sidebar.acks).toHaveLength(1);
      expect(sidebar.acks.at(0)?.result).toStrictEqual(headless);
    }
    expect(queryUsageAccounting(reader, QUERY)).toMatchObject({ ok: true });

    const unavailable = { ok: false, refusal: { code: 'store-unavailable' } };
    const productionReader = createUsageAccountingReader(null);
    expect(queryUsageAccounting(productionReader, QUERY)).toStrictEqual(unavailable);
    expect(readUsageAccountingGaps(productionReader, {})).toStrictEqual(unavailable);
    expect(readUsageAccountingQualifications(productionReader)).toStrictEqual(unavailable);
    const sidebar = sidebarAck(productionReader, QUERY);
    await sidebar.run();
    expect(sidebar.acks.at(0)).toMatchObject({ status: 'rejected', reason: 'store-unavailable', result: unavailable });
  });

  it('F06-AC-09: ACP occupancy is never billable, credits stay credits, and an identity-less replay is historical', () => {
    const conn = openStore();
    const service = serviceOn(conn);
    expect(service.ingestAcpUsageUpdate(acpUpdate(), acpBinding())).toMatchObject({ ok: true, value: { disposition: 'accepted' } });
    expect(
      service.ingestAcpUsageUpdate(
        acpUpdate({
          turnId: 'turn-2',
          producerEventId: 'evt-2',
          hostReceiveSeq: 2,
          credits: { amount: '3.5', unit: 'acme.credits' },
          hasQualifiedSessionBaseline: true
        }),
        acpBinding({ turnId: 'turn-2' })
      )
    ).toMatchObject({ ok: true });

    const answer = answerOf(service);
    const measures = new Set(answer.rows.flatMap((row) => row.measures.map((item) => item.measure)));
    for (const billable of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens']) {
      expect(measures.has(billable as never)).toBe(false);
    }
    expect(measureOf(answer, 'credits')).toMatchObject({ unit: 'acme.credits', total: '3.500000' });
    expect(measureOf(answer, 'cost')?.total ?? '0.000000').toBe('0.000000');

    const replay = service.ingestAcpUsageUpdate(
      acpUpdate({ replayed: true, producerEventId: undefined, turnId: 'turn-3', cost: { amount: '1', currency: 'USD' } }),
      acpBinding({ turnId: 'turn-3' })
    );
    expect(replay).toMatchObject({ ok: true, value: { disposition: 'historical' } });
    expect(answerOf(service).rows).toStrictEqual(answer.rows);
    expect(count(conn, `SELECT count(*) FROM accounting_attempts WHERE attempt_id = '${ACP_ATTEMPT}'`)).toBe(1);
  });

  it(
    'SC-003 / NFR-005: 100,000 money additions and 1,000 corrections at scales 0..6 total exactly',
    () => {
      const conn = openStore();
      const service = serviceOn(conn);
      const next = seededRandom(SHUFFLE_SEED);
      const quantities: bigint[] = [];
      const ids: string[] = [];
      for (let index = 0; index < MONEY_ADDITIONS; index += 1) {
        const money = randomMoney(next);
        quantities.push(money.micros);
        ids.push(
          ingested(
            service,
            observation({
              sourceIdentity: `${ROOT}:money:${String(index)}`,
              invocationOrdinal: index,
              measures: [{ measure: 'cost', quantity: money.text, unit: 'USD', provenance: 'provider-reported' }]
            })
          )
        );
      }

      const corrected = new Set<number>();
      while (corrected.size < MONEY_CORRECTIONS) corrected.add(Math.floor(next() * MONEY_ADDITIONS));
      for (const index of corrected) {
        const money = randomMoney(next);
        const result = service.applyCorrection({
          targetObservationId: ids.at(index),
          measure: 'cost',
          replacementQuantity: money.text,
          unit: 'USD',
          reasonCode: 'provider-revision',
          actor: 'provider'
        });
        if (!result.ok) throw new Error(`correction refused: ${result.refusal.code}`);
        quantities[index] = money.micros;
      }

      const expected = quantities.reduce((sum, micros) => sum + micros, 0n);
      expect(measureOf(answerOf(service), 'cost')).toMatchObject({ total: formatMicros(expected), completeness: 'known' });
    },
    DRIFT_TIMEOUT_MS
  );
});

