// FR-R3-163 (feature 202) T019-T021 — the cancel route reads the host's answer
// before it acknowledges.
//
// WHAT WAS WRONG. The route defaulted an absent answer to `{ ok: true }`. An
// absent answer is not an ambiguous one: `registerGuardedCommand` returns
// `undefined` — synchronously, not as a rejected promise — when Workspace Trust
// refuses, so the handler never ran. The operator saw "accepted" for a
// cancellation that did not happen, and the Task kept running. The same line
// asserted the answer's shape at a boundary the host does not control, so an
// unrecognized shape also read as success.
//
// Every row of `specs/202-cancel-ack-outcomes/data-model.md` §1.1 is a case
// below. The three that changed an answer are marked; the rest gain the
// `outcome` field and change nothing a consumer reads today (FR-014, SC-016).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handler as cancelHandler } from '../../../../../src/ui/sidebar/commands/cmd-cancel';
import { CMD_CANCEL } from '../../../../../src/contracts/sidebar-ipc';
import type { CancelCommand } from '../../../../../src/contracts/sidebar-ipc';
import { buildRouteCtx, refusalRow, SHARED_ROWS, type AnswerRow } from './route-ack-harness';

const makeCmd = (taskId: string): CancelCommand =>
  ({
    type: CMD_CANCEL,
    correlationId: 'test-route-ack-1',
    payload: { taskId }
  }) as CancelCommand;

/** data-model.md §1.1, in order. `cancel.ts` refuses with these three reasons. */
const ROWS: readonly AnswerRow[] = [
  SHARED_ROWS[0]!,
  refusalRow('illegal-state'),
  refusalRow('not-found'),
  refusalRow('unexpected-error'),
  SHARED_ROWS[1]!,
  SHARED_ROWS[2]!
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cmd-cancel — the acknowledgement matches the host answer (FR-001, FR-004)', () => {
  it('threads the operator-selected taskId to schegent.cancel', () => {
    // Feature 017 / BUG-001. Identity has to survive `globalConcurrencyCap > 1`,
    // so the route forwards the selected id rather than letting the host resolve
    // a singular projection.
    const { ctx, executeCommandSpy } = buildRouteCtx(async () => ({ ok: true }));
    return cancelHandler(ctx, makeCmd('task-42')).then(() => {
      expect(executeCommandSpy).toHaveBeenCalledWith('schegent.cancel', { taskId: 'task-42' });
    });
  });

  it.each(ROWS.map((row) => [row.label, row] as const))(
    '%s',
    async (_label, row: AnswerRow) => {
      const { ctx, acks } = buildRouteCtx(row.answer);
      await cancelHandler(ctx, makeCmd('task-42'));
      expect(acks).toHaveLength(1);
      expect(acks[0]!.status).toBe(row.status);
      expect(acks[0]!.outcome).toBe(row.outcome);
      expect(acks[0]!.reason).toBe(row.reason);
    }
  );

  it('a dispatch that throws is acknowledged as failed, not left unanswered (FR-007)', async () => {
    // Before, the rejection escaped the handler: nothing was ACKed at all and the
    // webview's correlation timed out, telling the operator the host had not
    // answered about a cancellation that may well have run.
    const { ctx, acks } = buildRouteCtx(() => Promise.reject(new Error('command not found')));
    await expect(cancelHandler(ctx, makeCmd('task-42'))).resolves.toBeUndefined();
    expect(acks).toHaveLength(1);
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.outcome).toBe('failed');
    expect(acks[0]!.reason).toBe('command-dispatch-failed');
  });
});

describe('cmd-cancel — no cancel path produces no-op (FR-009)', () => {
  it('every row reaches accepted, refused or failed — never no-op', async () => {
    // STRUCTURAL, not incidental. The host command answers `{ ok, reason }`, and
    // `fromMutationResult` (src/contracts/command-outcome.ts:113-118) maps every
    // `!ok` to `refused`. There is no input to this route that yields `no-op`, so
    // the value is unreachable here rather than merely unused — which is why the
    // correct treatment is to assert its absence rather than to manufacture it.
    const observed = new Set<string | undefined>();
    for (const row of [...ROWS, { answer: () => Promise.reject(new Error('x')) } as AnswerRow]) {
      const { ctx, acks } = buildRouteCtx(row.answer);
      await cancelHandler(ctx, makeCmd('task-42'));
      observed.add(acks[0]!.outcome);
    }
    expect([...observed].sort()).toEqual(['accepted', 'failed', 'refused']);
    expect(observed.has('no-op')).toBe(false);
  });
});

describe('cmd-cancel — the thrown message is sanitized and never crosses to the webview (FR-007)', () => {
  it('logs the sanitized message and puts no message in the ack', async () => {
    const secret = '/Users/someone/private/workspace/run.log';
    const { ctx, acks, warn, sanitize } = buildRouteCtx(() =>
      Promise.reject(new Error(`ENOENT ${secret}`))
    );
    await cancelHandler(ctx, makeCmd('task-42'));

    // The sanitizer produced what was logged — not the raw message that happens
    // to look the same.
    expect(sanitize).toHaveBeenCalledWith(`ENOENT ${secret}`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('dispatch failed');

    // `reason` crosses to the webview, and a message from this layer carries
    // paths. The ack carries a code and nothing else.
    expect(acks[0]!.reason).toBe('command-dispatch-failed');
    expect(JSON.stringify(acks[0])).not.toContain(secret);
    expect(JSON.stringify(acks[0])).not.toContain('ENOENT');
  });

  it('never logs the error object itself, and never the payload', async () => {
    const { ctx, warn } = buildRouteCtx(() => Promise.reject(new Error('boom')));
    await cancelHandler(ctx, makeCmd('task-42'));
    for (const call of warn.mock.calls) {
      for (const arg of call) {
        expect(arg instanceof Error).toBe(false);
        expect(typeof arg).toBe('string');
        expect(arg as string).not.toContain('task-42');
      }
    }
  });
});
