// FR-R3-071 (feature 152) — the sidebar's replay-description handler.
//
// The panel that repeats a run seeded its launcher from the 80-char preview,
// so an operator repeating a run replayed a truncation on the surface they
// actually use. This handler is the host half of the fix, and the cases below
// pin the two properties the boundary rests on: the resolver's outcome reaches
// the wire unchanged, and a true "we could not read it" answer acks as
// ACCEPTED rather than through the webview's error path.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handler } from '../../../../../src/ui/sidebar/commands/cmd-resolve-history-description';
import { CMD_RESOLVE_HISTORY_DESCRIPTION } from '../../../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ResolveHistoryDescriptionCommand,
  ResolveHistoryDescriptionResponse
} from '../../../../../src/contracts/sidebar-ipc';
import type { DescriptionResolution } from '../../../../../src/services/history/history-description-resolver';

function buildCtx(service?: { resolve: (runId: string) => Promise<DescriptionResolution | null> }): {
  ctx: Parameters<typeof handler>[0];
  acks: CommandAckMessage[];
  warnings: string[];
} {
  const acks: CommandAckMessage[] = [];
  const warnings: string[] = [];
  const ctx = {
    deps: {
      logger: {
        info: vi.fn(),
        warn: (msg: string) => warnings.push(msg),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      },
      ...(service ? { historyDescriptionService: service } : {})
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-resolve-description-1'
  } as unknown as Parameters<typeof handler>[0];
  return { ctx, acks, warnings };
}

function makeCmd(runId = 'run-1'): ResolveHistoryDescriptionCommand {
  return {
    type: CMD_RESOLVE_HISTORY_DESCRIPTION,
    correlationId: 'test-resolve-description-1',
    payload: { runId }
  } as ResolveHistoryDescriptionCommand;
}

const resultOf = (acks: CommandAckMessage[]): ResolveHistoryDescriptionResponse =>
  (acks[0] as unknown as { result: ResolveHistoryDescriptionResponse }).result;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cmd-resolve-history-description (FR-R3-071)', () => {
  it('returns the resolved sidecar description verbatim', async () => {
    const description = 'the full  sanitized description\nwith its own shape preserved';
    const { ctx, acks } = buildCtx({
      resolve: async () => ({ outcome: 'resolved', description })
    });
    await handler(ctx, makeCmd());
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('accepted');
    expect(resultOf(acks)).toEqual({ outcome: 'resolved', runId: 'run-1', description });
  });

  it('keeps legacy distinct from resolved, and carries its description too', async () => {
    const { ctx, acks } = buildCtx({
      resolve: async () => ({ outcome: 'legacy', description: 'pre-sidecar text' })
    });
    await handler(ctx, makeCmd());
    expect(resultOf(acks)).toEqual({
      outcome: 'legacy',
      runId: 'run-1',
      description: 'pre-sidecar text'
    });
  });

  it('acks missing and unreadable as ACCEPTED — they are answers, not refusals', async () => {
    for (const outcome of ['missing', 'unreadable'] as const) {
      const { ctx, acks } = buildCtx({ resolve: async () => ({ outcome }) });
      await handler(ctx, makeCmd());
      expect(acks[0].status).toBe('accepted');
      expect(resultOf(acks)).toEqual({ outcome, runId: 'run-1' });
    }
  });

  it('reports unknown-run when the id names no history row', async () => {
    const { ctx, acks } = buildCtx({ resolve: async () => null });
    await handler(ctx, makeCmd('run-that-never-was'));
    expect(acks[0].status).toBe('rejected');
    expect(resultOf(acks)).toEqual({ outcome: 'failure', reason: 'unknown-run' });
  });

  it('reports internal-error and logs a CODE, never the caught message', async () => {
    const { ctx, acks, warnings } = buildCtx({
      resolve: async () => {
        throw Object.assign(
          new Error("EACCES: permission denied, open '/Users/someone/work/.schegent/history'"),
          { code: 'EACCES' }
        );
      }
    });
    await handler(ctx, makeCmd());
    expect(acks[0].status).toBe('rejected');
    expect(resultOf(acks)).toEqual({ outcome: 'failure', reason: 'internal-error' });
    expect(warnings.join('\n')).toContain('EACCES');
    // The absolute path an fs error quotes must never reach a log line.
    expect(warnings.join('\n')).not.toContain('/Users/someone');
  });

  it('reports internal-error when no service is wired, rather than throwing', async () => {
    const { ctx, acks } = buildCtx();
    await handler(ctx, makeCmd());
    expect(acks[0].status).toBe('rejected');
    expect(resultOf(acks)).toEqual({ outcome: 'failure', reason: 'internal-error' });
  });
});
