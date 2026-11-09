/**
 * FR-R6-F06 (T040, FR-012, US2 scenarios 1-4) — one invocation counts once, however often it is
 * delivered; attempts count separately under one root; an uncorrelated observation is never
 * assigned by timing; and replay order never changes the projection.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import type { AccountingObservationInput } from '../../../src/services/usage-accounting/observation-normalizer';
import { readOpenContributions } from '../../../src/services/usage-accounting/projection';
import { createUsageAccountingService } from '../../../src/services/usage-accounting/usage-accounting-service';

const NOW = '2026-11-10T12:00:00.000Z';
const QUERY = { groupBy: ['backend'], from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' };
const ROOT = 'run-count-1';
const FIRST_ATTEMPT = '5a1c2d3e-4f50-4a61-8b72-9c83d4e5f601';
const SECOND_ATTEMPT = '6b2d3e4f-5061-4b72-9c83-ad94e5f60702';
const STREAM_LENGTH = 30;
const STREAM_ATTEMPTS = 3;
const SHUFFLE_SEED = 20261110;

let conn: NodeSqliteConnection;
const tempDirs: string[] = [];

beforeEach(() => {
  conn = openStore(':memory:');
});

afterEach(() => {
  if (conn.db.isOpen) conn.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function openStore(databasePath: string): NodeSqliteConnection {
  const opened = new NodeSqliteConnection({ databasePath });
  SchemaBootstrapService.bootstrapAndMigrate(opened, () => Date.parse(NOW));
  return opened;
}

function serviceOn(target: NodeSqliteConnection) {
  return createUsageAccountingService({ conn: target, nowUtc: () => NOW, monotonicMs: () => 1, workspaceId: 'ws-1' });
}

function observation(overrides: Partial<AccountingObservationInput> = {}): AccountingObservationInput {
  return {
    producerNamespace: 'schegent.phase-end/1',
    source: 'phase-end',
    sourceKind: 'phase-end',
    sourceIdentity: `${ROOT}:phase-a:0`,
    rootId: ROOT,
    attemptId: FIRST_ATTEMPT,
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

function count(target: NodeSqliteConnection, sql: string): number {
  return Number(target.scalar(sql) ?? 0);
}

function answerOf(target: NodeSqliteConnection) {
  const answer = serviceOn(target).query(QUERY);
  if (!answer.ok) throw new Error(`query refused: ${answer.refusal.code}`);
  return answer.value;
}

function totalOf(target: NodeSqliteConnection, measure: string): string | undefined {
  return answerOf(target).rows.at(0)?.measures.find((item) => item.measure === measure)?.total;
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

/** Three attempts of one root, ten invocations each, with distinct token counts. */
function stream(): AccountingObservationInput[] {
  const attempts = [FIRST_ATTEMPT, SECOND_ATTEMPT, '7c3e4f50-6172-4c83-ad94-be05f6071803'];
  return Array.from({ length: STREAM_LENGTH }, (_, index) => {
    const attemptId = attempts.at(index % STREAM_ATTEMPTS) as string;
    const ordinal = Math.floor(index / STREAM_ATTEMPTS);
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

/** The projection with the local, order-dependent fields (ids, revisions) left out. */
function canonicalOf(target: NodeSqliteConnection) {
  const contributions = readOpenContributions(target).map((row) => ({
    attemptId: row.attemptId,
    measure: row.measure,
    unit: row.unit,
    quantity: row.quantity === null ? null : String(row.quantity),
    completeness: row.completeness,
    provenance: row.provenance,
    costOrigin: row.costOrigin
  }));
  return { rows: answerOf(target).rows, contributions };
}

describe('attempt counting (T040)', () => {
  it('counts a live delivery and its replay as one contribution', () => {
    const svc = serviceOn(conn);
    expect(svc.ingestObservation(observation())).toMatchObject({ ok: true, value: { disposition: 'accepted' } });
    expect(svc.ingestObservation(observation())).toMatchObject({ ok: true, value: { disposition: 'duplicate' } });
    expect(count(conn, "SELECT count(*) FROM accounting_contributions WHERE measure = 'input_tokens'")).toBe(1);
    expect(totalOf(conn, 'input_tokens')).toBe('100');
    expect(answerOf(conn).rows.at(0)).toMatchObject({ attempts: 1, roots: 1 });
  });

  it('counts a second attempt separately while the root stays one', () => {
    const svc = serviceOn(conn);
    svc.ingestObservation(observation());
    svc.ingestObservation(
      observation({ attemptId: SECOND_ATTEMPT, sourceIdentity: `${ROOT}:phase-a:1`, eventUtc: '2026-11-10T10:05:00.000Z' })
    );
    expect(answerOf(conn).rows.at(0)).toMatchObject({ attempts: 2, roots: 1 });
    expect(totalOf(conn, 'input_tokens')).toBe('200');
  });

  it('adds two invocations of one attempt, and covers the attempt only when both are known', () => {
    const svc = serviceOn(conn);
    svc.ingestObservation(observation());
    svc.ingestObservation(
      observation({
        sourceIdentity: `${ROOT}:phase-a:1`,
        invocationOrdinal: 1,
        measures: [
          { measure: 'input_tokens', quantity: 50, unit: 'count', provenance: 'provider-reported' },
          { measure: 'output_tokens', quantity: null, unit: 'count', provenance: 'provider-reported', unknownReason: 'not-reported' }
        ]
      })
    );
    const row = answerOf(conn).rows.at(0);
    expect(row).toMatchObject({ attempts: 1, roots: 1 });
    const input = row?.measures.find((item) => item.measure === 'input_tokens');
    const output = row?.measures.find((item) => item.measure === 'output_tokens');
    expect(input).toMatchObject({ total: '150', completeness: 'known', coverage: { known: 1, denominator: 1 } });
    expect(output).toMatchObject({ total: '40', completeness: 'unknown', coverage: { known: 0, denominator: 1 } });
  });

  it('marks the same source identity with changed content conflicting, never a second invocation', () => {
    const svc = serviceOn(conn);
    svc.ingestObservation(observation());
    const changed = svc.ingestObservation(
      observation({ measures: [{ measure: 'input_tokens', quantity: 999, unit: 'count', provenance: 'provider-reported' }] })
    );
    expect(changed).toMatchObject({ ok: true, value: { disposition: 'conflicting' } });
    expect(count(conn, 'SELECT count(*) FROM accounting_attempts')).toBe(1);
    expect(answerOf(conn).rows.at(0)).toMatchObject({ attempts: 1, roots: 1 });
    expect(totalOf(conn, 'input_tokens')).not.toBe('1099');
  });

  it('leaves an uncorrelated observation unattributed, even at the same instant, and reports it', () => {
    const svc = serviceOn(conn);
    svc.ingestObservation(observation());
    const stray = svc.ingestObservation(
      observation({ rootId: null, attemptId: null, sourceIdentity: 'stray-producer:evt-9', invocationOrdinal: undefined })
    );
    expect(stray).toMatchObject({ ok: true, value: { disposition: 'unattributed' } });
    expect(totalOf(conn, 'input_tokens')).toBe('100');
    expect(count(conn, 'SELECT count(*) FROM accounting_contributions')).toBe(2);
    expect(answerOf(conn).unattributedCount).toBe(1);
  });

  it('projects a shuffled replay after reopening the store exactly as the canonical stream', () => {
    const canonicalStore = openStore(':memory:');
    const canonicalService = serviceOn(canonicalStore);
    for (const item of stream()) canonicalService.ingestObservation(item);
    const expected = canonicalOf(canonicalStore);
    canonicalStore.close();

    const dir = mkdtempSync(join(tmpdir(), 'f06-attempts-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'schegent.db');
    const order = shuffled(stream(), SHUFFLE_SEED);
    const firstHalf = openStore(databasePath);
    const firstService = serviceOn(firstHalf);
    for (const item of order.slice(0, STREAM_LENGTH / 2)) firstService.ingestObservation(item);
    firstHalf.close();

    const reopened = openStore(databasePath);
    const reopenedService = serviceOn(reopened);
    const dispositions = shuffled(stream(), SHUFFLE_SEED + 1).map((item) => {
      const result = reopenedService.ingestObservation(item);
      return result.ok ? result.value.disposition : result.refusal.code;
    });
    expect(dispositions.filter((value) => value === 'duplicate')).toHaveLength(STREAM_LENGTH / 2);
    expect(dispositions.filter((value) => value === 'accepted')).toHaveLength(STREAM_LENGTH / 2);
    expect(expected.rows.at(0)).toMatchObject({ attempts: STREAM_ATTEMPTS, roots: 1 });
    expect(canonicalOf(reopened)).toStrictEqual(expected);
    reopened.close();
  });
});

describe('recordAttemptOutcome (T041)', () => {
  it('records an outcome under a new revision, once', () => {
    const svc = serviceOn(conn);
    const ingested = svc.ingestObservation(observation());
    if (!ingested.ok) throw new Error('ingest refused');
    const before = ingested.value.revision ?? 0;

    const recorded = svc.recordAttemptOutcome({ attemptId: FIRST_ATTEMPT, outcome: 'failed' });
    expect(recorded).toStrictEqual({ ok: true, value: { revision: before + 1 } });
    expect(conn.scalar('SELECT outcome FROM accounting_attempts WHERE attempt_id = ?', FIRST_ATTEMPT)).toBe('failed');
    expect(conn.scalar('SELECT cause FROM accounting_revisions WHERE revision = ?', before + 1)).toBe('outcome');

    const repeated = svc.recordAttemptOutcome({ attemptId: FIRST_ATTEMPT, outcome: 'failed' });
    expect(repeated).toStrictEqual({ ok: true, value: { revision: before + 1 } });
    expect(count(conn, 'SELECT count(*) FROM accounting_revisions')).toBe(before + 1);
  });

  it('filters the query by the recorded outcome', () => {
    const svc = serviceOn(conn);
    svc.ingestObservation(observation());
    svc.ingestObservation(observation({ attemptId: SECOND_ATTEMPT, sourceIdentity: `${ROOT}:phase-a:1` }));
    svc.recordAttemptOutcome({ attemptId: FIRST_ATTEMPT, outcome: 'failed' });
    const failed = svc.query({ ...QUERY, filters: { attemptOutcome: 'failed' } });
    if (!failed.ok) throw new Error('query refused');
    expect(failed.value.rows.at(0)).toMatchObject({ attempts: 1, roots: 1 });
  });

  it('refuses an attempt it has never seen, and a malformed request, without a revision', () => {
    const svc = serviceOn(conn);
    expect(svc.recordAttemptOutcome({ attemptId: FIRST_ATTEMPT, outcome: 'failed' })).toMatchObject({
      ok: false,
      refusal: { code: 'unknown-attempt' }
    });
    svc.ingestObservation(observation());
    const revisions = count(conn, 'SELECT count(*) FROM accounting_revisions');
    for (const request of [
      { attemptId: FIRST_ATTEMPT, outcome: 'exploded' },
      { attemptId: 42, outcome: 'failed' },
      { attemptId: FIRST_ATTEMPT },
      null,
      { attemptId: FIRST_ATTEMPT, outcome: 'failed', extra: true }
    ]) {
      expect(svc.recordAttemptOutcome(request)).toMatchObject({ ok: false, refusal: { code: 'invalid-observation' } });
    }
    expect(count(conn, 'SELECT count(*) FROM accounting_revisions')).toBe(revisions);
  });
});
