// FR-R5-F19 (feature 278, T19.1, FR-003 to FR-005) — the sidebar's "open the decision record" handler.
//
// The handler is thin: it passes the row id to the opener and acks the answer. Every one of the nine
// outcomes is a true answer to the question asked and acks as ACCEPTED, unchanged, so the panel can give
// each its own sentence; only a missing or throwing opener is `rejected`/`internal-error`. A throw is
// logged by code and never by row id, path or message. Modelled on `cmd-read-failure-record.test.ts`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DECISION_RECORD_OUTCOMES } from '../../../../../src/contracts/decision-record';
import { CMD_OPEN_DECISION_RECORD } from '../../../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  OpenDecisionRecordCommand,
  OpenDecisionRecordResponse
} from '../../../../../src/contracts/sidebar-ipc';
import { handler } from '../../../../../src/ui/sidebar/commands/cmd-open-decision-record';

type Open = (request: { rowId: string }) => Promise<OpenDecisionRecordResponse>;

function buildCtx(open?: Open): {
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
      ...(open === undefined ? {} : { openDecisionRecord: open })
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-open-decision-record-1'
  } as unknown as Parameters<typeof handler>[0];
  return { ctx, acks, warnings };
}

function makeCmd(rowId = 'task-1'): OpenDecisionRecordCommand {
  return {
    type: CMD_OPEN_DECISION_RECORD,
    correlationId: 'test-open-decision-record-1',
    payload: { rowId }
  } as OpenDecisionRecordCommand;
}

const resultOf = (acks: CommandAckMessage[]): OpenDecisionRecordResponse =>
  (acks.at(0) as unknown as { result: OpenDecisionRecordResponse }).result;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cmd-open-decision-record', () => {
  it.each(DECISION_RECORD_OUTCOMES)('acks the %s answer as accepted, with the response unchanged', async (outcome) => {
    const { ctx, acks } = buildCtx(async () => ({ outcome }));
    await handler(ctx, makeCmd());
    expect(acks).toHaveLength(1);
    expect(acks.at(0)?.status).toBe('accepted');
    expect(resultOf(acks)).toEqual({ outcome });
    expect((acks.at(0) as { reason?: string }).reason).toBeUndefined();
  });

  it('passes the row id to the opener and nothing else', async () => {
    const open = vi.fn<Open>(async () => ({ outcome: 'opened' }));
    const { ctx } = buildCtx(open);
    await handler(ctx, makeCmd('task-7'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls.at(0)?.at(0)).toEqual({ rowId: 'task-7' });
  });

  it('rejects with internal-error when no opener is wired', async () => {
    const { ctx, acks } = buildCtx();
    await handler(ctx, makeCmd());
    expect(acks.at(0)?.status).toBe('rejected');
    expect((acks.at(0) as { reason?: string }).reason).toBe('internal-error');
  });

  it('rejects with internal-error when the opener throws, and logs a code without the row id, path or message', async () => {
    const { ctx, acks, warnings } = buildCtx(async () => {
      throw new TypeError('ENOENT /Users/someone/work/specs/x/decisions.md for task-secret-row');
    });
    await handler(ctx, makeCmd('task-secret-row'));
    expect(acks.at(0)?.status).toBe('rejected');
    expect((acks.at(0) as { reason?: string }).reason).toBe('internal-error');
    expect(warnings).toHaveLength(1);
    const line = String(warnings.at(0)?.at(0));
    expect(line).toContain('TypeError');
    expect(line).not.toContain('task-secret-row');
    expect(line).not.toContain('/Users/');
    expect(line).not.toContain('decisions.md');
  });
});
