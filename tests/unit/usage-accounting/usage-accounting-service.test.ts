/**
 * FR-R6-F06 (T020, contracts/accounting-service.md) — the facade: results, not throws.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import type { AccountingObservationInput } from '../../../src/services/usage-accounting/observation-normalizer';
import {
  type AccountingLogger,
  createUsageAccountingService
} from '../../../src/services/usage-accounting/usage-accounting-service';

const NOW = '2026-11-10T12:00:00.000Z';

let conn: NodeSqliteConnection;

beforeEach(() => {
  conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => Date.parse(NOW));
});

afterEach(() => {
  if (conn.db.isOpen) conn.close();
});

const input: AccountingObservationInput = {
  producerNamespace: 'schegent.phase-end/1',
  source: 'phase-end',
  sourceKind: 'phase-end',
  sourceIdentity: 'run-1:phase-a:0',
  rootId: 'root-1',
  attemptId: 'attempt-1',
  counterScope: 'invocation-delta',
  adapterVersion: 'claude/1',
  eventUtc: '2026-11-10T11:59:00.000Z',
  observedUtc: '2026-11-10T11:59:01.000Z',
  measures: [{ measure: 'input_tokens', quantity: 7, unit: 'count', provenance: 'provider-reported' }]
};

function service(extra: Partial<Parameters<typeof createUsageAccountingService>[0]> = {}) {
  return createUsageAccountingService({
    conn,
    nowUtc: () => NOW,
    monotonicMs: () => 5,
    workspaceId: 'ws-1',
    ...extra
  });
}

describe('usage accounting service (T020)', () => {
  it('ingests, projects and reports the committed revision', () => {
    const result = service().ingestObservation(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.disposition).toBe('accepted');
    expect(result.value.revision).toBe(1);
    const replay = service().ingestObservation(input);
    expect(replay.ok && replay.value).toEqual({ observationId: result.value.observationId, disposition: 'duplicate', revision: null });
  });

  it('returns a null revision when the projection fails, and construction applies it later', () => {
    const failing = service({
      projectionFailpoint: () => {
        throw new Error('injected');
      }
    });
    const result = failing.ingestObservation(input);
    expect(result.ok && result.value.revision).toBeNull();
    expect(Number(conn.scalar("SELECT count(*) FROM accounting_projection_intents WHERE state = 'pending'"))).toBe(1);
    service();
    expect(Number(conn.scalar("SELECT count(*) FROM accounting_projection_intents WHERE state = 'pending'"))).toBe(0);
  });

  it('turns an unexpected store error into store-error and logs only the operation and code', () => {
    const lines: unknown[] = [];
    const logger: AccountingLogger = { warn: (message, context) => lines.push({ message, context }) };
    const accounting = service({ logger });
    conn.exec('DROP TABLE accounting_projection_intents');
    const result = accounting.ingestObservation(input);
    expect(result).toEqual({ ok: false, refusal: { code: 'store-error', detail: 'ingestObservation' } });
    expect(lines).toHaveLength(1);
    const line = lines.at(0) as { context: Record<string, unknown> };
    expect(Object.keys(line.context).sort()).toEqual(['errorCode', 'operation']);
    expect(conn.db.isTransaction).toBe(false);
  });

  it('returns a domain refusal as a value', () => {
    const result = service().ingestObservation({ ...input, attemptId: '../x' });
    expect(result).toEqual({ ok: false, refusal: { code: 'invalid-observation', detail: 'attemptId' } });
  });
});
