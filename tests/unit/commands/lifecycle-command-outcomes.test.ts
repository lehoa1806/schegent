// FR-R3-154 (T1645) — the five registered commands return the exact typed
// result, and the toast is not it.
//
// These are the commands behind the five sidebar routes. Each used to return
// `void` after showing the operator a warning, which is why
// `tests/unit/ui/sidebar/mutation-ack-truth.test.ts` had nothing truthful to
// ACK. This file asserts the other half: that the value now coming back is the
// host's own answer, reason included, for every branch each command has —
// including the branches that never reach the domain layer at all (a lost
// workspace lock, an unapplied start intent).
//
// The notification assertions are here for the requirement that they stay
// separate: "Do not swallow a structured refusal after logging … keep
// notification behavior separate from the returned result." A refusal must
// produce BOTH a toast and a returned reason, and neither may be derived from
// the other — so each case checks both, and no case accepts one as evidence of
// the other.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';
import {
  runPausePhase,
  runResumePhase,
  runRestartPhase,
  type PhaseControlCommandDeps
} from '../../../src/commands/phase-control-commands';
import { runRetryPhaseNow, type RetryPhaseNowCtx } from '../../../src/commands/retry-phase-now';
import {
  runStartQueueCommand,
  type StartQueueCommandDeps
} from '../../../src/commands/start-queue';
import type { CommandOutcome } from '../../../src/contracts/command-outcome';

const QUEUE = 'queue-beta';

/** A message that must never appear in a reason: it names a real path. */
const LEAKY_ERROR = 'EACCES: /Users/someone/ws/.schegent/state.json';

interface Recorded {
  readonly warns: string[];
  readonly errors: string[];
  readonly infos: string[];
  readonly logged: string[];
}

function recorder(): Recorded {
  return { warns: [], errors: [], infos: [], logged: [] };
}

function phaseDeps(
  rec: Recorded,
  act: () => Promise<{ ok: boolean; reason?: string }>
): PhaseControlCommandDeps & { calls: Array<readonly unknown[]> } {
  const calls: Array<readonly unknown[]> = [];
  const record = (...args: readonly unknown[]): Promise<{ ok: boolean; reason?: string }> => {
    calls.push(args);
    return act();
  };
  return {
    calls,
    controller: {
      pauseActivePhase: (queueId?: string) => record(queueId),
      resumeActivePhase: (prompt?: string, queueId?: string) => record(prompt, queueId),
      restartActivePhase: (queueId?: string) => record(queueId)
    } as unknown as PhaseControlCommandDeps['controller'],
    notifier: {
      warn: (m: string) => {
        rec.warns.push(m);
        return Promise.resolve(undefined);
      },
      error: (m: string) => {
        rec.errors.push(m);
      }
    },
    logger: {
      error: (m: string) => {
        rec.logged.push(m);
      }
    } as unknown as PhaseControlCommandDeps['logger']
  };
}

/** The three Phase controls, each invoked with the queue it addresses. */
const PHASE_CONTROLS: ReadonlyArray<{
  readonly label: string;
  readonly failureReason: string;
  readonly run: (deps: PhaseControlCommandDeps) => Promise<CommandOutcome>;
  readonly expectedArgs: readonly unknown[];
}> = [
  {
    label: 'pause',
    failureReason: 'pause-phase-failed',
    run: (deps) => runPausePhase(QUEUE, deps),
    expectedArgs: [QUEUE]
  },
  {
    label: 'resume',
    failureReason: 'resume-phase-failed',
    run: (deps) => runResumePhase('carry on', QUEUE, deps),
    expectedArgs: ['carry on', QUEUE]
  },
  {
    label: 'restart',
    failureReason: 'restart-phase-failed',
    run: (deps) => runRestartPhase(QUEUE, deps),
    expectedArgs: [QUEUE]
  }
];

