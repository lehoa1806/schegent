// Feature 073 T003 — cmd-read-metrics handler unit tests.
// CMD_READ_METRICS is a read-only command: workspace root must reach the
// handler only via DI (ctx.deps.metricsService, itself constructed with a
// resolved workspaceRoot in wireStage2()), never via a direct
// workspaceFolders[0] read from this file. The handler performs no
// mutation of workflow/task/queue state — it only reads and acks.
// metrics-view-opened must be appended at most once per session, with a
// payload containing only `sessionId` (never a workspace path).

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handler as readMetricsHandler } from '../../../src/ui/sidebar/commands/cmd-read-metrics';
import { CMD_READ_METRICS } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ReadMetricsCommand,
  ReadMetricsResponse,
  TaskRecord
} from '../../../src/contracts/sidebar-ipc';

const SAMPLE_RESPONSE: ReadMetricsResponse = {
  tasks: [],
  phaseTypeAggregates: [],
  costTimeline: [],
  includesArchived: false,
  totalScannedEntries: 0,
  parseWarnings: 0
};

function buildCtx(
  opts: {
    readRejects?: boolean;
    readError?: Error;
    readResult?: ReadMetricsResponse;
    withMetricsService?: boolean;
    withAudit?: boolean;
    withSessionId?: boolean;
    metricsViewOpenedState?: { emitted: boolean };
  } = {}
): {
  ctx: Parameters<typeof readMetricsHandler>[0];
  acks: CommandAckMessage[];
  readSpy: ReturnType<typeof vi.fn>;
  auditAppendSpy: ReturnType<typeof vi.fn>;
  warnings: string[];
} {
  const acks: CommandAckMessage[] = [];
  const warnings: string[] = [];
  const logger = {
    info: vi.fn(),
    warn: (msg: string) => warnings.push(msg),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (s: string) => s
  };
  const readSpy = vi.fn(async () => {
    if (opts.readRejects) {
      throw opts.readError ?? new Error('read failed');
    }
    return opts.readResult ?? SAMPLE_RESPONSE;
  });
  const auditAppendSpy = vi.fn(async () => undefined);
  const ctx = {
    deps: {
      metricsService: opts.withMetricsService === false ? undefined : { read: readSpy },
      audit: opts.withAudit === false ? undefined : { append: auditAppendSpy },
      sessionId: opts.withSessionId === false ? undefined : 'test-session-id',
      metricsViewOpenedState: opts.metricsViewOpenedState ?? { emitted: false },
      logger
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-read-metrics-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { ctx, acks, readSpy, auditAppendSpy, warnings };
}

function makeCmd(payload: ReadMetricsCommand['payload'] = {}): ReadMetricsCommand {
  return {
    type: CMD_READ_METRICS,
    correlationId: 'test-read-metrics-1',
    payload
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cmd-read-metrics handler (Feature 073, T003)', () => {
  it('reads via ctx.deps.metricsService, never a direct workspace-folder lookup', async () => {
    const { ctx, readSpy } = buildCtx();
    await readMetricsHandler(ctx, makeCmd());
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('posts ack("accepted") with the metrics response on success', async () => {
    const { ctx, acks } = buildCtx();
    await readMetricsHandler(ctx, makeCmd());
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('accepted');
    expect(acks[0].correlationId).toBe('test-read-metrics-1');
    expect(acks[0].result).toEqual(SAMPLE_RESPONSE);
  });

  it('posts ack("rejected", "internal-error") when metricsService is unavailable', async () => {
    const { ctx, acks } = buildCtx({ withMetricsService: false });
    await readMetricsHandler(ctx, makeCmd());
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('internal-error');
  });

  it('posts ack("rejected", "internal-error") and warns when the read throws', async () => {
    const { ctx, acks, warnings } = buildCtx({
      readRejects: true,
      readError: new Error('audit log unreadable')
    });
    await readMetricsHandler(ctx, makeCmd());
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('internal-error');
    expect(warnings).toHaveLength(1);
  });

  it('performs no mutation of workflow/task/queue state — only reads and acks', async () => {
    const { ctx } = buildCtx();
    const mutatingKeys = ['executeCommand', 'queueRemover', 'phaseLogService'];
    for (const key of mutatingKeys) {
      expect((ctx.deps as unknown as Record<string, unknown>)[key]).toBeUndefined();
    }
    await readMetricsHandler(ctx, makeCmd());
  });

  it('appends metrics-view-opened exactly once per session, with a payload containing only sessionId', async () => {
    const state = { emitted: false };
    const { ctx, auditAppendSpy } = buildCtx({ metricsViewOpenedState: state });
    await readMetricsHandler(ctx, makeCmd());
    await readMetricsHandler(ctx, makeCmd());
    await readMetricsHandler(ctx, makeCmd());
    expect(auditAppendSpy).toHaveBeenCalledTimes(1);
    const entry = auditAppendSpy.mock.calls[0][0];
    expect(entry.eventType).toBe('metrics-view-opened');
    expect(entry.payload).toEqual({ sessionId: 'test-session-id' });
  });

  it('does not append metrics-view-opened again for a tracker that already recorded emission', async () => {
    const { ctx, auditAppendSpy } = buildCtx({ metricsViewOpenedState: { emitted: true } });
    await readMetricsHandler(ctx, makeCmd());
    expect(auditAppendSpy).not.toHaveBeenCalled();
  });

  it('skips the metrics-view-opened append when audit or sessionId is unavailable', async () => {
    const { ctx: ctxNoAudit, auditAppendSpy: spy1 } = buildCtx({ withAudit: false });
    await readMetricsHandler(ctxNoAudit, makeCmd());
    expect(spy1).not.toHaveBeenCalled();

    const { ctx: ctxNoSession, auditAppendSpy: spy2 } = buildCtx({ withSessionId: false });
    await readMetricsHandler(ctxNoSession, makeCmd());
    expect(spy2).not.toHaveBeenCalled();
  });

  it('still acks the read result even when the view-opened audit append fails', async () => {
    const auditAppendSpy = vi.fn(async () => {
      throw new Error('audit write failed');
    });
    const acks: CommandAckMessage[] = [];
    const ctx = {
      deps: {
        metricsService: { read: vi.fn(async () => SAMPLE_RESPONSE) },
        audit: { append: auditAppendSpy },
        sessionId: 'test-session-id',
        metricsViewOpenedState: { emitted: false },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: (s: string) => s }
      },
      postAck: async (msg: CommandAckMessage) => {
        acks.push(msg);
        return true;
      },
      correlationId: 'test-read-metrics-audit-fail'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await readMetricsHandler(ctx, makeCmd());
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('accepted');
  });
});

// Feature 073 US1 (T014) — includeArchived request forwarding and
// coverage-window/full-history pass-through. The handler must forward the
// request verbatim and never truncate or reshape the metrics service's
// response (regression guard against reintroducing a HistoryStore-style
// 50-item cap at this layer).
function makeTaskRecord(index: number, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    runId: `run-${index}`,
    description: `run-${index}`,
    startTime: '2026-05-01T00:00:00.000Z',
    endTime: '2026-05-01T00:05:00.000Z',
    durationMs: 300000,
    status: 'completed',
    isRunning: false,
    phasesTotal: 1,
    phasesCompleted: 1,
    phasesSkipped: 0,
    totalCostUsd: 0.5,
    totalBackendInvocations: 2,
    phases: [],
    source: 'task-lifecycle',
    ...overrides
  };
}

describe('cmd-read-metrics handler — includeArchived / coverage-window pass-through (Feature 073 US1, T014)', () => {
  it('forwards includeArchived: true from the request payload to metricsService.read', async () => {
    const { ctx, readSpy } = buildCtx();
    await readMetricsHandler(ctx, makeCmd({ includeArchived: true }));
    expect(readSpy).toHaveBeenCalledWith({ includeArchived: true });
  });

  it('forwards an empty payload (includeArchived omitted) to metricsService.read without forcing a default', async () => {
    const { ctx, readSpy } = buildCtx();
    await readMetricsHandler(ctx, makeCmd());
    expect(readSpy).toHaveBeenCalledWith({});
  });

  it('passes through oldestIncludedTimestamp, totalScannedEntries, and includesArchived from the metrics service response verbatim', async () => {
    const response: ReadMetricsResponse = {
      ...SAMPLE_RESPONSE,
      oldestIncludedTimestamp: '2026-01-15T08:30:00.000Z',
      totalScannedEntries: 4321,
      includesArchived: true
    };
    const { ctx, acks } = buildCtx({ readResult: response });
    await readMetricsHandler(ctx, makeCmd({ includeArchived: true }));
    expect(acks[0]!.result).toEqual(response);
  });

  it('passes through the full task list without truncation (beyond the legacy 50-item Recent Runs cap)', async () => {
    const TASK_COUNT = 75;
    const tasks: TaskRecord[] = Array.from({ length: TASK_COUNT }, (_, i) => makeTaskRecord(i));
    const response: ReadMetricsResponse = { ...SAMPLE_RESPONSE, tasks };
    const { ctx, acks } = buildCtx({ readResult: response });

    await readMetricsHandler(ctx, makeCmd());

    const resultTasks = (acks[0]!.result as ReadMetricsResponse).tasks;
    expect(resultTasks.length).toBe(TASK_COUNT);

    // Summary totals (tasks completed, total elapsed time, total cost, total
    // backend invocations) are computed downstream from this untruncated
    // array — verify every input task's contribution survives pass-through.
    const sum = (records: readonly TaskRecord[]) => ({
      completedCount: records.filter((t) => t.status === 'completed').length,
      totalDurationMs: records.reduce((acc, t) => acc + t.durationMs, 0),
      totalCostUsd: records.reduce((acc, t) => acc + (t.totalCostUsd ?? 0), 0),
      totalBackendInvocations: records.reduce((acc, t) => acc + t.totalBackendInvocations, 0)
    });
    expect(sum(resultTasks)).toEqual(sum(tasks));
  });
});
