/**
 * FR-R6-F06 (T025, FR-015, NFR-006, contracts/surfaces-and-wiring.md section 1, research R9) —
 * the audit subscriber copies a `phase-end` row onto a bounded queue and returns; a later
 * `setImmediate` drain ingests it. Nothing the service does reaches the audit writer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import {
  type UsageAccountingService,
  createUsageAccountingService
} from '../../../src/services/usage-accounting/usage-accounting-service';
import { createUsageAccountingWiring } from '../../../src/services/usage-accounting/usage-accounting-wiring';
import {
  CLAUDE_ATTEMPT,
  CLAUDE_PHASE_END,
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

function realService(): UsageAccountingService {
  return createUsageAccountingService({ conn, nowUtc: () => NOW, monotonicMs: () => 1, workspaceId: 'ws-1' });
}

function fakeAuditWriter() {
  const listeners: Array<(entry: AuditEntry) => void> = [];
  const disposed = { count: 0 };
  return {
    listeners,
    disposed,
    subscribe: vi.fn((listener: (entry: AuditEntry) => void) => {
      listeners.push(listener);
      return {
        dispose: () => {
          disposed.count += 1;
          listeners.splice(listeners.indexOf(listener), 1);
        }
      };
    }),
    emit(entry: AuditEntry) {
      for (const listener of [...listeners]) listener(entry);
    }
  };
}

function wiringWith(service: UsageAccountingService | null, queueBound?: number) {
  const auditWriter = fakeAuditWriter();
  const subscriptions: Array<{ dispose(): void }> = [];
  const logger = { warn: vi.fn() };
  const wiring = createUsageAccountingWiring({
    service,
    auditWriter,
    subscriptions: { push: (d) => subscriptions.push(d) },
    logger,
    ...(queueBound !== undefined ? { queueBound } : {})
  });
  return { auditWriter, subscriptions, logger, wiring };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function observationCount(): number {
  return Number(conn.scalar('SELECT count(*) FROM accounting_observations') ?? 0);
}

function gapCount(service: UsageAccountingService, kind: string): number {
  const gaps = service.readGaps();
  if (!gaps.ok) throw new Error('gaps unreadable');
  return gaps.value.gaps.filter((gap) => gap.kind === kind).reduce((sum, gap) => sum + gap.count, 0);
}

function phaseEndFor(iteration: number): AuditEntry {
  return phaseEndRow({ iteration, payload: { attemptId: CLAUDE_ATTEMPT, inputTokens: 10 * iteration } });
}

describe('usage accounting wiring (T025)', () => {
  it('subscribes nothing for a null service, and onTerminalRun is a no-op', () => {
    const { auditWriter, subscriptions, wiring } = wiringWith(null);
    expect(auditWriter.subscribe).not.toHaveBeenCalled();
    expect(subscriptions).toHaveLength(0);
    expect(() => wiring.onTerminalRun({ runId: 'run-f06-1', status: 'completed', endedAtMs: 1 })).not.toThrow();
    expect(() => wiring.dispose()).not.toThrow();
  });

  it('queues a phase-end row and ingests it on the next setImmediate, ignoring other rows', async () => {
    const service = realService();
    const { auditWriter, subscriptions } = wiringWith(service);
    expect(auditWriter.subscribe).toHaveBeenCalledTimes(1);
    expect(subscriptions).toHaveLength(1);

    auditWriter.emit(cliInvocationRow({}));
    auditWriter.emit({ ...CLAUDE_PHASE_END, eventType: 'phase-start' });
    auditWriter.emit(CLAUDE_PHASE_END);
    expect(observationCount()).toBe(0);

    await nextTick();
    expect(observationCount()).toBe(1);
    const backend = conn.scalar('SELECT backend FROM accounting_observations');
    expect(backend).toBe('claude');
  });

  it('drops the newest row past the bound and counts admission-overflow', async () => {
    const service = realService();
    const { auditWriter } = wiringWith(service, 2);
    auditWriter.emit(phaseEndFor(1));
    auditWriter.emit(phaseEndFor(2));
    auditWriter.emit(phaseEndFor(3));
    await nextTick();
    expect(observationCount()).toBe(2);
    const kept = conn.all<{ invocation_ordinal: number }>(
      'SELECT invocation_ordinal FROM accounting_observations ORDER BY invocation_ordinal'
    );
    expect(kept.map((row) => Number(row.invocation_ordinal))).toEqual([1, 2]);
    expect(gapCount(service, 'admission-overflow')).toBe(1);
  });

  it('never lets a throwing service reach the subscriber, and logs only errorCode and operation', async () => {
    const leak = new Error(`${LEAK_MARKERS.error} ${LEAK_MARKERS.path}`);
    const recordGaps = vi.fn(() => ({ ok: true as const, value: undefined }));
    const throwing = {
      ...realService(),
      ingestPhaseEnd: () => {
        throw leak;
      },
      recordGaps
    } satisfies UsageAccountingService;
    const { auditWriter, logger } = wiringWith(throwing);

    expect(() => auditWriter.emit(CLAUDE_PHASE_END)).not.toThrow();
    await nextTick();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, context] = logger.warn.mock.calls.at(0) ?? [];
    expect(Object.keys(context ?? {}).sort()).toEqual(['errorCode', 'operation']);
    expect(JSON.stringify([message, context])).not.toContain('LEAK');
    expect(recordGaps).toHaveBeenCalledWith('ingest-failed', 1);
  });

  it('counts a store-error result as ingest-failed', async () => {
    const recordGaps = vi.fn(() => ({ ok: true as const, value: undefined }));
    const refusing = {
      ...realService(),
      ingestPhaseEnd: () => ({ ok: false as const, refusal: { code: 'store-error' as const, detail: 'ingestPhaseEnd' } }),
      recordGaps
    } satisfies UsageAccountingService;
    const { auditWriter } = wiringWith(refusing);
    auditWriter.emit(CLAUDE_PHASE_END);
    await nextTick();
    expect(recordGaps).toHaveBeenCalledWith('ingest-failed', 1);
  });

  it('counts a refusal the store did not count as ingest-failed (FR-015)', async () => {
    const recordGaps = vi.fn(() => ({ ok: true as const, value: undefined }));
    const refusing = {
      ...realService(),
      ingestPhaseEnd: () => ({ ok: false as const, refusal: { code: 'invalid-observation' as const, detail: 'dimensions.phaseId' } }),
      recordRootOutcome: () => ({ ok: false as const, refusal: { code: 'legacy-epoch-overlap' as const } }),
      recordGaps
    } satisfies UsageAccountingService;
    const { auditWriter, wiring } = wiringWith(refusing);
    auditWriter.emit(CLAUDE_PHASE_END);
    wiring.onTerminalRun({ runId: 'run-f06-1', status: 'completed', endedAtMs: Date.parse(NOW) });
    await nextTick();
    expect(recordGaps).toHaveBeenCalledWith('ingest-failed', 2);
  });

  it('does not count a refusal twice when the store already counted its gap', async () => {
    const recordGaps = vi.fn(() => ({ ok: true as const, value: undefined }));
    const refusing = {
      ...realService(),
      ingestPhaseEnd: () => ({ ok: false as const, refusal: { code: 'telemetry-echo' as const } }),
      recordGaps
    } satisfies UsageAccountingService;
    const { auditWriter } = wiringWith(refusing);
    auditWriter.emit(CLAUDE_PHASE_END);
    await nextTick();
    expect(recordGaps).not.toHaveBeenCalled();
  });

  it('keeps a gap count in memory when the store cannot take it, and flushes it later', async () => {
    let calls = 0;
    const recordGaps = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error('store down');
      return { ok: true as const, value: undefined };
    });
    const flaky = {
      ...realService(),
      ingestPhaseEnd: () => ({ ok: false as const, refusal: { code: 'store-error' as const, detail: 'ingestPhaseEnd' } }),
      recordGaps
    } satisfies UsageAccountingService;
    const { auditWriter } = wiringWith(flaky);
    auditWriter.emit(phaseEndFor(1));
    await nextTick();
    auditWriter.emit(phaseEndFor(2));
    await nextTick();
    expect(recordGaps).toHaveBeenLastCalledWith('ingest-failed', 2);
  });

  it('unsubscribes and drops queued rows on dispose', async () => {
    const service = realService();
    const { auditWriter, subscriptions, wiring } = wiringWith(service);
    auditWriter.emit(CLAUDE_PHASE_END);
    wiring.dispose();
    await nextTick();
    expect(auditWriter.disposed.count).toBe(1);
    expect(observationCount()).toBe(0);
    for (const subscription of subscriptions) subscription.dispose();
    expect(auditWriter.disposed.count).toBe(1);
  });
});
