import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageRouter, type RouterDeps } from '../../../../src/ui/sidebar/message-router';
import { validateInboundMessage } from '../../../../src/contracts/runtime-validators';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { CommandAckMessage, SidebarCommand } from '../../../../src/ui/sidebar/messages';
import {
  CMD_PAUSE_PHASE,
  CMD_RESUME_PHASE,
  CMD_RESTART_PHASE,
  CMD_SKIP_PHASE,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE,
  CMD_SET_PHASE_BREAKPOINT,
  CMD_CLEAR_PHASE_BREAKPOINT,
  CMD_RETRY_PHASE_NOW
} from '../../../../src/ui/sidebar/messages';

/**
 * T080 — every lifecycle control is queue-addressed end to end.
 *
 * With one Run per window the controls could be ambient: "pause the phase"
 * had exactly one referent, so `resolveSoleRun` always answered correctly and
 * no layer between the webview and `PhaseControlService` had to carry a queue.
 * Feature 093 makes N Runs concurrent, and from that point an ambient control
 * is not merely under-specified — `resolveControlTarget(undefined, runs)`
 * refuses it as `ambiguous-run-target`, so the button does nothing.
 *
 * These tests pin the addressing at the two seams where it could be dropped
 * silently:
 *
 *  1. the IPC boundary, where a payload without a `queueId` must be refused
 *     rather than defaulted — a default would reintroduce ambient resolution
 *     at the one place that is supposed to prove it is gone; and
 *  2. the router, where the handler must hand the operator's queue to the
 *     palette command or to `PhaseOps` verbatim. A handler that drops the
 *     field still type-checks (the controller's own `queueId` stays optional
 *     for the palette callers of T038), so only an assertion on the received
 *     argument catches it.
 *
 * The queue asserted on is deliberately not the first or the default one:
 * every fake here would accept `'default'` by accident.
 */

const QUEUE = 'queue-beta';
const PHASE = 'speckit-plan';
const RUN = 'run-7';

interface CapturedAck {
  msg: CommandAckMessage;
}

/** Records the queue each PhaseOps entry point was handed, or `undefined`. */
class RecordingPhaseOps {
  skipCalls: Array<{ phaseId: string; queueId?: string }> = [];
  disableCalls: Array<{ phaseId: string; queueId?: string }> = [];
  enableCalls: Array<{ phaseId: string; queueId?: string }> = [];
  setBreakpointCalls: Array<{ runId: string; phaseId: string; queueId?: string }> = [];
  clearBreakpointCalls: Array<{ runId: string; phaseId: string; queueId?: string }> = [];

  async skipPhase(phaseId: string, queueId?: string): Promise<{ ok: boolean }> {
    this.skipCalls.push({ phaseId, queueId });
    return { ok: true };
  }
  async disablePhase(phaseId: string, queueId?: string): Promise<{ ok: boolean }> {
    this.disableCalls.push({ phaseId, queueId });
    return { ok: true };
  }
  async enablePhase(phaseId: string, queueId?: string): Promise<{ ok: boolean }> {
    this.enableCalls.push({ phaseId, queueId });
    return { ok: true };
  }
  async setPhaseBreakpoint(
    runId: string,
    phaseId: string,
    queueId?: string
  ): Promise<{ ok: boolean }> {
    this.setBreakpointCalls.push({ runId, phaseId, queueId });
    return { ok: true };
  }
  async clearPhaseBreakpoint(
    runId: string,
    phaseId: string,
    queueId?: string
  ): Promise<{ ok: boolean }> {
    this.clearBreakpointCalls.push({ runId, phaseId, queueId });
    return { ok: true };
  }
}

function makeRouter(): {
  router: MessageRouter;
  executeCommand: ReturnType<typeof vi.fn>;
  phaseOps: RecordingPhaseOps;
  acks: CapturedAck[];
} {
  const executeCommand = vi.fn();
  executeCommand.mockResolvedValue(undefined);
  const phaseOps = new RecordingPhaseOps();
  const acks: CapturedAck[] = [];
  const deps: RouterDeps = {
    executeCommand: executeCommand as unknown as RouterDeps['executeCommand'],
    queueRemover: { remove: async () => true },
    phaseOps,
    isPrimary: () => true,
    isTrusted: () => true,
    notifyWarning: () => undefined,
    logger: new SanitizedLogger()
  };
  return { router: new MessageRouter(deps), executeCommand, phaseOps, acks };
}

async function dispatch(
  router: MessageRouter,
  command: SidebarCommand,
  acks: CapturedAck[]
): Promise<void> {
  await router.dispatch(command, async (msg) => {
    acks.push({ msg });
    return true;
  });
}

