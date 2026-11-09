/**
 * FR-R6-F06 (T032, FR-006, research R3) — a session-cumulative counter becomes an invocation
 * figure only against a qualified baseline. Without one the figure is unknown, with a reason and
 * a gap, and no path produces a negative quantity.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import {
  CUMULATIVE_GAP_KINDS,
  qualifyAcpSessionCost,
  qualifyCumulativeCost
} from '../../../src/services/usage-accounting/cumulative-qualifier';
import { PhaseEndCorrelator, phaseEndObservation } from '../../../src/services/usage-accounting/phase-end-ingestion';
import { createUsageAccountingService } from '../../../src/services/usage-accounting/usage-accounting-service';
import { CLAUDE_ATTEMPT, cliInvocationRow, phaseEndRow } from '../../fixtures/usage-accounting/phase-end-rows';

const NOW = '2026-11-10T12:00:00.000Z';

let conn: NodeSqliteConnection;

beforeEach(() => {
  conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
});

afterEach(() => {
  if (conn.db.isOpen) conn.close();
});

function snapshotWith(payload: Record<string, unknown>) {
  const correlator = new PhaseEndCorrelator();
  correlator.observe(cliInvocationRow({}));
  const snapshot = correlator.observe(phaseEndRow({ payload: { attemptId: CLAUDE_ATTEMPT, ...payload } }));
  if (snapshot === undefined) throw new Error('no snapshot');
  return snapshot;
}

function costOf(payload: Record<string, unknown>) {
  const cost = phaseEndObservation(snapshotWith(payload), NOW).measures.find((item) => item.measure === 'cost');
  if (cost === undefined) throw new Error('no cost');
  return cost;
}

describe('cumulative qualifier (T032)', () => {
  it('maps each baseline marker', () => {
    expect(qualifyCumulativeCost('subtracted')).toEqual({ known: true, provenance: 'derived' });
    expect(qualifyCumulativeCost('below-baseline')).toEqual({ known: false, reason: 'cumulative-reset' });
    expect(qualifyCumulativeCost('absent')).toEqual({ known: false, reason: 'unattributed-session-baseline' });
    expect(qualifyCumulativeCost(null)).toEqual({ known: false, reason: 'unattributed-session-baseline' });
  });

  it('keeps an ACP session-cumulative cost unknown without a qualified baseline', () => {
    expect(qualifyAcpSessionCost(true)).toEqual({ known: true, provenance: 'derived' });
    expect(qualifyAcpSessionCost(false)).toEqual({ known: false, reason: 'unattributed-session-baseline' });
  });

  it('names a gap for every unknown reason it produces', () => {
    expect([...CUMULATIVE_GAP_KINDS].sort()).toEqual(['cumulative-reset', 'unattributed-session-baseline']);
  });

  it('applies the markers to a phase-end cost', () => {
    expect(costOf({ costBaseline: 'subtracted', totalCostUsd: 0.25 })).toMatchObject({ quantity: '0.250000', provenance: 'derived' });
    expect(costOf({ costBaseline: 'below-baseline', totalCostUsd: 0.25 })).toMatchObject({
      quantity: null,
      unknownReason: 'cumulative-reset'
    });
    expect(costOf({ costBaseline: 'absent', totalCostUsd: 0.25 })).toMatchObject({
      quantity: null,
      unknownReason: 'unattributed-session-baseline'
    });
  });

  it('never produces a negative quantity', () => {
    for (const marker of ['subtracted', 'below-baseline', 'absent', undefined]) {
      const cost = costOf({ costBaseline: marker, totalCostUsd: -0.5 });
      expect(cost.quantity).toBeNull();
      expect(cost.unknownReason).toBe('rejected-value');
    }
  });

  it('counts a gap when an unknown cumulative cost is stored, once per observation', () => {
    const service = createUsageAccountingService({ conn, nowUtc: () => NOW, monotonicMs: () => 1, workspaceId: 'ws-1' });
    const below = snapshotWith({ costBaseline: 'below-baseline', totalCostUsd: 1, inputTokens: 4 });
    expect(service.ingestPhaseEnd(below).ok).toBe(true);
    expect(service.ingestPhaseEnd(below).ok).toBe(true);
    const absent = phaseEndRow({ iteration: 2, payload: { attemptId: CLAUDE_ATTEMPT, totalCostUsd: 1 } });
    const correlator = new PhaseEndCorrelator();
    correlator.observe(cliInvocationRow({ iteration: 2 }));
    const absentSnapshot = correlator.observe(absent);
    if (absentSnapshot === undefined) throw new Error('no snapshot');
    expect(service.ingestPhaseEnd(absentSnapshot).ok).toBe(true);

    const gaps = service.readGaps();
    if (!gaps.ok) throw new Error('gaps unreadable');
    const count = (kind: string) => gaps.value.gaps.filter((gap) => gap.kind === kind).reduce((sum, gap) => sum + gap.count, 0);
    expect(count('cumulative-reset')).toBe(1);
    expect(count('unattributed-session-baseline')).toBe(1);
  });
});
