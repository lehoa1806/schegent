// FR-R4-F05 (US2, FR-003; contract T, T6) — message router contract for the 3
// phase-log commands. Feature 020 T008 kept them out of MUTATING_COMMANDS so that a
// secondary host could still read phase logs; each appends an audit row, so FR-003
// gates them now and this file asserts the opposite of what it did.
//
// Asserts:
// 1. The 3 command constants ARE members of MUTATING_COMMANDS (see
//    `tests/lint/phase-log-commands-are-gated.test.ts` for the superseded reason).
// 2. A trusted secondary host (isPrimary === false) is refused with
//    'secondary-window-readonly' before the handler runs, and an untrusted
//    workspace with 'untrusted-workspace'. Trust is checked first.
// 3. A trusted primary host is not refused by either gate.
// 4. FR-R6-F07 (T019) — CMD_ACK_PHASE_LOG_TAIL is gated like the other three and
//    forwards to the tail service's `ack`.

import { describe, expect, it, vi } from 'vitest';
import {
  CMD_READ_PHASE_LOG,
  CMD_ACK_PHASE_LOG_TAIL,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL
} from '../../../../src/ui/sidebar/messages';
import type { CommandAckMessage } from '../../../../src/contracts/sidebar-ipc';
import {
  isMutatingCommand,
  MessageRouter,
  type AckPoster,
  type RouterDeps
} from '../../../../src/ui/sidebar/message-router';
import type { SidebarCommand } from '../../../../src/ui/sidebar/messages';

const noopExecuteCommand: RouterDeps['executeCommand'] = (() =>
  Promise.resolve(undefined)) as RouterDeps['executeCommand'];

const SELECTION = {
  queueId: 'q',
  taskId: 't',
  pipelineId: 'p1',
  phaseId: 'p2',
  iterationN: 1
};

const PHASE_LOG_COMMANDS: ReadonlyArray<{ readonly type: string; readonly command: SidebarCommand }> = [
  {
    type: CMD_READ_PHASE_LOG,
    command: {
      type: CMD_READ_PHASE_LOG,
      correlationId: 'corr-1',
      payload: { selection: { ...SELECTION, iterationN: null } }
    }
  },
  {
    type: CMD_START_PHASE_LOG_TAIL,
    command: {
      type: CMD_START_PHASE_LOG_TAIL,
      correlationId: 'corr-2',
      payload: { selection: SELECTION }
    }
  },
  {
    type: CMD_STOP_PHASE_LOG_TAIL,
    command: {
      type: CMD_STOP_PHASE_LOG_TAIL,
      correlationId: 'corr-3',
      payload: { sessionId: 'session-xyz' }
    }
  },
  {
    type: CMD_ACK_PHASE_LOG_TAIL,
    command: {
      type: CMD_ACK_PHASE_LOG_TAIL,
      correlationId: 'corr-4',
      payload: { sessionId: 'session-xyz', batchSeq: 0 }
    }
  }
];

const ACK_COMMAND: SidebarCommand = {
  type: CMD_ACK_PHASE_LOG_TAIL,
  correlationId: 'corr-5',
  payload: { sessionId: 'session-xyz', batchSeq: 3, duplicate: true }
};

function routerWith(
  gate: {
    readonly isPrimary: () => boolean;
    readonly isTrusted: () => boolean;
  },
  phaseLogTailService?: RouterDeps['phaseLogTailService']
): MessageRouter {
  return new MessageRouter({
    ...(phaseLogTailService === undefined ? {} : { phaseLogTailService }),
    executeCommand: noopExecuteCommand,
    isPrimary: gate.isPrimary,
    isTrusted: gate.isTrusted,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      sanitize: (s: string) => s
    }
  });
}

