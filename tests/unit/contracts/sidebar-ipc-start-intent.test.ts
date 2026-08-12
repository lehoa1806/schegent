// Feature 065 (T020) — Runtime validator tests for the optional
// `startIntent` payload on `CMD_START` and `CMD_START_QUEUE`. Pins the
// host's IPC validator against the contract diff in
// specs/065-enqueue-start-separation/contracts/sidebar-ipc.diff.md.
//
// Key rules under test:
//   - Omission of `startIntent` is ALWAYS valid (additive).
//   - `EnqueueStartIntent.startMode` accepts 'now' | 'scheduled' only.
//   - `StartQueueIntent.startMode` accepts 'now' | 'scheduled' | 'cancel-schedule'.
//   - `'cancel-schedule'` is REJECTED on `CMD_START` and ACCEPTED on `CMD_START_QUEUE`.
//   - `StartQueueIntent.source` MUST be the literal 'operator-restart'; every
//     other source ('operator-chooser', 'programmatic-now', etc.) is rejected.
//   - `'now'` + `scheduledStartAt` is rejected.
//   - Non-finite / non-positive `scheduledStartAt` is rejected on 'scheduled'.

import { describe, expect, it } from 'vitest';
import {
  CMD_START,
  CMD_START_QUEUE,
  isCmdStart,
  isCmdStartQueue
} from '../../../src/contracts/sidebar-ipc';
import { validateInboundMessage } from '../../../src/contracts/runtime-validators';

const FIXTURE_CORRELATION_ID = 'test-correlation-id';

function startMsg(startIntent: unknown, description = 'desc'): unknown {
  return {
    type: CMD_START,
    correlationId: FIXTURE_CORRELATION_ID,
    payload: { description, startIntent }
  };
}

function startQueueMsg(startIntent: unknown): unknown {
  return {
    type: CMD_START_QUEUE,
    correlationId: FIXTURE_CORRELATION_ID,
    payload: { startIntent }
  };
}

// BUG-002 lockstep: there are TWO parallel validator surfaces (predicate
// path via `isCmd*` in sidebar-ipc.ts and parser path via
// `validateInboundMessage` in runtime-validators.ts). They MUST agree on
// the same shapes. The original BUG-002 was that the predicate accepted
// `startIntent` while the parser dropped it as `unexpected-payload-fields`.
function parserAccepts(msg: unknown): boolean {
  return validateInboundMessage(msg).ok;
}

describe('Feature 065 — CMD_START runtime validator', () => {
  it('accepts CMD_START without startIntent (back-compat)', () => {
    expect(
      isCmdStart({
        type: CMD_START,
        correlationId: FIXTURE_CORRELATION_ID,
        payload: { description: 'desc' }
      })
    ).toBe(true);
  });

  it('accepts startMode=now with no scheduledStartAt', () => {
    expect(
      isCmdStart(startMsg({ startMode: 'now', source: 'operator-chooser' }))
    ).toBe(true);
  });

  it('accepts startMode=scheduled with a valid positive timestamp', () => {
    expect(
      isCmdStart(
        startMsg({
          startMode: 'scheduled',
          scheduledStartAt: 1_700_000_000_000,
          source: 'operator-chooser'
        })
      )
    ).toBe(true);
  });

  it('accepts every legal source literal on CMD_START', () => {
    const sources = [
      'operator-chooser',
      'operator-restart',
      'programmatic-now',
      'programmatic-scheduled',
      'migration-default'
    ];
    for (const source of sources) {
      expect(isCmdStart(startMsg({ startMode: 'now', source }))).toBe(true);
    }
  });

  it('rejects startMode=now combined with scheduledStartAt', () => {
    expect(
      isCmdStart(
        startMsg({
          startMode: 'now',
          scheduledStartAt: 1_700_000_000_000,
          source: 'operator-chooser'
        })
      )
    ).toBe(false);
  });

  it('rejects startMode=cancel-schedule on CMD_START', () => {
    expect(
      isCmdStart(
        startMsg({ startMode: 'cancel-schedule', source: 'operator-restart' })
      )
    ).toBe(false);
  });

  it('rejects invalid source literals on CMD_START', () => {
    expect(
      isCmdStart(startMsg({ startMode: 'now', source: 'unknown-source' }))
    ).toBe(false);
  });

  it('rejects non-finite or zero scheduledStartAt', () => {
    expect(
      isCmdStart(
        startMsg({
          startMode: 'scheduled',
          scheduledStartAt: 0,
          source: 'operator-chooser'
        })
      )
    ).toBe(false);
    expect(
      isCmdStart(
        startMsg({
          startMode: 'scheduled',
          scheduledStartAt: Number.NaN,
          source: 'operator-chooser'
        })
      )
    ).toBe(false);
    expect(
      isCmdStart(
        startMsg({
          startMode: 'scheduled',
          scheduledStartAt: Number.POSITIVE_INFINITY,
          source: 'operator-chooser'
        })
      )
    ).toBe(false);
  });
});