describe('FR-R3-154 (T1645) — Phase controls return their MutationResult', () => {
  it.each(PHASE_CONTROLS)('$label accepts a committed transition silently', async (control) => {
    const rec = recorder();
    const deps = phaseDeps(rec, async () => ({ ok: true }));
    expect(await control.run(deps)).toEqual({ outcome: 'accepted' });
    // Committed: nothing to tell the operator, and no reason to carry.
    expect(rec.warns).toEqual([]);
    expect(rec.errors).toEqual([]);
  });

  it.each(PHASE_CONTROLS)('$label addresses the queue it was given', async (control) => {
    const rec = recorder();
    const deps = phaseDeps(rec, async () => ({ ok: true }));
    await control.run(deps);
    expect(deps.calls).toEqual([control.expectedArgs]);
  });

  it.each(PHASE_CONTROLS)('$label returns the refusal AND warns', async (control) => {
    const rec = recorder();
    const deps = phaseDeps(rec, async () => ({ ok: false, reason: 'ambiguous-run-target' }));
    expect(await control.run(deps)).toEqual({
      outcome: 'refused',
      reason: 'ambiguous-run-target'
    });
    // The toast is what a palette invocation gets; the reason is what the
    // webview correlation gets. This was the exact loss: the first happened and
    // the second did not exist.
    expect(rec.warns).toEqual([`Schegent: ${control.label} phase rejected (ambiguous-run-target).`]);
  });

  it.each(PHASE_CONTROLS)('$label converts a thrown error to a code', async (control) => {
    const rec = recorder();
    const deps = phaseDeps(rec, async () => {
      throw new Error(LEAKY_ERROR);
    });
    const outcome = await control.run(deps);
    expect(outcome).toEqual({ outcome: 'failed', reason: control.failureReason });
    // Converted once, here, at the owning boundary: the message reaches the log
    // and the operator hears that it failed, but the reason that crosses the
    // IPC boundary is a code.
    expect(rec.logged).toEqual([`${control.label}Phase failed: ${LEAKY_ERROR}`]);
    expect(rec.errors).toEqual([`Schegent: ${control.label} phase failed.`]);
  });

  it.each(PHASE_CONTROLS)('$label names an unexplained refusal', async (control) => {
    const rec = recorder();
    const deps = phaseDeps(rec, async () => ({ ok: false }));
    expect(await control.run(deps)).toEqual({
      outcome: 'refused',
      reason: 'operation-rejected'
    });
  });
});

function retryCtx(
  rec: Recorded,
  opts: {
    primacy?: boolean;
    result?: { ok: true } | { ok: false; reason: string };
    throws?: boolean;
  }
): RetryPhaseNowCtx & { seen: Array<string | undefined> } {
  const seen: Array<string | undefined> = [];
  return {
    seen,
    controller: {
      retryPhaseNow: async (queueId?: string) => {
        seen.push(queueId);
        if (opts.throws) throw new Error(LEAKY_ERROR);
        return opts.result ?? { ok: true };
      }
    } as unknown as RetryPhaseNowCtx['controller'],
    lock: {
      hasPrimacy: async () => opts.primacy !== false
    } as unknown as RetryPhaseNowCtx['lock'],
    notifier: {
      warn: (m: string) => {
        rec.warns.push(m);
        return Promise.resolve(undefined);
      },
      info: (m: string) => {
        rec.infos.push(m);
      },
      error: (m: string) => {
        rec.errors.push(m);
      }
    } as unknown as RetryPhaseNowCtx['notifier'],
    logger: {
      error: (m: string) => {
        rec.logged.push(m);
      }
    } as unknown as RetryPhaseNowCtx['logger']
  };
}

describe('FR-R3-154 (T1645) — Retry Phase Now returns every early exit', () => {
  it('accepts a started retry', async () => {
    const rec = recorder();
    const ctx = retryCtx(rec, {});
    expect(await runRetryPhaseNow(QUEUE, ctx)).toEqual({ outcome: 'accepted' });
    expect(ctx.seen).toEqual([QUEUE]);
    expect(rec.infos).toEqual(['Schegent: retrying phase now.']);
  });

  it('refuses when another window holds the lock, without asking the controller', async () => {
    // The earliest of the false acceptances: the command returned before it had
    // looked at a Run, and the route ACKed a retry that had started.
    const rec = recorder();
    const ctx = retryCtx(rec, { primacy: false });
    expect(await runRetryPhaseNow(QUEUE, ctx)).toEqual({
      outcome: 'refused',
      reason: 'not-primary-window'
    });
    expect(ctx.seen).toEqual([]);
    expect(rec.warns).toHaveLength(1);
  });

  it.each(['no-active-run', 'not-pending-retry', 'already-retrying'])(
    'carries the %s refusal through',
    async (reason) => {
      const rec = recorder();
      const ctx = retryCtx(rec, { result: { ok: false, reason } });
      expect(await runRetryPhaseNow(QUEUE, ctx)).toEqual({ outcome: 'refused', reason });
      // The operator copy for these three is the command's own; the returned
      // reason is the code, not the sentence.
      expect(rec.warns).toHaveLength(1);
      expect(rec.warns[0]).not.toBe(reason);
    }
  );

  it('converts a thrown failure to a code', async () => {
    const rec = recorder();
    const ctx = retryCtx(rec, { throws: true });
    expect(await runRetryPhaseNow(QUEUE, ctx)).toEqual({
      outcome: 'failed',
      reason: 'retry-phase-now-failed'
    });
    expect(rec.logged).toEqual([`runRetryPhaseNow failed: ${LEAKY_ERROR}`]);
  });

  it('treats a non-string argument as no queue at all', async () => {
    const rec = recorder();
    const ctx = retryCtx(rec, {});
    await runRetryPhaseNow({ queueId: QUEUE }, ctx);
    expect(ctx.seen).toEqual([undefined]);
  });
});