async function lastAckOf(router: MessageRouter, command: SidebarCommand): Promise<CommandAckMessage | undefined> {
  const ackSpy = vi.fn<AckPoster>(() => Promise.resolve(true));
  await router.dispatch(command, ackSpy);
  expect(ackSpy).toHaveBeenCalled();
  return ackSpy.mock.calls[ackSpy.mock.calls.length - 1]?.[0] as CommandAckMessage | undefined;
}

describe('FR-R4-F05 T032 — phase-log commands are gated', () => {
  for (const { type } of PHASE_LOG_COMMANDS) {
    it(`${type} IS a mutating command`, () => {
      expect(isMutatingCommand(type)).toBe(true);
    });
  }

  for (const { type, command } of PHASE_LOG_COMMANDS) {
    it(`a trusted secondary host is refused ${type} with secondary-window-readonly`, async () => {
      const router = routerWith({ isPrimary: () => false, isTrusted: () => true });
      const ack = await lastAckOf(router, command);
      expect(ack).toMatchObject({ status: 'rejected', reason: 'secondary-window-readonly' });
    });

    it(`an untrusted workspace is refused ${type} with untrusted-workspace`, async () => {
      const router = routerWith({ isPrimary: () => true, isTrusted: () => false });
      const ack = await lastAckOf(router, command);
      expect(ack).toMatchObject({ status: 'rejected', reason: 'untrusted-workspace' });
    });

    it(`an untrusted secondary host is refused ${type} on trust first`, async () => {
      const router = routerWith({ isPrimary: () => false, isTrusted: () => false });
      const ack = await lastAckOf(router, command);
      expect(ack?.reason).toBe('untrusted-workspace');
    });

    it(`a trusted primary host is not refused ${type} by a gate`, async () => {
      const router = routerWith({ isPrimary: () => true, isTrusted: () => true });
      const ack = await lastAckOf(router, command);
      expect(ack?.reason).not.toBe('secondary-window-readonly');
      expect(ack?.reason).not.toBe('untrusted-workspace');
    });
  }
});

describe('FR-R6-F07 T019 — CMD_ACK_PHASE_LOG_TAIL forwards to the tail service', () => {
  const OPEN = { isPrimary: () => true, isTrusted: () => true };

  function tailService(ack: NonNullable<RouterDeps['phaseLogTailService']>['ack']): RouterDeps['phaseLogTailService'] {
    return {
      start: () => Promise.resolve({ outcome: 'failure', reason: 'internal-error' }),
      stop: (req) => Promise.resolve({ outcome: 'failure', sessionId: req.sessionId }),
      ack
    };
  }

  it('passes the ack through and accepts it on success', async () => {
    const ack = vi.fn((req: { readonly sessionId: string }) =>
      Promise.resolve({ outcome: 'success' as const, sessionId: req.sessionId })
    );
    const router = routerWith(OPEN, tailService(ack));
    const reply = await lastAckOf(router, ACK_COMMAND);
    expect(ack).toHaveBeenCalledWith({ sessionId: 'session-xyz', batchSeq: 3, duplicate: true });
    expect(reply).toMatchObject({ status: 'accepted' });
  });

  it('rejects an ack for an unknown session with unknown-session', async () => {
    const router = routerWith(
      OPEN,
      tailService((req) =>
        Promise.resolve({ outcome: 'failure', sessionId: req.sessionId, reason: 'unknown-session' })
      )
    );
    const reply = await lastAckOf(router, ACK_COMMAND);
    expect(reply).toMatchObject({ status: 'rejected', reason: 'unknown-session' });
  });

  it('rejects with internal-error when no tail service is wired', async () => {
    const reply = await lastAckOf(routerWith(OPEN), ACK_COMMAND);
    expect(reply).toMatchObject({ status: 'rejected', reason: 'internal-error' });
  });

  it('rejects with internal-error when the service throws', async () => {
    const router = routerWith(OPEN, tailService(() => Promise.reject(new Error('boom'))));
    const reply = await lastAckOf(router, ACK_COMMAND);
    expect(reply).toMatchObject({ status: 'rejected', reason: 'internal-error' });
  });
});