describe('T080 — lifecycle controls are queue-addressed end to end', () => {
  describe('IPC boundary refuses an unaddressed control', () => {
    /**
     * Every lifecycle control, paired with the payload it carried before the
     * queue was part of the contract. Each must now be refused: the operator
     * pressed a button on one queue's Run, and a control that arrives without
     * saying which one cannot be resolved to that Run.
     */
    const UNADDRESSED: ReadonlyArray<{ type: string; payload?: Record<string, unknown> }> = [
      { type: CMD_PAUSE_PHASE },
      { type: CMD_RESUME_PHASE },
      { type: CMD_RETRY_PHASE_NOW },
      { type: CMD_RESTART_PHASE, payload: { phaseId: PHASE } },
      { type: CMD_SKIP_PHASE, payload: { phaseId: PHASE } },
      { type: CMD_DISABLE_PHASE, payload: { phaseId: PHASE } },
      { type: CMD_ENABLE_PHASE, payload: { phaseId: PHASE } },
      { type: CMD_SET_PHASE_BREAKPOINT, payload: { runId: RUN, phaseId: PHASE } },
      { type: CMD_CLEAR_PHASE_BREAKPOINT, payload: { runId: RUN, phaseId: PHASE } }
    ];

    it.each(UNADDRESSED)('rejects $type without a queueId', ({ type, payload }) => {
      const result = validateInboundMessage({
        type,
        correlationId: 'c-1',
        ...(payload ? { payload } : {})
      });
      expect(result.ok).toBe(false);
    });

    it.each(UNADDRESSED)('accepts $type once it names a queue', ({ type, payload }) => {
      const result = validateInboundMessage({
        type,
        correlationId: 'c-2',
        payload: { ...(payload ?? {}), queueId: QUEUE }
      });
      expect(result.ok).toBe(true);
      expect(result.ok && result.command.type).toBe(type);
      const accepted = result.ok
        ? (result.command as { payload?: Record<string, unknown> }).payload
        : undefined;
      expect(accepted?.['queueId']).toBe(QUEUE);
    });

    it('rejects an empty queueId rather than treating it as absent', () => {
      const result = validateInboundMessage({
        type: CMD_PAUSE_PHASE,
        correlationId: 'c-3',
        payload: { queueId: '' }
      });
      expect(result.ok).toBe(false);
    });

    it('keeps the resume prompt alongside the queue', () => {
      const result = validateInboundMessage({
        type: CMD_RESUME_PHASE,
        correlationId: 'c-4',
        payload: { queueId: QUEUE, prompt: 'continue with the revised plan' }
      });
      expect(result.ok).toBe(true);
      const payload = result.ok
        ? (result.command as { payload?: Record<string, unknown> }).payload
        : undefined;
      expect(payload).toEqual({ queueId: QUEUE, prompt: 'continue with the revised plan' });
    });
  });

  describe('router hands the operator queue to the host', () => {
    let built: ReturnType<typeof makeRouter>;

    beforeEach(() => {
      built = makeRouter();
    });

    it('threads the queue through the palette-routed controls', async () => {
      await dispatch(
        built.router,
        { type: CMD_PAUSE_PHASE, correlationId: 'p1', payload: { queueId: QUEUE } },
        built.acks
      );
      await dispatch(
        built.router,
        { type: CMD_RESUME_PHASE, correlationId: 'p2', payload: { queueId: QUEUE } },
        built.acks
      );
      await dispatch(
        built.router,
        {
          type: CMD_RESUME_PHASE,
          correlationId: 'p3',
          payload: { queueId: QUEUE, prompt: 'go on' }
        },
        built.acks
      );
      await dispatch(
        built.router,
        {
          type: CMD_RESTART_PHASE,
          correlationId: 'p4',
          payload: { queueId: QUEUE, phaseId: PHASE }
        },
        built.acks
      );
      await dispatch(
        built.router,
        { type: CMD_RETRY_PHASE_NOW, correlationId: 'p5', payload: { queueId: QUEUE } },
        built.acks
      );

      expect(built.executeCommand.mock.calls).toEqual([
        ['schegent.pausePhase', QUEUE],
        ['schegent.resumePhase', undefined, QUEUE],
        ['schegent.resumePhase', 'go on', QUEUE],
        ['schegent.restartPhase', QUEUE],
        ['schegent.retryPhaseNow', QUEUE]
      ]);
      expect(built.acks.map((a) => a.msg.status)).toEqual([
        'accepted',
        'accepted',
        'accepted',
        'accepted',
        'accepted'
      ]);
    });

    it('threads the queue through the PhaseOps-routed controls', async () => {
      await dispatch(
        built.router,
        {
          type: CMD_SKIP_PHASE,
          correlationId: 'o1',
          payload: { queueId: QUEUE, phaseId: PHASE }
        },
        built.acks
      );
      await dispatch(
        built.router,
        {
          type: CMD_DISABLE_PHASE,
          correlationId: 'o2',
          payload: { queueId: QUEUE, phaseId: PHASE }
        },
        built.acks
      );
      await dispatch(
        built.router,
        {
          type: CMD_ENABLE_PHASE,
          correlationId: 'o3',
          payload: { queueId: QUEUE, phaseId: PHASE }
        },
        built.acks
      );
      await dispatch(
        built.router,
        {
          type: CMD_SET_PHASE_BREAKPOINT,
          correlationId: 'o4',
          payload: { queueId: QUEUE, runId: RUN, phaseId: PHASE }
        },
        built.acks
      );
      await dispatch(
        built.router,
        {
          type: CMD_CLEAR_PHASE_BREAKPOINT,
          correlationId: 'o5',
          payload: { queueId: QUEUE, runId: RUN, phaseId: PHASE }
        },
        built.acks
      );

      expect(built.phaseOps.skipCalls).toEqual([{ phaseId: PHASE, queueId: QUEUE }]);
      expect(built.phaseOps.disableCalls).toEqual([{ phaseId: PHASE, queueId: QUEUE }]);
      expect(built.phaseOps.enableCalls).toEqual([{ phaseId: PHASE, queueId: QUEUE }]);
      expect(built.phaseOps.setBreakpointCalls).toEqual([
        { runId: RUN, phaseId: PHASE, queueId: QUEUE }
      ]);
      expect(built.phaseOps.clearBreakpointCalls).toEqual([
        { runId: RUN, phaseId: PHASE, queueId: QUEUE }
      ]);
      expect(built.acks.every((a) => a.msg.status === 'accepted')).toBe(true);
    });
  });
});