type IntentResult = Awaited<
  ReturnType<StartQueueCommandDeps['guardedRunService']['applyStartQueueIntent']>
>;

function startDeps(
  rec: Recorded,
  intent: IntentResult | (() => never)
): StartQueueCommandDeps & { drains: Array<string | undefined> } {
  const drains: Array<string | undefined> = [];
  return {
    drains,
    guardedRunService: {
      applyStartQueueIntent: async () =>
        typeof intent === 'function' ? intent() : intent
    },
    controller: {
      drainQueuedWork: async (queueId?: string) => {
        drains.push(queueId);
        if (typeof intent === 'function') intent();
      }
    } as unknown as StartQueueCommandDeps['controller'],
    logger: {
      warn: (m: string) => {
        rec.logged.push(m);
      }
    },
    startFailures: { get: () => null }
  };
}

describe('FR-R3-154 (T1645) — Start Queue returns the start outcome', () => {
  it('accepts a bare drain pass as the asynchronous acceptance it is', async () => {
    const rec = recorder();
    const deps = startDeps(rec, { outcome: 'applied' });
    expect(await runStartQueueCommand({ queueId: QUEUE }, deps)).toEqual({
      outcome: 'accepted'
    });
    expect(deps.drains).toEqual([QUEUE]);
  });

  it('accepts an applied intent and drains only once it is running', async () => {
    const rec = recorder();
    const running = startDeps(rec, { outcome: 'applied', lifecycleAfter: 'running' });
    expect(
      await runStartQueueCommand(
        { queueId: QUEUE, startIntent: { startMode: 'now', source: 'operator-restart' } },
        running
      )
    ).toEqual({ outcome: 'accepted' });
    expect(running.drains).toEqual([QUEUE]);

    const armed = startDeps(rec, { outcome: 'applied', lifecycleAfter: 'idle-pending' });
    expect(
      await runStartQueueCommand(
        {
          queueId: QUEUE,
          startIntent: { startMode: 'scheduled', scheduledStartAt: 1, source: 'operator-restart' }
        },
        armed
      )
    ).toEqual({ outcome: 'accepted' });
    // An armed schedule is applied but nothing is running yet, so no drain.
    expect(armed.drains).toEqual([]);
  });

  it('reports a no-change intent as a no-op, not an acceptance', async () => {
    const rec = recorder();
    const deps = startDeps(rec, { outcome: 'noop' });
    expect(
      await runStartQueueCommand(
        {
          queueId: QUEUE,
          startIntent: { startMode: 'cancel-schedule', source: 'operator-restart' }
        },
        deps
      )
    ).toEqual({ outcome: 'no-op', reason: 'start-intent-no-change' });
    expect(deps.drains).toEqual([]);
  });

  it.each(['rejected-horizon', 'rejected-untrusted'] as const)(
    'carries the %s refusal through under its own name',
    async (outcome) => {
      const rec = recorder();
      const deps = startDeps(rec, { outcome });
      expect(
        await runStartQueueCommand(
          {
            queueId: QUEUE,
            startIntent: { startMode: 'scheduled', scheduledStartAt: 1, source: 'operator-restart' }
          },
          deps
        )
      ).toEqual({ outcome: 'refused', reason: outcome });
      expect(deps.drains).toEqual([]);
    }
  );

  it('converts a thrown failure to a code and keeps the message in the log', async () => {
    const rec = recorder();
    const deps = startDeps(rec, () => {
      throw new Error(LEAKY_ERROR);
    });
    expect(await runStartQueueCommand({ queueId: QUEUE }, deps)).toEqual({
      outcome: 'failed',
      reason: 'start-queue-failed'
    });
    expect(rec.logged).toEqual([`startQueue: ${LEAKY_ERROR}`]);
  });
});

