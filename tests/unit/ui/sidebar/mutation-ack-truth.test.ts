// FR-R3-154 (T1644) — the five lifecycle routes ACK what the host did, not
// that the host was asked.
//
// **The defect.** Pause Phase, Resume Phase, Restart Phase, Retry Phase Now and
// Start Queue each executed a VS Code command and then ACKed `accepted`
// unconditionally. Every one of the registered commands behind them returned
// `void`, so the ACK could not have been anything else — there was nothing to
// read. Three separate host answers arrived at the webview as success:
//
//   1. a structured refusal (`ambiguous-run-target`, `not-pending-retry`,
//      `rejected-horizon`) that the command warned about and swallowed;
//   2. a no-op, where the host committed nothing because there was nothing to
//      commit;
//   3. a Workspace Trust refusal, where `registerGuardedCommand` returned
//      before the handler ran at all.
//
// **Why the assertions are on the ACK and not on the effect.** The effect is
// already tested — FR-R3-151 owns Phase eligibility and FR-R3-150/152 own Queue
// start semantics, and this file deliberately fakes `executeCommand` rather
// than building a second oracle for either. What was never tested is the
// *report*: that the answer the host produced is the answer the correlation
// resolves with. So each case pins the ACK triple (`status`, `outcome`,
// `reason`) against a known host result, and the aggregate case at the bottom
// pins the property the defect violated — that no non-accepted host result
// produces an `accepted` ACK on any of the five routes.
//
// **The positive control.** `answers accepted when the host committed` runs the
// same five routes against an accepted result. A handler hardwired to reject —
// the cheap way to make every other case in this file pass — fails it.

import { describe, it, expect, vi } from 'vitest';
import { MessageRouter, type RouterDeps } from '../../../../src/ui/sidebar/message-router';
import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  CMD_PAUSE_PHASE,
  CMD_RESTART_PHASE,
  CMD_RESUME_PHASE,
  CMD_RETRY_PHASE_NOW,
  CMD_START_QUEUE,
  type CommandAckMessage,
  type SidebarCommand
} from '../../../../src/ui/sidebar/messages';

const QUEUE = 'queue-beta';
const PHASE = 'speckit-plan';

interface Route {
  readonly label: string;
  readonly commandId: string;
  readonly command: (correlationId: string) => SidebarCommand;
}

/**
 * The five routes named in the filing, each with the command id it dispatches
 * and the payload the webview actually sends. The queue is never `'default'`,
 * so a handler that dropped the addressing would still be visible here.
 */
const ROUTES: readonly Route[] = [
  {
    label: 'Pause Phase',
    commandId: 'schegent.pausePhase',
    command: (correlationId) => ({
      type: CMD_PAUSE_PHASE,
      correlationId,
      payload: { queueId: QUEUE }
    })
  },
  {
    label: 'Resume Phase',
    commandId: 'schegent.resumePhase',
    command: (correlationId) => ({
      type: CMD_RESUME_PHASE,
      correlationId,
      payload: { queueId: QUEUE, prompt: 'continue' }
    })
  },
  {
    label: 'Restart Phase',
    commandId: 'schegent.restartPhase',
    command: (correlationId) => ({
      type: CMD_RESTART_PHASE,
      correlationId,
      payload: { queueId: QUEUE, phaseId: PHASE }
    })
  },
  {
    label: 'Retry Phase Now',
    commandId: 'schegent.retryPhaseNow',
    command: (correlationId) => ({
      type: CMD_RETRY_PHASE_NOW,
      correlationId,
      payload: { queueId: QUEUE }
    })
  },
  {
    label: 'Start Queue',
    commandId: 'schegent.startQueue',
    command: (correlationId) => ({
      type: CMD_START_QUEUE,
      correlationId,
      payload: { queueId: QUEUE }
    })
  }
];

interface Dispatched {
  readonly acks: readonly CommandAckMessage[];
  readonly calls: ReadonlyArray<{ commandId: string; args: readonly unknown[] }>;
  readonly warnings: readonly string[];
}

/**
 * Dispatch one command through the real router with `executeCommand` answering
 * `respond`. A `respond` that throws produces a REJECTED promise, which is what
 * `vscode.commands.executeCommand` produces for a host command whose own
 * conversion did not catch.
 */
