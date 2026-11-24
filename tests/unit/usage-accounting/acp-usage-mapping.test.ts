/**
 * FR-R6-F06 (T038, FR-023, FR-024, SC-009, research R12) — an ACP usage update becomes one
 * accounting observation by the source's own semantics: occupancy is never billable, a
 * session cost needs a qualified baseline and a currency, credits stay credits, and replay
 * without a stable identity is never counted twice.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import { buildUsageUpdate } from '../../../src/services/acp-runtime/client-guards';
import { ObservationEmitter } from '../../../src/services/acp-runtime/observation-emitter';
import { mapSessionUpdate } from '../../../src/services/acp-runtime/session-update-mapper';
import {
  acpUsageObservation,
  sourceIdentityOf
} from '../../../src/services/usage-accounting/acp-usage-mapping';
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

  it('encodes all valid (profileId, acpSessionId, producerEventId) tuples as uniform 71-byte acp-v1:<sha256> identities across valid ACP shapes', () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['profile-a', 'acp-session-1', 'evt-1'],
      ['profile-a', 'session with spaces', 'evt 1/a:b@c'],
      ['profile-a', 'ns:team/session@host:42', 'event:sub/id@9'],
      ['profile-a', 's'.repeat(129), 'e'.repeat(256)],
      ['profile-a', '세션-識別子:αβγ/42', 'イベント-🚀:ok']
    ];
    for (const [profileId, acpSessionId, producerEventId] of cases) {
      const update = acpUpdate({ profileId, acpSessionId, producerEventId });
      const expected = `acp-v1:${createHash('sha256')
        .update(JSON.stringify(['acp-usage-source/1', profileId, acpSessionId, producerEventId]), 'utf8')
        .digest('hex')}`;
      const derived = sourceIdentityOf(update);
      expect(derived).toBe(expected);
      expect(derived).toMatch(/^acp-v1:[0-9a-f]{64}$/);
      expect(Buffer.byteLength(derived!, 'utf8')).toBe(71);
      expect(acpUsageObservation(update, acpBinding({ profileId, acpSessionId }), NOW).sourceIdentity).toBe(expected);
    }
  });

  it('keeps shifted-colon tuples strictly distinct with zero concatenation collisions', () => {
    const left = sourceIdentityOf(acpUpdate({ profileId: 'p', acpSessionId: 'a:b', producerEventId: 'c' }));
    const right = sourceIdentityOf(acpUpdate({ profileId: 'p', acpSessionId: 'a', producerEventId: 'b:c' }));
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left).not.toBe(right);
  });

  it('rejects Cc, Cf, Cs, Zl, Zp, >256-char agent IDs, and invalid profileIds as null sourceIdentity', () => {
    const invalidAgentIds = [
      '',
      'a'.repeat(257),
      'bad\nline',
      'bad\u001b[31m',
      'bad\u0000nul',
      'bad\u202ebidi',
      'bad\u2066isolate',
      'bad\u200emark',
      'bad\ud800surrogate',
      'bad\u2028linesep',
      'bad\u2029parasep'
    ];
    for (const bad of invalidAgentIds) {
      expect(sourceIdentityOf(acpUpdate({ acpSessionId: bad }))).toBeNull();
      expect(sourceIdentityOf(acpUpdate({ producerEventId: bad }))).toBeNull();
    }
    expect(sourceIdentityOf(acpUpdate({ profileId: 'bad profile' }))).toBeNull();
    expect(sourceIdentityOf(acpUpdate({ profileId: '-leading-dash' }))).toBeNull();
    expect(sourceIdentityOf(acpUpdate({ profileId: 'p'.repeat(129) }))).toBeNull();
  });

  it('extracts optional producerEventId and providerSessionId through mapSessionUpdate and buildUsageUpdate', () => {
    const mapped = mapSessionUpdate({
      sessionUpdate: 'usage_update',
      used: 600,
      size: 200_000,
      eventId: 'evt:alpha/1 @ok',
      cost: { amount: 0.05, currency: 'USD' }
    });
    expect(mapped).toEqual({
      kind: 'usage',
      usage: {
        used: 600,
        size: 200_000,
        cost: { amount: '0.05', currency: 'USD' },
        producerEventId: 'evt:alpha/1 @ok'
      }
    });
    if (mapped.kind !== 'usage') throw new Error('expected usage');
    const built = buildUsageUpdate(
      {
        profileId: 'claude-acp-bridge',
        generation: 2,
        sessionId: 'sess:space 1',
        attribution: { origin: 'live', turnId: 'turn-2-1', attemptId: ACP_ATTEMPT, binding: acpBinding() },
        hostReceiveSeq: 4,
        eventUtc: NOW,
        providerSessionId: 'prov-sess-99'
      },
      mapped.usage
    );
    expect(built.producerEventId).toBe('evt:alpha/1 @ok');
    expect(built.providerSessionId).toBe('prov-sess-99');

    // Invalid producerEventId in usage_update is dropped cleanly rather than breaking usage mapping.
    const withBadId = mapSessionUpdate({
      sessionUpdate: 'usage_update',
      used: 100,
      size: 1000,
      eventId: 'bad\u202eoverride'
    });
    expect(withBadId).toEqual({ kind: 'usage', usage: { used: 100, size: 1000 } });
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

  it('bounds replayed historical ACP observations together with unattributed under maxUnattributed and preserves capacity for attributed updates (SR-A1)', () => {
    const svc = createUsageAccountingService({
      conn,
      nowUtc: () => NOW,
      monotonicMs: () => 1,
      workspaceId: 'ws-1',
      bounds: { maxUnattributed: 3, maxRetainedObservations: 8 }
    });

    // 1 unattributed ACP update (no binding) + 2 historical replays fill the shared cap of 3.
    expect(svc.ingestAcpUsageUpdate(acpUpdate({ producerEventId: undefined }), null)).toMatchObject({
      ok: true,
      value: { disposition: 'unattributed' }
    });
    for (let index = 0; index < 2; index += 1) {
      expect(
        svc.ingestAcpUsageUpdate(
          acpUpdate({ replayed: true, producerEventId: undefined, hostReceiveSeq: index + 1 }),
          acpBinding()
        )
      ).toMatchObject({ ok: true, value: { disposition: 'historical' } });
    }

    // Flood of additional historical replays hits unattributed-limit and cannot exhaust maxRetainedObservations.
    for (let index = 0; index < 10; index += 1) {
      expect(
        svc.ingestAcpUsageUpdate(
          acpUpdate({ replayed: true, producerEventId: undefined, hostReceiveSeq: 100 + index }),
          acpBinding()
        )
      ).toEqual({ ok: false, refusal: { code: 'unattributed-limit' } });
    }
    expect(count('SELECT count(*) FROM accounting_observations')).toBe(3);
    expect(
      Number(
        conn.scalar("SELECT COALESCE(SUM(count), 0) FROM accounting_gaps WHERE gap_kind = 'unattributed-limit'") ?? 0
      )
    ).toBe(10);

    // Live attributed ACP update still ingests and projects cleanly.
    expect(
      svc.ingestAcpUsageUpdate(acpUpdate({ producerEventId: 'evt-live-after-replay-cap', used: 2048 }), acpBinding())
    ).toMatchObject({ ok: true, value: { disposition: 'accepted' } });
    const answer = svc.query(QUERY);
    if (!answer.ok) throw new Error('query refused');
    expect(answer.value.rows.at(0)?.measures.find((item) => item.measure === 'context_used')).toMatchObject({
      total: '2048',
      completeness: 'known'
    });
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
      const earlySourceId = sourceIdentityOf(acpUpdate(EARLY));
      expect(earlySourceId).not.toBeNull();
      expect(
        conn.scalar('SELECT disposition FROM accounting_observations WHERE source_identity = ?', earlySourceId!)
      ).toBe('superseded');
    });

    it('keeps the later event when it is ingested first', () => {
      const svc = service();
      svc.ingestAcpUsageUpdate(acpUpdate(LATE), acpBinding());
      svc.ingestAcpUsageUpdate(acpUpdate(EARLY), acpBinding());
      expect(contextUsed(svc)).toMatchObject({ total: '2500', completeness: 'known' });
    });
  });

  describe('producer trust separation and unit folding (FR-R7-16 16-05)', () => {
    it('folds unbaselined cycling currencies and credit units to fallback unknown units so an agent cannot mint arbitrary units', () => {
      const svc = service();
      const currencies = ['EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'MXN', 'BRL', 'INR', 'KRW', 'SGD', 'HKD', 'ZAR'];
      currencies.forEach((currency, index) => {
        const update = acpUpdate({
          producerEventId: `evt-cycle-${String(index)}`,
          eventUtc: `2026-11-10T10:00:${String(index).padStart(2, '0')}.000Z`,
          cost: { amount: '0.25', currency },
          credits: { amount: '1.0', unit: `vendor-${String(index)}.credits` },
          hasQualifiedSessionBaseline: false
        });
        const mapped = acpUsageObservation(update, acpBinding(), NOW);
        expect(measureOf(mapped.measures, 'cost')).toMatchObject({
          unit: 'USD',
          quantity: null,
          unknownReason: 'unattributed-session-baseline'
        });
        expect(measureOf(mapped.measures, 'credits')).toMatchObject({
          unit: 'credits',
          quantity: null,
          unknownReason: 'unattributed-session-baseline'
        });
        const res = svc.ingestAcpUsageUpdate(update, acpBinding());
        expect(res.ok).toBe(true);
      });

      const answer = svc.query({ groupBy: ['backend'], limit: 1 });
      if (!answer.ok) throw new Error('query refused');
      const row = answer.value.rows.at(0)!;
      expect(row.measures.filter((m) => m.measure === 'cost').map((m) => m.unit)).toEqual(['USD']);
      expect(row.measures.filter((m) => m.measure === 'credits').map((m) => m.unit)).toEqual(['credits']);
      expect(row.omittedUnitCount).toBeUndefined();
    });

    it('stamps ACP usage updates with host receive clock via ObservationEmitter and buildUsageUpdate (never agent clock)', () => {
      const hostClockUtc = '2026-11-10T11:55:00.000Z';
      const emitted: Array<{ readonly eventUtc: string; readonly hasQualifiedSessionBaseline: boolean }> = [];
      const emitter = new ObservationEmitter(
        1,
        {
          nowUtc: () => hostClockUtc,
          setTimer: () => ({ cancel: () => undefined })
        },
        (obs) => {
          if (obs.kind === 'usage') {
            emitted.push({
              eventUtc: obs.usage.eventUtc,
              hasQualifiedSessionBaseline: obs.usage.hasQualifiedSessionBaseline
            });
          }
        }
      );
      emitter.emit(
        'sess-1',
        {
          origin: 'live',
          turnId: 'turn-1',
          attemptId: ACP_ATTEMPT,
          binding: acpBinding()
        },
        (hostReceiveSeq, eventUtc) => ({
          kind: 'usage',
          usage: buildUsageUpdate(
            {
              profileId: 'acp-profile',
              generation: 1,
              sessionId: 'sess-1',
              attribution: { origin: 'live', turnId: 'turn-1', attemptId: ACP_ATTEMPT, binding: acpBinding() },
              hostReceiveSeq,
              eventUtc
            },
            { used: 500, size: 100_000, cost: { amount: '0.50', currency: 'EUR' } }
          )
        })
      );
      expect(emitted).toEqual([{ eventUtc: hostClockUtc, hasQualifiedSessionBaseline: false }]);
    });

    it('deduplicates replays across spaces, colons, >128-char, and non-ASCII session IDs while keeping shifted-colon pairs distinct in SQLite (R7-17-04)', () => {
      const svc = service();
      const nonAscii256 = '한'.repeat(256); // 256 UTF-16 units = 768 UTF-8 bytes; hashed identity stays 71 bytes!
      const shapes: ReadonlyArray<readonly [string, string, number]> = [
        ['session with spaces', 'evt 1', 1000],
        ['ns:colon/session@1', 'evt:sub/2', 1100],
        ['long-'.padEnd(200, 'x'), 'evt-long-'.padEnd(200, 'y'), 1200],
        [nonAscii256, 'イベント:αβγ', 1300]
      ];
      shapes.forEach(([acpSessionId, producerEventId, used], index) => {
        const turnId = `turn-shape-${index}`;
        const binding = acpBinding({ acpSessionId, turnId, attemptId: `att-shape-${index}` });
        const update = acpUpdate({
          acpSessionId,
          producerEventId,
          turnId,
          hostReceiveSeq: 1,
          used
        });
        const first = svc.ingestAcpUsageUpdate(update, binding);
        const replay = svc.ingestAcpUsageUpdate(
          { ...update, hostReceiveSeq: 42, connectionGeneration: 9, replayed: true },
          acpBinding({ acpSessionId, turnId, connectionGeneration: 9, attemptId: `att-shape-${index}` })
        );
        expect(first, acpSessionId).toMatchObject({ ok: true, value: { disposition: 'accepted' } });
        expect(replay, acpSessionId).toMatchObject({ ok: true, value: { disposition: 'duplicate' } });
      });

      // Shifted-colon pair: ('profile-a', 'a:b', 'c') vs ('profile-a', 'a', 'b:c') must both accept as distinct rows.
      const shiftedA = svc.ingestAcpUsageUpdate(
        acpUpdate({ acpSessionId: 'a:b', producerEventId: 'c', turnId: 'turn-shift-a' }),
        acpBinding({ acpSessionId: 'a:b', turnId: 'turn-shift-a', attemptId: 'att-shift-a' })
      );
      const shiftedB = svc.ingestAcpUsageUpdate(
        acpUpdate({ acpSessionId: 'a', producerEventId: 'b:c', turnId: 'turn-shift-b' }),
        acpBinding({ acpSessionId: 'a', turnId: 'turn-shift-b', attemptId: 'att-shift-b' })
      );
      expect(shiftedA).toMatchObject({ ok: true, value: { disposition: 'accepted' } });
      expect(shiftedB).toMatchObject({ ok: true, value: { disposition: 'accepted' } });
      expect(count("SELECT count(*) FROM accounting_observations WHERE disposition = 'accepted'")).toBe(
        shapes.length + 2
      );
    });
  });
});