type StartFailureReport = ReturnType<StartQueueCommandDeps['startFailures']['get']>;

/** `startDeps` with a report already written for `QUEUE` by the drain pass. */
function startDepsReporting(
  rec: Recorded,
  intent: IntentResult,
  report: StartFailureReport
): ReturnType<typeof startDeps> {
  const deps = startDeps(rec, intent);
  return { ...deps, startFailures: { get: (queueId: string) => (queueId === QUEUE ? report : null) } };
}

const HALTED = Object.freeze({
  kind: 'halted',
  taskId: 'T-1',
  taskName: 'the failed task',
  at: 1
} as const);
const STRANDED = Object.freeze({
  kind: 'stranded-run',
  runId: 'R-1',
  phase: 'speckit-analyze',
  at: 1
} as const);

describe('Start Queue reads back what its own drain pass reported', () => {
  // Feature 195 (FR-021) put `queue-halted-on-failed-task` on the no-intent
  // branch; BUG-004 adds `queue-blocked-by-stranded-run` and extends both to the
  // intent branch. That extension is the part with no prior coverage at all: the
  // Start button on an `idle-pending` queue posts a `startIntent`, so the branch
  // the operator actually presses was the one that could not refuse.
  it.each([
    [HALTED, 'queue-halted-on-failed-task'],
    [STRANDED, 'queue-blocked-by-stranded-run']
  ] as const)('refuses a bare drain pass that reported %o', async (report, reason) => {
    const rec = recorder();
    const deps = startDepsReporting(rec, { outcome: 'applied' }, report);
    expect(await runStartQueueCommand({ queueId: QUEUE }, deps)).toEqual({
      outcome: 'refused',
      reason
    });
    // The drain still ran — this is a reading of its answer, not a gate in front
    // of it. A command that refused without draining would never let the queue
    // recover on the pass that clears the report.
    expect(deps.drains).toEqual([QUEUE]);
  });

  it.each([
    [HALTED, 'queue-halted-on-failed-task'],
    [STRANDED, 'queue-blocked-by-stranded-run']
  ] as const)('refuses an applied start intent that reported %o', async (report, reason) => {
    const rec = recorder();
    const deps = startDepsReporting(
      rec,
      { outcome: 'applied', lifecycleAfter: 'running' },
      report
    );
    expect(
      await runStartQueueCommand(
        { queueId: QUEUE, startIntent: { startMode: 'now', source: 'operator-restart' } },
        deps
      )
    ).toEqual({ outcome: 'refused', reason });
    expect(deps.drains).toEqual([QUEUE]);
  });

  it('accepts when the report belongs to a previous failed attempt', async () => {
    // An `admission` report is a step-7 throw the queue's own surface already
    // shows, and the drain re-offers the queue when a Run ends. Reporting it as
    // this attempt's refusal would name a stale failure as a fresh one.
    const rec = recorder();
    const deps = startDepsReporting(
      rec,
      { outcome: 'applied' },
      Object.freeze({ kind: 'admission', admission: 'admitNew', at: 1, message: 'spawn failed' })
    );
    expect(await runStartQueueCommand({ queueId: QUEUE }, deps)).toEqual({ outcome: 'accepted' });
  });

  it('reads the report for the queue the command addressed', async () => {
    // `startDepsReporting` answers only for `QUEUE`; a command that read the
    // default queue's report regardless of `queueId` would refuse here.
    const rec = recorder();
    const deps = startDepsReporting(rec, { outcome: 'applied' }, STRANDED);
    expect(await runStartQueueCommand({ queueId: 'another-queue' }, deps)).toEqual({
      outcome: 'accepted'
    });
  });
});