async function dispatch(
  route: Route,
  correlationId: string,
  respond: (commandId: string, args: readonly unknown[]) => unknown
): Promise<Dispatched> {
  const acks: CommandAckMessage[] = [];
  const calls: Array<{ commandId: string; args: readonly unknown[] }> = [];
  const warnings: string[] = [];
  const executeCommand = ((commandId: string, ...args: unknown[]) => {
    calls.push({ commandId, args });
    try {
      return Promise.resolve(respond(commandId, args));
    } catch (err) {
      return Promise.reject(err);
    }
  }) as unknown as RouterDeps['executeCommand'];

  const deps: RouterDeps = {
    executeCommand,
    queueRemover: { remove: async () => true },
    isPrimary: () => true,
    isTrusted: () => true,
    notifyWarning: (message: string) => {
      warnings.push(message);
    },
    logger: new SanitizedLogger()
  };

  await new MessageRouter(deps).dispatch(route.command(correlationId), async (msg) => {
    acks.push(msg as CommandAckMessage);
    return true;
  });

  return { acks, calls, warnings };
}

/** The single ACK a route must produce, failing loudly if it produced none. */
function soleAck(dispatched: Dispatched): CommandAckMessage {
  expect(dispatched.acks).toHaveLength(1);
  return dispatched.acks[0] as CommandAckMessage;
}

