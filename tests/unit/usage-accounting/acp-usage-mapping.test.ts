/**
 * FR-R6-F06 (T038, FR-023, FR-024, SC-009, research R12) — an ACP usage update becomes one
 * accounting observation by the source's own semantics: occupancy is never billable, a
 * session cost needs a qualified baseline and a currency, credits stay credits, and replay
 * without a stable identity is never counted twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import { acpUsageObservation } from '../../../src/services/usage-accounting/acp-usage-mapping';
import type { AccountingMeasureInput } from '../../../src/services/usage-accounting/observation-normalizer';
import { createUsageAccountingService } from '../../../src/services/usage-accounting/usage-accounting-service';
import { ACP_ATTEMPT, ACP_ROOT, acpBinding, acpUpdate } from '../../fixtures/usage-accounting/acp-usage-updates';

const NOW = '2026-11-10T12:00:00.000Z';
const QUERY = { groupBy: ['backend'], from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' };

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

function measureOf(measures: readonly AccountingMeasureInput[], name: string): AccountingMeasureInput | undefined {
  return measures.find((item) => item.measure === name);
}

function count(sql: string): number {
  return Number(conn.scalar(sql) ?? 0);
}

describe('acpUsageObservation (T038)', () => {
  it('maps used/size onto occupancy measures, never onto billable tokens', () => {
    const input = acpUsageObservation(acpUpdate(), acpBinding(), NOW);
    expect(input.counterScope).toBe('acp-context-occupancy');
    expect(input.sourceKind).toBe('acp-usage-update');
    expect(measureOf(input.measures, 'context_used')).toMatchObject({ quantity: 1200, unit: 'count' });
    expect(measureOf(input.measures, 'context_size')).toMatchObject({ quantity: 200_000, unit: 'count' });
    for (const billable of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens']) {
      expect(measureOf(input.measures, billable)).toBeUndefined();
    }
  });

  it('knows a cost only with a currency and a qualified session baseline', () => {
    const known = acpUsageObservation(
      acpUpdate({ cost: { amount: '0.125', currency: 'USD' }, hasQualifiedSessionBaseline: true }),
      acpBinding(),
      NOW
    );
    expect(measureOf(known.measures, 'cost')).toStrictEqual({
      measure: 'cost',
      quantity: '0.125',
      unit: 'USD',
      provenance: 'derived'
    });

    const noBaseline = acpUsageObservation(acpUpdate({ cost: { amount: '0.125', currency: 'USD' } }), acpBinding(), NOW);
    expect(measureOf(noBaseline.measures, 'cost')).toMatchObject({
      quantity: null,
      unknownReason: 'unattributed-session-baseline'
    });

    const noCurrency = acpUsageObservation(
      acpUpdate({ cost: { amount: '0.125' }, hasQualifiedSessionBaseline: true }),
      acpBinding(),
      NOW
    );
    expect(measureOf(noCurrency.measures, 'cost')).toMatchObject({ quantity: null, unknownReason: 'rejected-value' });

    const absent = acpUsageObservation(acpUpdate({ hasQualifiedSessionBaseline: true }), acpBinding(), NOW);
    expect(measureOf(absent.measures, 'cost')).toMatchObject({ quantity: null, unknownReason: 'not-reported' });
  });

  it('keeps credits as their own unit, never as money', () => {
    const input = acpUsageObservation(
      acpUpdate({ credits: { amount: '3.5', unit: 'acme.credits' }, hasQualifiedSessionBaseline: true }),
      acpBinding(),
      NOW
    );
    expect(measureOf(input.measures, 'credits')).toStrictEqual({
      measure: 'credits',
      quantity: '3.5',
      unit: 'acme.credits',
      provenance: 'derived'
    });
    expect(measureOf(input.measures, 'cost')).toMatchObject({ quantity: null });
  });

  it('leaves an update unattributed with no binding, or with a binding for another turn', () => {
    for (const binding of [null, acpBinding({ turnId: 'turn-2' }), acpBinding({ connectionGeneration: 2 })]) {
      const input = acpUsageObservation(acpUpdate(), binding, NOW);
      expect(input.rootId).toBeNull();
      expect(input.attemptId).toBeNull();
    }
    const bound = acpUsageObservation(acpUpdate(), acpBinding(), NOW);
    expect(bound.rootId).toBe(ACP_ROOT);
    expect(bound.attemptId).toBe(ACP_ATTEMPT);
  });

  it('marks a replay with no producer event id and no baseline as historical', () => {
    const replay = acpUpdate({ replayed: true, producerEventId: undefined });
    expect(acpUsageObservation(replay, acpBinding(), NOW)).toMatchObject({ disposition: 'historical', sourceIdentity: null });
    const live = acpUsageObservation(acpUpdate({ producerEventId: undefined }), acpBinding(), NOW);
    expect(live.disposition).toBeUndefined();
    expect(live.sourceIdentity).toBeNull();
  });

  it('builds the source identity from the producer event, never from the receive sequence or connection', () => {
    const first = acpUsageObservation(acpUpdate({ hostReceiveSeq: 1 }), null, NOW);
    const second = acpUsageObservation(acpUpdate({ hostReceiveSeq: 99, connectionGeneration: 3 }), null, NOW);
    expect(first.sourceIdentity).not.toBeNull();
    expect(second.sourceIdentity).toBe(first.sourceIdentity);
    expect(JSON.stringify(first)).not.toContain('hostReceiveSeq');
  });

  it('drops a malformed identity field rather than storing it', () => {
    const input = acpUsageObservation(acpUpdate({ producerEventId: 'evt 1/../x' }), acpBinding(), NOW);
    expect(input.sourceIdentity).toBeNull();
  });
});

describe('ingestAcpUsageUpdate (T039)', () => {
  it('stores two receive sequences of one producer event as one observation', () => {
    const svc = service();
    const first = svc.ingestAcpUsageUpdate(acpUpdate({ hostReceiveSeq: 1 }), acpBinding());
    const second = svc.ingestAcpUsageUpdate(acpUpdate({ hostReceiveSeq: 7 }), acpBinding());
    expect(first).toMatchObject({ ok: true, value: { disposition: 'accepted' } });
    expect(second).toMatchObject({ ok: true, value: { disposition: 'duplicate' } });
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(1);
  });

  it('stores a historical replay and never counts it', () => {
    const svc = service();
    const replay = svc.ingestAcpUsageUpdate(
      acpUpdate({ replayed: true, producerEventId: undefined, cost: { amount: '1', currency: 'USD' } }),
      acpBinding()
    );
    expect(replay).toMatchObject({ ok: true, value: { disposition: 'historical' } });
    expect(count("SELECT count(*) FROM accounting_observations WHERE disposition = 'historical'")).toBe(1);
    const answer = svc.query(QUERY);
    if (!answer.ok) throw new Error('query refused');
    expect(answer.value.rows).toStrictEqual([]);
  });

  it('contributes 0 billable tokens and 0 money from occupancy and credits (SC-009)', () => {
    const svc = service();
    svc.ingestAcpUsageUpdate(
      acpUpdate({ credits: { amount: '3.5', unit: 'acme.credits' }, hasQualifiedSessionBaseline: true }),
      acpBinding()
    );
    const answer = svc.query(QUERY);
    if (!answer.ok) throw new Error('query refused');
    const measures = answer.value.rows.at(0)?.measures ?? [];
    for (const billable of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens']) {
      expect(measures.find((item) => item.measure === billable)).toBeUndefined();
    }
    const money = measures.filter((item) => item.measure === 'cost');
    expect(money.map((item) => [item.total, item.completeness])).toStrictEqual([['0.000000', 'unknown']]);
    expect(measures.find((item) => item.measure === 'credits')).toMatchObject({ unit: 'acme.credits', total: '3.500000' });
  });

  describe('repeated occupancy updates report the latest value (FR-023, AC-09)', () => {
    const EARLY = { producerEventId: 'evt-1', eventUtc: '2026-11-10T10:00:00.000Z', used: 1000 };
    const LATE = { producerEventId: 'evt-2', eventUtc: '2026-11-10T10:00:05.000Z', used: 2500 };

    function contextUsed(svc: ReturnType<typeof service>) {
      const answer = svc.query(QUERY);
      if (!answer.ok) throw new Error('query refused');
      return answer.value.rows.at(0)?.measures.find((item) => item.measure === 'context_used');
    }

    it('selects the later update and records no conflict', () => {
      const svc = service();
      svc.ingestAcpUsageUpdate(acpUpdate(EARLY), acpBinding());
      svc.ingestAcpUsageUpdate(acpUpdate(LATE), acpBinding());
      expect(contextUsed(svc)).toMatchObject({ total: '2500', completeness: 'known' });
      expect(count("SELECT count(*) FROM accounting_observations WHERE disposition = 'conflicting'")).toBe(0);
      expect(conn.scalar("SELECT disposition FROM accounting_observations WHERE source_identity LIKE '%:evt-1'")).toBe('superseded');
    });

    it('keeps the later event when it is ingested first', () => {
      const svc = service();
      svc.ingestAcpUsageUpdate(acpUpdate(LATE), acpBinding());
      svc.ingestAcpUsageUpdate(acpUpdate(EARLY), acpBinding());
      expect(contextUsed(svc)).toMatchObject({ total: '2500', completeness: 'known' });
    });
  });
});
