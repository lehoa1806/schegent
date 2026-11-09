// FR-R6-F06 (T029, contracts/surfaces-and-wiring.md section 4, clarification 6) — the sidebar's
// usage accounting handler.
//
// Read-only, so it takes no primacy, trust or confirmation gate. What it must guarantee: for the
// same request the ack carries exactly the headless answer, an invalid query is refused with the
// same `invalid-query` result, a window with no reader answers `store-unavailable`, and a throwing
// reader is logged by code only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CMD_READ_USAGE_ACCOUNTING } from '../../../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ReadUsageAccountingCommand,
  UsageAccountingReader
} from '../../../../../src/contracts/sidebar-ipc';
import { createUsageAccountingReader, queryUsageAccounting } from '../../../../../src/headless/usage-accounting-api';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../../../src/services/sqlite-store';
import { PhaseEndCorrelator } from '../../../../../src/services/usage-accounting/phase-end-ingestion';
import { createUsageAccountingService } from '../../../../../src/services/usage-accounting/usage-accounting-service';
import { handler } from '../../../../../src/ui/sidebar/commands/cmd-read-usage-accounting';
import { CLAUDE_PHASE_END, LEAK_MARKERS, cliInvocationRow } from '../../../../fixtures/usage-accounting/phase-end-rows';

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

function seededReader(): UsageAccountingReader {
  const service = createUsageAccountingService({ conn, nowUtc: () => NOW, monotonicMs: () => 1, workspaceId: 'ws-1' });
  const correlator = new PhaseEndCorrelator();
  correlator.observe(cliInvocationRow({}));
  const snapshot = correlator.observe(CLAUDE_PHASE_END);
  if (snapshot === undefined) throw new Error('no snapshot');
  service.ingestPhaseEnd(snapshot);
  return createUsageAccountingReader(service);
}

function buildCtx(reader?: UsageAccountingReader): {
  ctx: Parameters<typeof handler>[0];
  acks: CommandAckMessage[];
  warnings: unknown[][];
} {
  const acks: CommandAckMessage[] = [];
  const warnings: unknown[][] = [];
  const ctx = {
    deps: {
      logger: {
        info: vi.fn(),
        warn: (...args: unknown[]) => warnings.push(args),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      },
      ...(reader === undefined ? {} : { usageAccounting: reader })
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-usage-accounting-1'
  } as unknown as Parameters<typeof handler>[0];
  return { ctx, acks, warnings };
}

function makeCmd(query: unknown): ReadUsageAccountingCommand {
  return {
    type: CMD_READ_USAGE_ACCOUNTING,
    correlationId: 'test-usage-accounting-1',
    payload: { query }
  } as ReadUsageAccountingCommand;
}

function onlyAck(acks: CommandAckMessage[]): CommandAckMessage & { result?: unknown } {
  expect(acks).toHaveLength(1);
  const first = acks.at(0);
  if (first === undefined) throw new Error('no ack');
  return first as CommandAckMessage & { result?: unknown };
}

describe('cmd-read-usage-accounting (T029)', () => {
  it('acks exactly the headless answer for the same request', async () => {
    const reader = seededReader();
    const headless = queryUsageAccounting(reader, QUERY);
    expect(headless.ok).toBe(true);
    const { ctx, acks } = buildCtx(reader);
    await handler(ctx, makeCmd(QUERY));
    const ackMessage = onlyAck(acks);
    expect(ackMessage.status).toBe('accepted');
    expect(ackMessage.result).toEqual(headless);
  });

  it('refuses an invalid query with the headless invalid-query answer', async () => {
    const reader = seededReader();
    const invalid = { ...QUERY, limit: 0 };
    const headless = queryUsageAccounting(reader, invalid);
    const { ctx, acks } = buildCtx(reader);
    await handler(ctx, makeCmd(invalid));
    const ackMessage = onlyAck(acks);
    expect(ackMessage.status).toBe('rejected');
    expect(ackMessage.reason).toBe('invalid-query');
    expect(ackMessage.result).toEqual(headless);
    expect(ackMessage.result).toEqual({ ok: false, refusal: { code: 'invalid-query', detail: 'limit' } });
  });

  it('answers store-unavailable with no reader, and with the null reader', async () => {
    const unavailable = { ok: false, refusal: { code: 'store-unavailable' } };
    for (const reader of [undefined, createUsageAccountingReader(null)]) {
      const { ctx, acks } = buildCtx(reader);
      await handler(ctx, makeCmd(QUERY));
      const ackMessage = onlyAck(acks);
      expect(ackMessage.status).toBe('rejected');
      expect(ackMessage.reason).toBe('store-unavailable');
      expect(ackMessage.result).toEqual(unavailable);
    }
  });

  it('logs a throwing reader by code only and acks store-error', async () => {
    const leak = new Error(`${LEAK_MARKERS.error} ${LEAK_MARKERS.path}`);
    const reader: UsageAccountingReader = {
      query: () => {
        throw leak;
      },
      readGaps: vi.fn(),
      readQualifications: vi.fn()
    } as unknown as UsageAccountingReader;
    const { ctx, acks, warnings } = buildCtx(reader);
    await handler(ctx, makeCmd(QUERY));
    const ackMessage = onlyAck(acks);
    expect(ackMessage.status).toBe('rejected');
    expect(ackMessage.reason).toBe('store-error');
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain('LEAK');
  });
});