describe('Feature 065 — CMD_START_QUEUE runtime validator', () => {
  it('accepts CMD_START_QUEUE with no payload (back-compat)', () => {
    expect(
      isCmdStartQueue({
        type: CMD_START_QUEUE,
        correlationId: FIXTURE_CORRELATION_ID
      })
    ).toBe(true);
  });

  it('accepts startMode=now with source=operator-restart', () => {
    expect(
      isCmdStartQueue(startQueueMsg({ startMode: 'now', source: 'operator-restart' }))
    ).toBe(true);
  });

  it('accepts startMode=scheduled with valid timestamp and source=operator-restart', () => {
    expect(
      isCmdStartQueue(
        startQueueMsg({
          startMode: 'scheduled',
          scheduledStartAt: 1_700_000_000_000,
          source: 'operator-restart'
        })
      )
    ).toBe(true);
  });

  it('accepts startMode=cancel-schedule with source=operator-restart', () => {
    expect(
      isCmdStartQueue(
        startQueueMsg({ startMode: 'cancel-schedule', source: 'operator-restart' })
      )
    ).toBe(true);
  });

  it('rejects startMode=cancel-schedule combined with scheduledStartAt', () => {
    expect(
      isCmdStartQueue(
        startQueueMsg({
          startMode: 'cancel-schedule',
          scheduledStartAt: 1_700_000_000_000,
          source: 'operator-restart'
        })
      )
    ).toBe(false);
  });

  it('rejects every source other than operator-restart on CMD_START_QUEUE', () => {
    const disallowed = [
      'operator-chooser',
      'programmatic-now',
      'programmatic-scheduled',
      'migration-default'
    ];
    for (const source of disallowed) {
      expect(
        isCmdStartQueue(startQueueMsg({ startMode: 'now', source }))
      ).toBe(false);
    }
  });

  it('rejects startMode=now combined with scheduledStartAt', () => {
    expect(
      isCmdStartQueue(
        startQueueMsg({
          startMode: 'now',
          scheduledStartAt: 1_700_000_000_000,
          source: 'operator-restart'
        })
      )
    ).toBe(false);
  });

  it('rejects non-finite scheduledStartAt on CMD_START_QUEUE', () => {
    expect(
      isCmdStartQueue(
        startQueueMsg({
          startMode: 'scheduled',
          scheduledStartAt: Number.NaN,
          source: 'operator-restart'
        })
      )
    ).toBe(false);
  });

  it('rejects a non-StartQueueIntent payload key', () => {
    expect(
      isCmdStartQueue({
        type: CMD_START_QUEUE,
        correlationId: FIXTURE_CORRELATION_ID,
        payload: { somethingElse: true }
      })
    ).toBe(false);
  });
});

