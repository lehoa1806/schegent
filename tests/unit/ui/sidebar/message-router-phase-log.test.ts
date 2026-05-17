// Feature 020 T008 — message router contract for the 3 new phase-log
// commands.
//
// Asserts:
// 1. The 3 new command constants are NOT members of MUTATING_COMMANDS
//    (read-only by construction — see specs/020-phase-level-logs/
//    contracts/phase-log-ipc.md "CRITICAL: MUTATING_COMMANDS membership").
// 2. Dispatching each command from a secondary host (isPrimary === false)
//    still completes — the gate does not reject. The handler may
//    currently return failure for unrelated reasons (no audit /
//    state-projector dependencies yet); the assertion is specifically
//    that the rejection reason is NEVER 'secondary-window-readonly'.

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

const noopExecuteCommand: RouterDeps['executeCommand'] = (() =>
  Promise.resolve(undefined)) as RouterDeps['executeCommand'];

const PHASE_LOG_COMMAND_NAMES = [
  CMD_READ_PHASE_LOG,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL
] as const;

describe('Feature 020 T008 — phase-log commands are not mutating', () => {
  for (const cmd of PHASE_LOG_COMMAND_NAMES) {
    it(`${cmd} is NOT a mutating command`, () => {
      expect(isMutatingCommand(cmd)).toBe(false);
    });
  }

  it('secondary host can dispatch CMD_READ_PHASE_LOG without secondary-window-readonly rejection', async () => {
    const ackSpy = vi.fn<Parameters<AckPoster>, ReturnType<AckPoster>>(() =>
      Promise.resolve(true)
    );
    const router = new MessageRouter({
      executeCommand: noopExecuteCommand,
      queueRemover: { remove: vi.fn(() => Promise.resolve(false)) },
      isPrimary: () => false,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      }
    });
    await router.dispatch(
      {
        type: CMD_READ_PHASE_LOG,
        correlationId: 'corr-1',
        payload: {
          selection: {
            queueId: 'q',
            taskId: 't',
            pipelineId: 'p1',
            phaseId: 'p2',
            iterationN: null
          }
        }
      },
      ackSpy
    );
    expect(ackSpy).toHaveBeenCalled();
    const lastAck = ackSpy.mock.calls[ackSpy.mock.calls.length - 1]?.[0] as
      | CommandAckMessage
      | undefined;
    expect(lastAck?.reason).not.toBe('secondary-window-readonly');
  });

  it('secondary host can dispatch CMD_START_PHASE_LOG_TAIL without secondary-window-readonly rejection', async () => {
    const ackSpy = vi.fn<Parameters<AckPoster>, ReturnType<AckPoster>>(() =>
      Promise.resolve(true)
    );
    const router = new MessageRouter({
      executeCommand: noopExecuteCommand,
      queueRemover: { remove: vi.fn(() => Promise.resolve(false)) },
      isPrimary: () => false,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      }
    });
    await router.dispatch(
      {
        type: CMD_START_PHASE_LOG_TAIL,
        correlationId: 'corr-2',
        payload: {
          selection: {
            queueId: 'q',
            taskId: 't',
            pipelineId: 'p1',
            phaseId: 'p2',
            iterationN: 1
          }
        }
      },
      ackSpy
    );
    const lastAck = ackSpy.mock.calls[ackSpy.mock.calls.length - 1]?.[0] as
      | CommandAckMessage
      | undefined;
    expect(lastAck?.reason).not.toBe('secondary-window-readonly');
  });

  it('secondary host can dispatch CMD_STOP_PHASE_LOG_TAIL without secondary-window-readonly rejection', async () => {
    const ackSpy = vi.fn<Parameters<AckPoster>, ReturnType<AckPoster>>(() =>
      Promise.resolve(true)
    );
    const router = new MessageRouter({
      executeCommand: noopExecuteCommand,
      queueRemover: { remove: vi.fn(() => Promise.resolve(false)) },
      isPrimary: () => false,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      }
    });
    await router.dispatch(
      {
        type: CMD_STOP_PHASE_LOG_TAIL,
        correlationId: 'corr-3',
        payload: { sessionId: 'session-xyz' }
      },
      ackSpy
    );
    const lastAck = ackSpy.mock.calls[ackSpy.mock.calls.length - 1]?.[0] as
      | CommandAckMessage
      | undefined;
    expect(lastAck?.reason).not.toBe('secondary-window-readonly');
  });
});