describe('FR-R3-154 (T1644) — mutation ACKs report the host result', () => {
  it.each(ROUTES)('$label answers accepted when the host committed', async (route) => {
    // The positive control. Nothing else in this file distinguishes a correct
    // handler from one that rejects everything.
    const d = await dispatch(route, 'c-ok', () => ({ outcome: 'accepted' }));
    const ack = soleAck(d);
    expect(ack.correlationId).toBe('c-ok');
    expect(ack.status).toBe('accepted');
    expect(ack.outcome).toBe('accepted');
    expect(ack.reason).toBeUndefined();
    expect(d.calls.map((c) => c.commandId)).toEqual([route.commandId]);
  });

  it.each(ROUTES)('$label carries the host refusal reason', async (route) => {
    const d = await dispatch(route, 'c-refused', () => ({
      outcome: 'refused',
      reason: 'ambiguous-run-target'
    }));
    const ack = soleAck(d);
    expect(ack.correlationId).toBe('c-refused');
    expect(ack.status).toBe('rejected');
    expect(ack.outcome).toBe('refused');
    expect(ack.reason).toBe('ambiguous-run-target');
  });

  it.each(ROUTES)('$label reports a MutationResult refusal, not acceptance', async (route) => {
    // The shape the host's other mutating commands return. FR-R3-154 T1645
    // says these five return "`MutationResult`/start outcomes", so a route that
    // only understood the richer outcome union would report a real refusal as a
    // wiring failure.
    const d = await dispatch(route, 'c-mutation', () => ({ ok: false, reason: 'no-active-run' }));
    const ack = soleAck(d);
    expect(ack.status).toBe('rejected');
    expect(ack.outcome).toBe('refused');
    expect(ack.reason).toBe('no-active-run');
  });

  it.each(ROUTES)('$label reports a no-op as a no-op', async (route) => {
    // A no-op committed nothing, so it is not `accepted`; it is also not a
    // refusal, and collapsing the two would tell the operator their action was
    // rejected when in truth the state was already what they asked for.
    const d = await dispatch(route, 'c-noop', () => ({
      outcome: 'no-op',
      reason: 'start-intent-no-change'
    }));
    const ack = soleAck(d);
    expect(ack.status).toBe('rejected');
    expect(ack.outcome).toBe('no-op');
    expect(ack.reason).toBe('start-intent-no-change');
  });

  it.each(ROUTES)('$label reports a Workspace Trust refusal', async (route) => {
    // `registerGuardedCommand` returns `undefined` for a mutating id in an
    // untrusted workspace, having warned the operator and never called the
    // handler. This is the case whose old ACK was false in the strongest sense
    // available: the mutation was never attempted.
    const d = await dispatch(route, 'c-untrusted', () => undefined);
    const ack = soleAck(d);
    expect(ack.status).toBe('rejected');
    expect(ack.outcome).toBe('refused');
    expect(ack.reason).toBe('workspace-not-trusted');
  });

  it.each(ROUTES)('$label reports a thrown dispatch failure as failed', async (route) => {
    const d = await dispatch(route, 'c-threw', () => {
      throw new Error('ENOENT: /Users/someone/private/workspace/.schegent/state.json');
    });
    const ack = soleAck(d);
    expect(ack.status).toBe('rejected');
    expect(ack.outcome).toBe('failed');
    // A code, not the error's own text: the reason crosses the IPC boundary and
    // the message carries a filesystem path.
    expect(ack.reason).toBe('command-dispatch-failed');
    expect(ack.reason).not.toContain('ENOENT');
    expect(ack.reason).not.toContain('/Users/');
  });

  it('never answers accepted for a host result that is not an acceptance', async () => {
    // The property the defect violated, stated once over the whole matrix so a
    // route added to `ROUTES` is covered without a new case.
    const nonAcceptances: ReadonlyArray<{
      label: string;
      respond: () => unknown;
    }> = [
      { label: 'typed refusal', respond: () => ({ outcome: 'refused', reason: 'no-active-run' }) },
      { label: 'no-op', respond: () => ({ outcome: 'no-op', reason: 'nothing-to-do' }) },
      { label: 'MutationResult refusal', respond: () => ({ ok: false, reason: 'queue-paused' }) },
      { label: 'trust refusal', respond: () => undefined },
      {
        label: 'thrown failure',
        respond: () => {
          throw new Error('boom');
        }
      },
      { label: 'unrecognized shape', respond: () => 'done' }
    ];

    const accepted: string[] = [];
    for (const route of ROUTES) {
      for (const { label, respond } of nonAcceptances) {
        const ack = soleAck(await dispatch(route, `c-${route.commandId}-${label}`, respond));
        if (ack.status === 'accepted' || ack.outcome === 'accepted') {
          accepted.push(`${route.label} / ${label}`);
        }
        expect(ack.reason, `${route.label} / ${label} must explain itself`).toBeTruthy();
      }
    }
    expect(accepted).toEqual([]);
  });

  it('preserves the correlation id of the command it answers', async () => {
    // One router, five commands in flight, distinct ids. A handler that read
    // the id from anywhere but its own context would cross the answers.
    const acks: CommandAckMessage[] = [];
    const deps: RouterDeps = {
      executeCommand: ((commandId: string) =>
        Promise.resolve(
          commandId === 'schegent.restartPhase'
            ? { outcome: 'refused', reason: 'no-active-run' }
            : { outcome: 'accepted' }
        )) as unknown as RouterDeps['executeCommand'],
      queueRemover: { remove: async () => true },
      isPrimary: () => true,
      isTrusted: () => true,
      notifyWarning: () => undefined,
      logger: new SanitizedLogger()
    };
    const router = new MessageRouter(deps);
    await Promise.all(
      ROUTES.map((route, i) =>
        router.dispatch(route.command(`corr-${i}`), async (msg) => {
          acks.push(msg as CommandAckMessage);
          return true;
        })
      )
    );

    expect(acks).toHaveLength(ROUTES.length);
    const byId = new Map(acks.map((a) => [a.correlationId, a]));
    expect([...byId.keys()].sort()).toEqual(ROUTES.map((_r, i) => `corr-${i}`));
    const restartIndex = ROUTES.findIndex((r) => r.commandId === 'schegent.restartPhase');
    expect(byId.get(`corr-${restartIndex}`)?.status).toBe('rejected');
    for (const [id, ack] of byId) {
      if (id === `corr-${restartIndex}`) continue;
      expect(ack.status, `${id} should have been accepted`).toBe('accepted');
    }
  });
});

describe('FR-R3-154 (T1644) — the operator still hears about a refusal', () => {
  it('leaves notification behavior to the host command', async () => {
    // T1645: "keep notification behavior separate from the returned result."
    // The registered command owns the toast — it has the human copy and the
    // sanitizer — so the handler must not add a second one. This asserts the
    // router-side half: a refused ACK is posted without the router inventing
    // operator-facing text of its own.
    const d = await dispatch(ROUTES[0] as Route, 'c-warn', () => ({
      outcome: 'refused',
      reason: 'ambiguous-run-target'
    }));
    expect(soleAck(d).reason).toBe('ambiguous-run-target');
    expect(d.warnings).toEqual([]);
  });

  it('does not dispatch twice while resolving one command', async () => {
    const calls = vi.fn();
    const d = await dispatch(ROUTES[3] as Route, 'c-once', (commandId) => {
      calls(commandId);
      return { outcome: 'accepted' };
    });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(d.calls).toHaveLength(1);
  });
});