// BUG-002 / Feature 065 — lockstep between predicate and parser paths.
// Every legal/illegal shape that the predicate accepts/rejects MUST be
// accepted/rejected identically by `validateInboundMessage` (the parser
// path used by both `DashboardPanel.handleInbound` and the sidebar view
// provider via `validateInboundMessage`).
describe('Feature 065 / BUG-002 — validator lockstep (predicate vs parser)', () => {
  describe('CMD_START', () => {
    it('parser accepts CMD_START without startIntent', () => {
      expect(
        parserAccepts({
          type: CMD_START,
          correlationId: FIXTURE_CORRELATION_ID,
          payload: { description: 'desc' }
        })
      ).toBe(true);
    });

    it('parser accepts startMode=now without scheduledStartAt', () => {
      expect(
        parserAccepts(startMsg({ startMode: 'now', source: 'operator-chooser' }))
      ).toBe(true);
    });

    it('parser accepts startMode=scheduled with a valid timestamp', () => {
      expect(
        parserAccepts(
          startMsg({
            startMode: 'scheduled',
            scheduledStartAt: 1_700_000_000_000,
            source: 'operator-chooser'
          })
        )
      ).toBe(true);
    });

    it('parser accepts every legal source literal', () => {
      const sources = [
        'operator-chooser',
        'operator-restart',
          'programmatic-now',
        'programmatic-scheduled',
        'migration-default'
      ];
      for (const source of sources) {
        expect(parserAccepts(startMsg({ startMode: 'now', source }))).toBe(true);
      }
    });

    it('parser rejects startMode=now combined with scheduledStartAt', () => {
      expect(
        parserAccepts(
          startMsg({
            startMode: 'now',
            scheduledStartAt: 1_700_000_000_000,
            source: 'operator-chooser'
          })
        )
      ).toBe(false);
    });

    it('parser rejects startMode=cancel-schedule on CMD_START', () => {
      expect(
        parserAccepts(
          startMsg({ startMode: 'cancel-schedule', source: 'operator-restart' })
        )
      ).toBe(false);
    });

    it('parser rejects invalid source literals', () => {
      expect(
        parserAccepts(startMsg({ startMode: 'now', source: 'unknown-source' }))
      ).toBe(false);
    });

    it('parser rejects non-finite or zero scheduledStartAt', () => {
      expect(
        parserAccepts(
          startMsg({
            startMode: 'scheduled',
            scheduledStartAt: 0,
            source: 'operator-chooser'
          })
        )
      ).toBe(false);
      expect(
        parserAccepts(
          startMsg({
            startMode: 'scheduled',
            scheduledStartAt: Number.NaN,
            source: 'operator-chooser'
          })
        )
      ).toBe(false);
      expect(
        parserAccepts(
          startMsg({
            startMode: 'scheduled',
            scheduledStartAt: Number.POSITIVE_INFINITY,
            source: 'operator-chooser'
          })
        )
      ).toBe(false);
    });

    it('parser surfaces invalid-start-intent reason on bad shape', () => {
      const result = validateInboundMessage(
        startMsg({ startMode: 'invalid-mode', source: 'operator-chooser' })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid-start-intent');
      }
    });
  });

  describe('CMD_START_QUEUE', () => {
    it('parser accepts CMD_START_QUEUE with no payload', () => {
      expect(
        parserAccepts({
          type: CMD_START_QUEUE,
          correlationId: FIXTURE_CORRELATION_ID
        })
      ).toBe(true);
    });

    it('parser accepts CMD_START_QUEUE with empty payload', () => {
      expect(
        parserAccepts({
          type: CMD_START_QUEUE,
          correlationId: FIXTURE_CORRELATION_ID,
          payload: {}
        })
      ).toBe(true);
    });

    it('parser accepts startMode=now with source=operator-restart', () => {
      expect(
        parserAccepts(startQueueMsg({ startMode: 'now', source: 'operator-restart' }))
      ).toBe(true);
    });

    it('parser accepts startMode=scheduled with valid timestamp and source=operator-restart', () => {
      expect(
        parserAccepts(
          startQueueMsg({
            startMode: 'scheduled',
            scheduledStartAt: 1_700_000_000_000,
            source: 'operator-restart'
          })
        )
      ).toBe(true);
    });

    it('parser accepts startMode=cancel-schedule with source=operator-restart', () => {
      expect(
        parserAccepts(
          startQueueMsg({ startMode: 'cancel-schedule', source: 'operator-restart' })
        )
      ).toBe(true);
    });

    it('parser rejects startMode=cancel-schedule combined with scheduledStartAt', () => {
      expect(
        parserAccepts(
          startQueueMsg({
            startMode: 'cancel-schedule',
            scheduledStartAt: 1_700_000_000_000,
            source: 'operator-restart'
          })
        )
      ).toBe(false);
    });

    it('parser rejects every source other than operator-restart', () => {
      const disallowed = [
        'operator-chooser',
          'programmatic-now',
        'programmatic-scheduled',
        'migration-default'
      ];
      for (const source of disallowed) {
        expect(parserAccepts(startQueueMsg({ startMode: 'now', source }))).toBe(false);
      }
    });

    it('parser rejects startMode=now combined with scheduledStartAt', () => {
      expect(
        parserAccepts(
          startQueueMsg({
            startMode: 'now',
            scheduledStartAt: 1_700_000_000_000,
            source: 'operator-restart'
          })
        )
      ).toBe(false);
    });

    it('parser rejects non-finite scheduledStartAt', () => {
      expect(
        parserAccepts(
          startQueueMsg({
            startMode: 'scheduled',
            scheduledStartAt: Number.NaN,
            source: 'operator-restart'
          })
        )
      ).toBe(false);
    });

    it('parser rejects a non-StartQueueIntent payload key', () => {
      expect(
        parserAccepts({
          type: CMD_START_QUEUE,
          correlationId: FIXTURE_CORRELATION_ID,
          payload: { somethingElse: true }
        })
      ).toBe(false);
    });

    it('parser surfaces invalid-start-intent reason on bad shape', () => {
      const result = validateInboundMessage(
        startQueueMsg({ startMode: 'invalid-mode', source: 'operator-restart' })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid-start-intent');
      }
    });
  });

  // Cross-path agreement: same legal / illegal shapes feed BOTH paths,
  // and the verdict (accept / reject) MUST match. This is the regression
  // assertion for BUG-002: at the time of filing, the predicate accepted
  // `startIntent` while the parser rejected it.
  describe('agreement across predicate and parser paths', () => {
    const fixtures: Array<{
      label: string;
      msg: unknown;
      predicate: (m: unknown) => boolean;
    }> = [
      {
        label: 'CMD_START / startMode=now / valid source',
        msg: startMsg({ startMode: 'now', source: 'operator-chooser' }),
        predicate: isCmdStart
      },
      {
        label: 'CMD_START / startMode=scheduled / valid timestamp',
        msg: startMsg({
          startMode: 'scheduled',
          scheduledStartAt: 1_700_000_000_000,
          source: 'operator-chooser'
        }),
        predicate: isCmdStart
      },
      {
        label: 'CMD_START / startMode=cancel-schedule (REJECT)',
        msg: startMsg({ startMode: 'cancel-schedule', source: 'operator-restart' }),
        predicate: isCmdStart
      },
      {
        label: 'CMD_START_QUEUE / startMode=now',
        msg: startQueueMsg({ startMode: 'now', source: 'operator-restart' }),
        predicate: isCmdStartQueue
      },
      {
        label: 'CMD_START_QUEUE / startMode=cancel-schedule',
        msg: startQueueMsg({ startMode: 'cancel-schedule', source: 'operator-restart' }),
        predicate: isCmdStartQueue
      },
      {
        label: 'CMD_START_QUEUE / source=operator-chooser (REJECT)',
        msg: startQueueMsg({ startMode: 'now', source: 'operator-chooser' }),
        predicate: isCmdStartQueue
      }
    ];

    for (const { label, msg, predicate } of fixtures) {
      it(`predicate and parser agree on: ${label}`, () => {
        expect(parserAccepts(msg)).toBe(predicate(msg));
      });
    }
  });
});
