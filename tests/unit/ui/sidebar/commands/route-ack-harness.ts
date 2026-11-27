// FR-R3-163 (feature 202) — the shared harness for the three routes this
// feature corrected. Modelled on `cmd-clear-queue.test.ts:23-50`, which is the
// FR-R3-154 route that already relayed through `execAndAck`.
//
// Factored out rather than triplicated because all three routes are now one line
// and their tables differ only in the refusal vocabulary each host command
// speaks. It lives outside any `.test.ts` so importing it does not re-register
// another file's suite.

import { vi } from 'vitest';

import type { CommandAckMessage } from '../../../../../src/contracts/sidebar-ipc';

export interface RouteHarness {
  readonly ctx: never;
  readonly acks: CommandAckMessage[];
  readonly executeCommandSpy: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly sanitize: ReturnType<typeof vi.fn>;
}

/**
 * A handler context whose `executeCommand` answers however the caller says.
 *
 * `sanitize` is a spy over the identity function: identity so a test can read
 * what reached the log, a spy so a test can prove the sanitizer was the thing
 * that produced it. The distinction matters for FR-007 — a route that logged the
 * raw message would look identical without it.
 */
export function buildRouteCtx(executeCommandImpl: (...args: unknown[]) => unknown): RouteHarness {
  const acks: CommandAckMessage[] = [];
  const executeCommandSpy = vi.fn(executeCommandImpl);
  const warn = vi.fn();
  const sanitize = vi.fn((value: string) => value);
  const ctx = {
    deps: {
      executeCommand: executeCommandSpy,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), sanitize }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-route-ack-1'
  } as unknown as never;
  return { ctx, acks, executeCommandSpy, warn, sanitize };
}

/** One row of the data-model.md §1.1 table, as a case a route test can run. */
export interface AnswerRow {
  /** What the host command answered, or how it failed. */
  readonly answer: () => unknown;
  readonly status: 'accepted' | 'rejected';
  readonly outcome: 'accepted' | 'no-op' | 'refused' | 'failed';
  readonly reason?: string;
  readonly label: string;
}

/**
 * The four rows every one of the three routes shares, in the order
 * data-model.md §1.1 lists them. The three middle refusal rows are supplied per
 * route, because each host command speaks its own vocabulary.
 */
export const SHARED_ROWS: readonly AnswerRow[] = [
  {
    label: 'ok:true acknowledges acceptance',
    answer: () => ({ ok: true }),
    status: 'accepted',
    outcome: 'accepted'
  },
  {
    label: 'undefined is a NAMED trust refusal, not an acceptance',
    answer: () => undefined,
    status: 'rejected',
    outcome: 'refused',
    reason: 'workspace-not-trusted'
  },
  {
    label: 'an unrecognized shape is a failure, not an acceptance',
    answer: () => ({ surprise: true }),
    status: 'rejected',
    outcome: 'failed',
    reason: 'command-result-unrecognized'
  }
];

/** A refusal row for a route's own vocabulary. */
export const refusalRow = (reason: string): AnswerRow => ({
  label: `a ${reason} refusal keeps its reason unchanged`,
  answer: () => ({ ok: false, reason }),
  status: 'rejected',
  outcome: 'refused',
  reason
});
