// FR-R3-163 (feature 202) T024 — the same lie, on two more routes.
//
// `cmd-retry-queue-item.ts` and `cmd-restart-canceled-task.ts` carried the two
// forbidden shapes byte-for-byte identically to `cmd-cancel.ts`: an absent host
// answer defaulted to `{ ok: true }`, read through a cast at a boundary the host
// does not control. Both now relay through `execAndAck`.
//
// Same table as `data-model.md` §1.1, with each route's own refusal vocabulary
// substituted into the middle rows — `queue-ops.ts` and `restart-canceled-task.ts`
// each speak their own (FR-002, FR-003, FR-005, FR-006, FR-007, SC-002).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handler as retryHandler } from '../../../../../src/ui/sidebar/commands/cmd-retry-queue-item';
import { handler as restartHandler } from '../../../../../src/ui/sidebar/commands/cmd-restart-canceled-task';
import {
  CMD_RESTART_CANCELED_TASK,
  CMD_RETRY_QUEUE_ITEM
} from '../../../../../src/contracts/sidebar-ipc';
import { buildRouteCtx, refusalRow, SHARED_ROWS, type AnswerRow } from './route-ack-harness';

interface RouteCase {
  readonly name: string;
  readonly handler: (ctx: never, command: never) => Promise<void>;
  readonly commandId: string;
  readonly command: unknown;
  /** The payload the route must forward unchanged (FR-008). */
  readonly forwarded: unknown;
  readonly refusals: readonly string[];
}

const ROUTES: readonly RouteCase[] = [
  {
    name: 'cmd-retry-queue-item',
    handler: retryHandler as unknown as RouteCase['handler'],
    commandId: 'schegent.retryQueuedItem',
    command: {
      type: CMD_RETRY_QUEUE_ITEM,
      correlationId: 'test-route-ack-1',
      payload: { id: 'queued-7' }
    },
    forwarded: { id: 'queued-7' },
    refusals: ['not-primary', 'invalid-id', 'unexpected-error']
  },
  {
    name: 'cmd-restart-canceled-task',
    handler: restartHandler as unknown as RouteCase['handler'],
    commandId: 'schegent.restartCanceledTask',
    command: {
      type: CMD_RESTART_CANCELED_TASK,
      correlationId: 'test-route-ack-1',
      payload: { taskId: 'task-9' }
    },
    forwarded: { taskId: 'task-9' },
    refusals: ['invalid-taskId', 'not-found', 'illegal-state', 'task-cap-reached']
  }
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(ROUTES.map((route) => [route.name, route] as const))(
  '%s — the acknowledgement matches the host answer',
  (_name, route: RouteCase) => {
    const rows = (): readonly AnswerRow[] => [
      SHARED_ROWS[0]!,
      ...route.refusals.map(refusalRow),
      SHARED_ROWS[1]!,
      SHARED_ROWS[2]!
    ];

    it('forwards its payload unchanged (FR-008)', async () => {
      const { ctx, executeCommandSpy } = buildRouteCtx(async () => ({ ok: true }));
      await route.handler(ctx, route.command as never);
      expect(executeCommandSpy).toHaveBeenCalledWith(route.commandId, route.forwarded);
    });

    it.each(rows().map((row) => [row.label, row] as const))(
      '%s',
      async (_label, row: AnswerRow) => {
        const { ctx, acks } = buildRouteCtx(row.answer);
        await route.handler(ctx, route.command as never);
        expect(acks).toHaveLength(1);
        expect(acks[0]!.status).toBe(row.status);
        expect(acks[0]!.outcome).toBe(row.outcome);
        expect(acks[0]!.reason).toBe(row.reason);
      }
    );

    it('a dispatch that throws is acknowledged as failed, with no message in the ack', async () => {
      const secret = '/Users/someone/private/queue.json';
      const { ctx, acks, sanitize } = buildRouteCtx(() =>
        Promise.reject(new Error(`EACCES ${secret}`))
      );
      await expect(route.handler(ctx, route.command as never)).resolves.toBeUndefined();
      expect(sanitize).toHaveBeenCalledWith(`EACCES ${secret}`);
      expect(acks[0]!.status).toBe('rejected');
      expect(acks[0]!.outcome).toBe('failed');
      expect(acks[0]!.reason).toBe('command-dispatch-failed');
      expect(JSON.stringify(acks[0])).not.toContain(secret);
    });

    it('never produces no-op (FR-009)', async () => {
      const observed = new Set<string | undefined>();
      for (const row of rows()) {
        const { ctx, acks } = buildRouteCtx(row.answer);
        await route.handler(ctx, route.command as never);
        observed.add(acks[0]!.outcome);
      }
      expect(observed.has('no-op')).toBe(false);
    });
  }
);
