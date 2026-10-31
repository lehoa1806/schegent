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

import { describe, expect, it, vi } from 'vitest';
import {
  CMD_READ_PHASE_LOG,
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
  }
];

function routerWith(gate: {
  readonly isPrimary: () => boolean;
  readonly isTrusted: () => boolean;
}): MessageRouter {
  return new MessageRouter({
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
