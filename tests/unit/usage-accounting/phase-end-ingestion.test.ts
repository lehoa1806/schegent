/**
 * FR-R6-F06 (T023, FR-001, FR-002, FR-005, FR-020, research R3, R4, R9) — a `phase-end` audit
 * row becomes one accounting observation, and nothing but the copied fields reaches the store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import { F06_ACCOUNTING_TABLE_NAMES } from '../../../src/services/usage-accounting/accounting-schema';
import {
  PhaseEndCorrelator,
  attemptOutcomeOf,
  phaseEndObservation
} from '../../../src/services/usage-accounting/phase-end-ingestion';
import { createUsageAccountingService } from '../../../src/services/usage-accounting/usage-accounting-service';
import {
  CLAUDE_ATTEMPT,
  CLAUDE_PHASE_END,
  CODEX_INVOCATION,
  CODEX_PHASE_END,
  LEAK_MARKERS,
  cliInvocationRow,
  phaseEndRow
} from '../../fixtures/usage-accounting/phase-end-rows';

const NOW = '2026-11-10T12:00:00.000Z';

let conn: NodeSqliteConnection;

beforeEach(() => {
  conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
});

afterEach(() => {
  if (conn.db.isOpen) conn.close();
});

function service() {
  return createUsageAccountingService({ conn, nowUtc: () => NOW, monotonicMs: () => 1, workspaceId: 'ws-1' });
}

function snapshotOf(...rows: Parameters<PhaseEndCorrelator['observe']>[0][]) {
  const correlator = new PhaseEndCorrelator();
  let last;
  for (const row of rows) last = correlator.observe(row);
  if (last === undefined) throw new Error('no snapshot');
  return last;
}

function measure(observation: ReturnType<typeof phaseEndObservation>, name: string) {
  const found = observation.measures.find((item) => item.measure === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
}

describe('phase-end ingestion (T023)', () => {
  it('maps a Claude row with nested metrics to tokens, disjoint caches and a derived cost', () => {
    const snapshot = snapshotOf(cliInvocationRow({}), CLAUDE_PHASE_END);
    expect(snapshot.backend).toBe('claude');
    expect(snapshot.model).toBe('claude-opus-5-5');
    const observation = phaseEndObservation(snapshot, NOW);
    expect(observation.attemptId).toBe(CLAUDE_ATTEMPT);
    expect(observation.rootId).toBe('run-f06-1');
    expect(observation.counterScope).toBe('invocation-delta');
    expect(measure(observation, 'input_tokens')).toMatchObject({ quantity: 1500, unit: 'count', provenance: 'provider-reported' });
    expect(measure(observation, 'output_tokens')).toMatchObject({ quantity: 300 });
    expect(measure(observation, 'cache_read_tokens')).toMatchObject({ quantity: 900, cacheRelation: 'disjoint' });
    expect(measure(observation, 'cache_creation_tokens')).toMatchObject({ quantity: 200, cacheRelation: 'disjoint' });
    expect(measure(observation, 'cost')).toMatchObject({ quantity: '0.412500', unit: 'USD', provenance: 'derived' });

    const result = service().ingestObservation(observation);
    expect(result.ok && result.value.disposition).toBe('accepted');
  });

  it('maps a Codex flat row to subset-of-input cache and an unknown cost', () => {
    const observation = phaseEndObservation(snapshotOf(CODEX_INVOCATION, CODEX_PHASE_END), NOW);
    expect(observation.dimensions?.backend).toBe('codex');
    expect(measure(observation, 'input_tokens')).toMatchObject({ quantity: 800 });
    expect(measure(observation, 'cache_read_tokens')).toMatchObject({ quantity: 500, cacheRelation: 'subset-of-input' });
    expect(measure(observation, 'cache_creation_tokens')).toMatchObject({ quantity: null, unknownReason: 'not-reported' });
    expect(measure(observation, 'cost')).toMatchObject({ quantity: null, unknownReason: 'not-reported' });
  });

  it('keeps a session-cumulative cost unknown unless the baseline was subtracted', () => {
    const below = phaseEndRow({ payload: { attemptId: CLAUDE_ATTEMPT, costBaseline: 'below-baseline', totalCostUsd: 1 } });
    const absent = phaseEndRow({ payload: { attemptId: CLAUDE_ATTEMPT, totalCostUsd: 1 } });
    const belowCost = measure(phaseEndObservation(snapshotOf(cliInvocationRow({}), below), NOW), 'cost');
    const absentCost = measure(phaseEndObservation(snapshotOf(cliInvocationRow({}), absent), NOW), 'cost');
    expect(belowCost).toMatchObject({ quantity: null, unknownReason: 'cumulative-reset' });
    expect(absentCost).toMatchObject({ quantity: null, unknownReason: 'unattributed-session-baseline' });
  });

  it('treats a row with no preceding invocation as an unqualified backend', () => {
    const observation = phaseEndObservation(snapshotOf(CLAUDE_PHASE_END), NOW);
    expect(observation.dimensions?.backend).toBeNull();
    expect(measure(observation, 'cache_read_tokens')).toMatchObject({ quantity: 900, cacheRelation: 'unknown' });
    expect(measure(observation, 'cost')).toMatchObject({ quantity: null, unknownReason: 'unqualified-backend' });
  });

  it('holds a row with no attemptId unattributed', () => {
    const row = phaseEndRow({ payload: { inputTokens: 5 } });
    const observation = phaseEndObservation(snapshotOf(cliInvocationRow({}), row), NOW);
    expect(observation.attemptId).toBeNull();
    expect(observation.sourceIdentity).toBeNull();
    const result = service().ingestObservation(observation);
    expect(result.ok && result.value.disposition).toBe('unattributed');
  });

  it('records a rejected token value as unknown', () => {
    const row = phaseEndRow({ payload: { attemptId: CLAUDE_ATTEMPT, outputTokens: -3 } });
    const observation = phaseEndObservation(snapshotOf(cliInvocationRow({}), row), NOW);
    expect(measure(observation, 'output_tokens')).toMatchObject({ quantity: null, unknownReason: 'rejected-value' });
  });

  it('never stores prompt text, paths or error text', () => {
    const invocation = cliInvocationRow({ payload: { prompt: LEAK_MARKERS.prompt, cwd: LEAK_MARKERS.path } });
    const row = phaseEndRow({
      payload: {
        attemptId: CLAUDE_ATTEMPT,
        costBaseline: 'subtracted',
        totalCostUsd: 0.1,
        inputTokens: 10,
        prompt: LEAK_MARKERS.prompt,
        filesCreated: [LEAK_MARKERS.path],
        error: LEAK_MARKERS.error,
        phaseId: LEAK_MARKERS.path,
        model: LEAK_MARKERS.prompt
      }
    });
    const accounting = service();
    const ingested = accounting.ingestPhaseEnd(snapshotOf(invocation, row));
    expect(ingested.ok).toBe(true);
    const dump = JSON.stringify(
      F06_ACCOUNTING_TABLE_NAMES.map((table) => conn.all(`SELECT * FROM ${table}`)),
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)
    );
    expect(dump).toContain(CLAUDE_ATTEMPT);
    for (const marker of Object.values(LEAK_MARKERS)) expect(dump).not.toContain(marker);
    expect(dump).not.toContain('LEAK');
  });

  it('derives the source identity from run, phase, attempt and iteration', () => {
    const first = phaseEndObservation(snapshotOf(cliInvocationRow({}), CLAUDE_PHASE_END), NOW);
    const second = phaseEndObservation(snapshotOf(cliInvocationRow({}), CLAUDE_PHASE_END), '2026-11-10T13:00:00.000Z');
    expect(first.sourceIdentity).toBe(`run-f06-1:implement:${CLAUDE_ATTEMPT}:1`);
    expect(second.sourceIdentity).toBe(first.sourceIdentity);
    const third = phaseEndObservation(
      snapshotOf(cliInvocationRow({ iteration: 2 }), phaseEndRow({ iteration: 2, payload: { attemptId: CLAUDE_ATTEMPT } })),
      NOW
    );
    expect(third.sourceIdentity).toBe(`run-f06-1:implement:${CLAUDE_ATTEMPT}:2`);

    const accounting = service();
    expect(accounting.ingestObservation(first).ok).toBe(true);
    const replay = accounting.ingestObservation(second);
    expect(replay.ok && replay.value.disposition).toBe('duplicate');
  });

  it('ignores other event types, and bounds the invocation context it holds', () => {
    const correlator = new PhaseEndCorrelator(2);
    expect(correlator.observe({ ...CLAUDE_PHASE_END, eventType: 'phase-start' })).toBeUndefined();
    expect(correlator.observe(cliInvocationRow({ runId: 'r-a' }))).toBeUndefined();
    correlator.observe(cliInvocationRow({ runId: 'r-b' }));
    correlator.observe(cliInvocationRow({ runId: 'r-c' }));
    expect(correlator.size).toBe(2);
    const evicted = correlator.observe(phaseEndRow({ runId: 'r-a', payload: { attemptId: CLAUDE_ATTEMPT } }));
    expect(evicted?.backend).toBeNull();
    const kept = correlator.observe(phaseEndRow({ runId: 'r-c', payload: { attemptId: CLAUDE_ATTEMPT } }));
    expect(kept?.backend).toBe('claude');
    expect(correlator.size).toBe(1);
  });

  it('maps phase-end outcomes onto the attempt vocabulary', () => {
    expect(attemptOutcomeOf('clean')).toBe('succeeded');
    expect(attemptOutcomeOf('issues_remain')).toBe('succeeded');
    expect(attemptOutcomeOf('failed')).toBe('failed');
    expect(attemptOutcomeOf('rate-limited')).toBe('failed');
    expect(attemptOutcomeOf('skipped')).toBe('cancelled');
    expect(attemptOutcomeOf('paused-at-breakpoint')).toBe('interrupted');
    expect(attemptOutcomeOf('malformed')).toBe('unknown');
    expect(attemptOutcomeOf(42)).toBe('unknown');
  });
});
