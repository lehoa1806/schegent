/**
 * FR-R6-F06 (T018, FR-006, FR-007, FR-014, NFR-004, research R5, R7) — the versioned projection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Provenance,
  DEFAULT_ACCOUNTING_BOUNDS
} from '../../../src/contracts/usage-accounting/accounting-types';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import type {
  AccountingMeasureInput,
  AccountingObservationInput
} from '../../../src/services/usage-accounting/observation-normalizer';
import { ingestObservationRecord } from '../../../src/services/usage-accounting/observation-store';
import {
  type ProjectionContext,
  applyProjectionIntent,
  readContributionsAsOf,
  readOpenContributions,
  rebuildPendingProjections
} from '../../../src/services/usage-accounting/projection';

const NOW = '2026-11-10T12:00:00.000Z';
const PROJECTION: ProjectionContext = { nowUtc: NOW, maxGapKeys: DEFAULT_ACCOUNTING_BOUNDS.maxGapKeys };

const open: NodeSqliteConnection[] = [];

function freshConnection(): NodeSqliteConnection {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
  open.push(conn);
  return conn;
}

let conn: NodeSqliteConnection;

beforeEach(() => {
  conn = freshConnection();
});

afterEach(() => {
  for (const item of open.splice(0)) item.close();
});

function tokens(input: number | null, provenance: Provenance): AccountingMeasureInput[] {
  return [
    { measure: 'input_tokens', quantity: input, unit: 'count', provenance },
    { measure: 'output_tokens', quantity: input === null ? null : input / 2, unit: 'count', provenance }
  ];
}

function observation(sourceIdentity: string, attemptId: string, measures: AccountingMeasureInput[]): AccountingObservationInput {
  return {
    producerNamespace: 'schegent.phase-end/1',
    source: 'phase-end',
    sourceKind: 'phase-end',
    sourceIdentity,
    rootId: 'root-1',
    attemptId,
    counterScope: 'invocation-delta',
    adapterVersion: 'claude/1',
    eventUtc: '2026-11-10T11:59:00.000Z',
    observedUtc: '2026-11-10T11:59:01.000Z',
    measures
  };
}

function ingest(target: NodeSqliteConnection, input: AccountingObservationInput): number {
  const result = ingestObservationRecord(target, input, {
    workspaceId: 'ws-1',
    nowUtc: NOW,
    monotonicMs: 1,
    bounds: DEFAULT_ACCOUNTING_BOUNDS
  });
  if (!result.ok || result.value.intentId === null) throw new Error('fixture ingest failed');
  return result.value.intentId;
}

function count(sql: string): number {
  return Number(conn.scalar(sql) ?? 0);
}

describe('projection (T018)', () => {
  it('applies an intent: opens the contribution, appends one revision with the cutoff and marks the intent applied', () => {
    const intentId = ingest(conn, observation('s-1', 'attempt-1', tokens(100, 'derived')));
    const outcome = applyProjectionIntent(conn, intentId, 'ingest', PROJECTION);
    expect(outcome).toEqual({ applied: true, revision: 1 });
    const revisions = conn.all<{ revision: number; cause: string; cutoff_ingest_seq: number }>(
      'SELECT revision, cause, cutoff_ingest_seq FROM accounting_revisions'
    );
    expect(revisions).toEqual([{ revision: 1, cause: 'ingest', cutoff_ingest_seq: 1 }]);
    const rows = readOpenContributions(conn, 'attempt-1');
    expect(rows.map((row) => [row.measure, row.quantity, row.fromRevision])).toEqual([
      ['input_tokens', 100n, 1],
      ['output_tokens', 50n, 1]
    ]);
    const intent = conn.get<{ state: string; applied_revision: number }>(
      'SELECT state, applied_revision FROM accounting_projection_intents WHERE intent_id = ?',
      intentId
    );
    expect(intent).toEqual({ state: 'applied', applied_revision: 1 });
  });

  it('closes the replaced contribution when a higher-ranked observation arrives', () => {
    applyProjectionIntent(conn, ingest(conn, observation('s-1', 'attempt-1', tokens(100, 'derived'))), 'ingest', PROJECTION);
    const second = ingest(conn, observation('s-2', 'attempt-1', tokens(120, 'provider-reported')));
    expect(applyProjectionIntent(conn, second, 'ingest', PROJECTION)).toEqual({ applied: true, revision: 2 });
    const all = conn.all<{ measure: string; quantity: number; from_revision: number; to_revision: number | null }>(
      "SELECT measure, quantity, from_revision, to_revision FROM accounting_contributions WHERE measure = 'input_tokens' ORDER BY contribution_id"
    );
    expect(all).toEqual([
      { measure: 'input_tokens', quantity: 100, from_revision: 1, to_revision: 2 },
      { measure: 'input_tokens', quantity: 120, from_revision: 2, to_revision: null }
    ]);
    const dispositions = conn.all<{ source_identity: string; disposition: string }>(
      'SELECT source_identity, disposition FROM accounting_observations ORDER BY ingest_seq'
    );
    expect(dispositions).toEqual([
      { source_identity: 's-1', disposition: 'superseded' },
      { source_identity: 's-2', disposition: 'accepted' }
    ]);
  });

  it('appends a revision without a new contribution when the selection is unchanged', () => {
    applyProjectionIntent(conn, ingest(conn, observation('s-1', 'attempt-1', tokens(100, 'provider-reported'))), 'ingest', PROJECTION);
    const lower = ingest(conn, observation('s-2', 'attempt-1', tokens(90, 'estimated')));
    expect(applyProjectionIntent(conn, lower, 'ingest', PROJECTION)).toEqual({ applied: true, revision: 2 });
    expect(count('SELECT count(*) FROM accounting_contributions')).toBe(2);
    expect(count('SELECT MAX(cutoff_ingest_seq) FROM accounting_revisions')).toBe(2);
  });

  it('reads as of revision N: opened by N and not closed by N', () => {
    applyProjectionIntent(conn, ingest(conn, observation('s-1', 'attempt-1', tokens(100, 'derived'))), 'ingest', PROJECTION);
    applyProjectionIntent(conn, ingest(conn, observation('s-2', 'attempt-1', tokens(120, 'provider-reported'))), 'ingest', PROJECTION);
    applyProjectionIntent(conn, ingest(conn, observation('s-3', 'attempt-2', tokens(10, 'derived'))), 'ingest', PROJECTION);
    const asOf = (revision: number) =>
      readContributionsAsOf(conn, revision)
        .filter((row) => row.measure === 'input_tokens')
        .map((row) => [row.attemptId, row.quantity]);
    expect(asOf(1)).toEqual([['attempt-1', 100n]]);
    expect(asOf(2)).toEqual([['attempt-1', 120n]]);
    expect(asOf(3)).toEqual([
      ['attempt-1', 120n],
      ['attempt-2', 10n]
    ]);
  });

  it('leaves the intent pending after a failpoint, counts the attempt and the gap, then rebuild applies it', () => {
    const intentId = ingest(conn, observation('s-1', 'attempt-1', tokens(100, 'derived')));
    const failing: ProjectionContext = {
      ...PROJECTION,
      failpoint: () => {
        throw new Error('injected');
      }
    };
    expect(applyProjectionIntent(conn, intentId, 'ingest', failing)).toEqual({ applied: false });
    const intent = conn.get<{ state: string; attempts: number }>(
      'SELECT state, attempts FROM accounting_projection_intents WHERE intent_id = ?',
      intentId
    );
    expect(intent).toEqual({ state: 'pending', attempts: 1 });
    expect(count('SELECT count(*) FROM accounting_contributions')).toBe(0);
    expect(count('SELECT count(*) FROM accounting_revisions')).toBe(0);
    expect(count("SELECT count FROM accounting_gaps WHERE gap_kind = 'projection-failed' AND scope_key = 'attempt-1'")).toBe(1);
    expect(conn.db.isTransaction).toBe(false);

    expect(rebuildPendingProjections(conn, PROJECTION)).toEqual({ applied: 1, stillPending: 0 });
    expect(readOpenContributions(conn, 'attempt-1').map((row) => row.quantity)).toEqual([100n, 50n]);
    expect(conn.get<{ cause: string }>('SELECT cause FROM accounting_revisions')?.cause).toBe('rebuild');
  });

  it('treats a second apply of an applied intent as a no-op', () => {
    const intentId = ingest(conn, observation('s-1', 'attempt-1', tokens(100, 'derived')));
    applyProjectionIntent(conn, intentId, 'ingest', PROJECTION);
    expect(applyProjectionIntent(conn, intentId, 'ingest', PROJECTION)).toEqual({ applied: true, revision: 1 });
    expect(count('SELECT count(*) FROM accounting_revisions')).toBe(1);
  });

  it('keeps an unknown selection when no candidate is known, then replaces it with a known one', () => {
    applyProjectionIntent(conn, ingest(conn, observation('s-1', 'attempt-1', tokens(null, 'provider-reported'))), 'ingest', PROJECTION);
    const first = readOpenContributions(conn, 'attempt-1').at(0);
    expect(first?.quantity).toBeNull();
    expect(first?.completeness).toBe('unknown');
    applyProjectionIntent(conn, ingest(conn, observation('s-2', 'attempt-1', tokens(8, 'estimated'))), 'ingest', PROJECTION);
    const second = readOpenContributions(conn, 'attempt-1').at(0);
    expect(second?.quantity).toBe(8n);
    expect(second?.completeness).toBe('known');
  });

  it('gives the same open contributions for a shuffled replay of a 20-observation fixture', () => {
    const fixture: AccountingObservationInput[] = [];
    const ranks: Provenance[] = ['provider-reported', 'derived', 'estimated', 'provider-reported'];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const base = 1000 * (attempt + 1);
      ranks.forEach((provenance, index) => {
        // Equal values within one rank (index 0 and 3), so no order-dependent conflict arises.
        const value = provenance === 'provider-reported' ? base : base + index * 10;
        const measures: AccountingMeasureInput[] = [
          ...tokens(index === 1 && attempt === 2 ? null : value, provenance),
          {
            measure: 'cost',
            quantity: `${String(attempt)}.${String(index + 1)}5`,
            unit: 'USD',
            provenance: provenance === 'provider-reported' ? 'estimated' : provenance,
            ...(provenance === 'provider-reported' || provenance === 'estimated' ? { pricingVersion: 'p1' } : {})
          }
        ];
        fixture.push(observation(`a${String(attempt)}-s${String(index)}`, `attempt-${String(attempt)}`, measures));
      });
    }
    expect(fixture).toHaveLength(20);

    const project = (order: readonly AccountingObservationInput[]) => {
      const target = freshConnection();
      for (const item of order) applyProjectionIntent(target, ingest(target, item), 'ingest', PROJECTION);
      return readOpenContributions(target).map((row) => [row.attemptId, row.measure, row.unit, row.quantity, row.completeness, row.provenance, row.costOrigin]);
    };

    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const shuffle = (items: readonly AccountingObservationInput[]) => {
      const copy = items.slice();
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        const held = copy.at(index) as AccountingObservationInput;
        copy[index] = copy.at(other) as AccountingObservationInput;
        copy[other] = held;
      }
      return copy;
    };

    const canonical = project(fixture);
    expect(canonical).toHaveLength(15);
    for (let round = 0; round < 3; round += 1) {
      expect(project(shuffle(fixture))).toEqual(canonical);
    }
    expect(project(fixture.slice().reverse())).toEqual(canonical);
  });

  it('reloads only the ingested invocation group, so a long attempt costs the same per ingest (SC-003)', () => {
    const earlier = 400;
    for (let ordinal = 0; ordinal < earlier; ordinal += 1) {
      const intent = ingest(conn, { ...observation(`long:${String(ordinal)}`, 'att-long', tokens(10, 'provider-reported')), invocationOrdinal: ordinal });
      applyProjectionIntent(conn, intent, 'ingest', PROJECTION);
    }
    const intent = ingest(conn, { ...observation('long:last', 'att-long', tokens(10, 'provider-reported')), invocationOrdinal: earlier });
    const reads = vi.spyOn(conn, 'all');
    expect(applyProjectionIntent(conn, intent, 'ingest', PROJECTION)).toMatchObject({ applied: true });
    const candidateRows = reads.mock.calls
      .map((call, index) => ({ sql: String(call.at(0) ?? ''), rows: reads.mock.results.at(index)?.value as unknown[] }))
      .filter((call) => call.sql.includes('JOIN accounting_observation_measures'))
      .reduce((sum, call) => sum + call.rows.length, 0);
    reads.mockRestore();
    expect(candidateRows).toBe(2);
    expect(count("SELECT count(*) FROM accounting_contributions WHERE attempt_id = 'att-long' AND to_revision IS NULL")).toBe(2 * (earlier + 1));
  });

  it('looks up the open contribution by the full open-contribution index key (SC-003)', () => {
    const intent = ingest(conn, { ...observation('keyed:0', 'att-keyed', tokens(10, 'provider-reported')), invocationOrdinal: 3 });
    const reads = vi.spyOn(conn, 'get');
    applyProjectionIntent(conn, intent, 'ingest', PROJECTION);
    const lookups = reads.mock.calls.filter((call) => /FROM accounting_contributions[\s\S]*to_revision IS NULL/u.test(String(call.at(0))));
    reads.mockRestore();
    expect(lookups.length).toBeGreaterThan(0);
    for (const [sql, ...params] of lookups) {
      const plan = conn.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${String(sql)}`, ...(params as never[]));
      expect(plan.map((row) => row.detail).join(' ')).toContain('idx_accounting_contributions_open (attempt_id=? AND <expr>=? AND measure=? AND unit=?)');
    }
  });
});
