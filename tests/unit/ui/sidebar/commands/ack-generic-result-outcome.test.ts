// FR-R3-163 (feature 202) T028-T029 — `ackGenericResult` sets an outcome, and
// changes nothing else.
//
// This helper was the last ack path that emitted no `outcome` field. Its
// seventeen callers therefore answered with a bare `status`, while every route
// that went through `execAndAck` answered with a status refined by an outcome.
//
// THE RISK THIS FILE PINS is not that the outcome is wrong — it is that adding
// it quietly changed `status` or `reason` for someone. The BEFORE columns below
// are the recorded observation from `data-model.md` §1.2, taken against the
// hand-written mapping this replaced; each case asserts the corrected helper
// still produces them byte-for-byte, and that `outcome` is the ONLY key that
// appeared (FR-013, SC-005, SC-006).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ackGenericResult } from '../../../../../src/ui/sidebar/commands/handler-helpers';
import { COMMAND_ACK_OUTCOMES } from '../../../../../src/contracts/command-outcome';
import type { CommandAckMessage } from '../../../../../src/contracts/sidebar-ipc';

function buildCtx(): { ctx: never; acks: CommandAckMessage[] } {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      executeCommand: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-ack-generic-1'
  } as unknown as never;
  return { ctx, acks };
}

/** data-model.md §1.2. `before` is what the hand-written mapping produced. */
const ROWS = [
  {
    label: 'ok:true',
    result: { ok: true },
    before: { status: 'accepted' as const, reason: undefined },
    outcome: 'accepted'
  },
  {
    label: 'ok:false with a reason keeps that reason',
    result: { ok: false, reason: 'not-primary' },
    before: { status: 'rejected' as const, reason: 'not-primary' },
    outcome: 'refused'
  },
  {
    label: 'ok:false with NO reason keeps the unexplained-rejection code',
    result: { ok: false },
    before: { status: 'rejected' as const, reason: 'operation-rejected' },
    outcome: 'refused'
  }
];

/** The keys the helper produced before this change. */
const KEYS_BEFORE = ['type', 'correlationId', 'status'];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ackGenericResult — status and reason are unchanged (FR-013, SC-006)', () => {
  it.each(ROWS.map((row) => [row.label, row] as const))('%s', async (_label, row) => {
    const { ctx, acks } = buildCtx();
    await ackGenericResult(ctx, row.result);

    expect(acks).toHaveLength(1);
    expect(acks[0]!.status).toBe(row.before.status);
    expect(acks[0]!.reason).toBe(row.before.reason);
    expect(acks[0]!.outcome).toBe(row.outcome);
  });

  it.each(ROWS.map((row) => [row.label, row] as const))(
    'adds `outcome` and no other key: %s',
    async (_label, row) => {
      const { ctx, acks } = buildCtx();
      await ackGenericResult(ctx, row.result);

      const expected = [
        ...KEYS_BEFORE,
        'outcome',
        ...(row.before.reason !== undefined ? ['reason'] : [])
      ].sort();
      expect(Object.keys(acks[0]!).sort()).toEqual(expected);
    }
  );
});

describe('ackGenericResult — reachable outcomes are accepted and refused ONLY (FR-032)', () => {
  it('no input to this helper produces no-op or failed', async () => {
    // The argument is a result already in hand, so there is no dispatch to fail;
    // and `fromMutationResult` maps every `!ok` to `refused`, so `no-op` has no
    // producer here. Seventeen routes gain an outcome FIELD, not new outcome
    // VALUES — which is what makes this change invisible to every consumer.
    const observed = new Set<string | undefined>();
    for (const result of [
      { ok: true },
      { ok: false },
      { ok: false, reason: 'not-primary' },
      { ok: false, reason: '' }
    ]) {
      const { ctx, acks } = buildCtx();
      await ackGenericResult(ctx, result);
      observed.add(acks[0]!.outcome);
    }
    expect([...observed].sort()).toEqual(['accepted', 'refused']);
  });

  it('the four-outcome vocabulary itself is untouched', () => {
    // X1: no member added to or removed from the contract. Pinned here because
    // "the helper reaches two of them" is only meaningful if the set is still four.
    expect([...COMMAND_ACK_OUTCOMES]).toEqual(['accepted', 'no-op', 'refused', 'failed']);
  });
});