describe('FR-R3-154 (T1645) — no command leaks an error message as a reason', () => {
  it('every failure reason is a code, across all five commands', async () => {
    // One assertion over the whole set, because "the reason crosses to the
    // webview" is a property of the boundary and not of any one command. A
    // command that returned `failed((err as Error).message)` — the shortest way
    // to make the per-command cases above pass — fails here.
    const rec = recorder();
    const thrower = async (): Promise<{ ok: boolean }> => {
      throw new Error(LEAKY_ERROR);
    };
    const outcomes: CommandOutcome[] = [
      await runPausePhase(QUEUE, phaseDeps(rec, thrower)),
      await runResumePhase(undefined, QUEUE, phaseDeps(rec, thrower)),
      await runRestartPhase(QUEUE, phaseDeps(rec, thrower)),
      await runRetryPhaseNow(QUEUE, retryCtx(rec, { throws: true })),
      await runStartQueueCommand(
        { queueId: QUEUE },
        startDeps(rec, () => {
          throw new Error(LEAKY_ERROR);
        })
      )
    ];

    expect(outcomes.map((o) => o.outcome)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed']);
    for (const outcome of outcomes) {
      const reason = 'reason' in outcome ? outcome.reason : '';
      expect(reason).toMatch(/^[a-z0-9-]+$/);
      expect(reason).not.toContain('EACCES');
      expect(reason).not.toContain('/Users/');
    }
    // And the messages did reach the log — the conversion hides them from the
    // webview, it does not discard them.
    expect(rec.logged.filter((line) => line.includes(LEAKY_ERROR))).toHaveLength(5);
  });

  it('a refusal never arrives without a reason', async () => {
    const rec = recorder();
    const refusals: CommandOutcome[] = [
      await runPausePhase(QUEUE, phaseDeps(rec, async () => ({ ok: false }))),
      await runRetryPhaseNow(QUEUE, retryCtx(rec, { primacy: false })),
      await runStartQueueCommand(
        {
          queueId: QUEUE,
          startIntent: { startMode: 'cancel-schedule', source: 'operator-restart' }
        },
        startDeps(rec, { outcome: 'noop' })
      )
    ];
    for (const outcome of refusals) {
      expect(outcome.outcome).not.toBe('accepted');
      expect('reason' in outcome && outcome.reason.length > 0).toBe(true);
    }
  });
});

/** `ui-wiring.ts` as text — both cases below assert registration shape. */
function uiWiringSource(): string {
  return readFileSync(
    resolve(__dirname, '..', '..', '..', 'src', 'activation', 'ui-wiring.ts'),
    'utf8'
  );
}

describe('FR-R3-154 (T1645) — the registration site keeps no logic of its own', () => {
  it('ui-wiring delegates the three Phase controls', () => {
    // The bodies moved so their result could be returned. If one is ever
    // re-inlined, the `MutationResult` becomes local again and the ACK goes
    // back to being a guess — so the shape of the registration is the thing
    // asserted, not just the behaviour it currently has.
    const source = uiWiringSource();
    for (const [id, fn] of [
      ['schegent.pausePhase', 'runPausePhase'],
      ['schegent.resumePhase', 'runResumePhase'],
      ['schegent.restartPhase', 'runRestartPhase']
    ] as const) {
      const at = source.indexOf(`'${id}'`);
      expect(at, `${id} must be registered`).toBeGreaterThan(-1);
      const body = source.slice(at, at + 300);
      expect(body, `${id} must delegate to ${fn}`).toContain(fn);
      expect(body, `${id} must not read the result itself`).not.toContain('result.ok');
    }
  });

  it('is registered through the trust guard, whose refusal is `undefined`', () => {
    // Why `normalizeCommandResult(undefined)` is `workspace-not-trusted`: these
    // five ids are all registered through `registerGuardedCommand`, and that is
    // the only thing between the webview and the handler that can answer
    // without running it.
    const source = uiWiringSource();
    for (const id of [
      'schegent.pausePhase',
      'schegent.resumePhase',
      'schegent.restartPhase',
      'schegent.retryPhaseNow',
      'schegent.startQueue'
    ]) {
      const at = source.indexOf(`'${id}'`);
      expect(at, `${id} must be registered`).toBeGreaterThan(-1);
      // The guard is the argument before the id in every registration.
      expect(source.slice(Math.max(0, at - 120), at)).toContain('registerGuardedCommand(guard');
    }
  });
});
