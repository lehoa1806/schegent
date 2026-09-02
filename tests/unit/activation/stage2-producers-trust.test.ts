import { describe, expect, it } from 'vitest';

import { createStage2Producers } from '../../../src/activation/stage2-producers';
import { SanitizedLogger } from '../../../src/lib/logger';

/**
 * FR-R3-136 (FR-009…FR-012, T1525e) — Phase C's acceptance, at the seam where the
 * claim is actually decidable.
 *
 * The requirement reads: an untrusted activation over seeded running/retry/
 * schedule state creates no lock file, arms no timer and spawns nothing; the
 * grant initializes once and replays nothing twice; a second grant is a no-op.
 *
 * WHY HERE AND NOT AGAINST `activate()`. Every one of those acts is a call this
 * module makes, and `createStage2Producers` takes each as a dependency — so
 * "creates no lock file" is `lock.tryAcquire` never being called, "spawns
 * nothing" is `backendCapabilities.scan` never being called, and "arms no timer"
 * is `scheduledStartCoordinator.reArm` and `watchdog.reattachOnActivation` never
 * being called. Asserting on the calls rather than on the filesystem is the
 * stronger form: an fs assertion passes when a write happened to a directory the
 * fixture did not look in, and it cannot distinguish "did not write" from "wrote
 * and cleaned up". The end-to-end leg over a real untrusted window is T1527's,
 * and it needs an Electron host; this one runs in the unit tier and fails in
 * milliseconds when a producer act leaks back to construction time.
 *
 * THE SEEDED STATE IS THE `lockResult` AND THE THUNKS, not a memento. Nothing in
 * this module inspects run state to decide whether to act — it acts, and the
 * things it calls decide. So the fixture seeds the one branch that changes what
 * runs (the election outcome) and counts the rest. `resumePersistedRuns` is
 * exercised through `store.getRunMap()`, which is why the trusted-primary case
 * asserts that it was read.
 *
 * NON-VACUITY IS THE TRUSTED CASE. Every untrusted assertion is "this was never
 * called", which is exactly what a broken fixture, a renamed dependency or a
 * `run()` that throws early also produces. The trusted case runs the same
 * fixture through the same call and requires every one of those to have been
 * called — so the untrusted zeros mean the gate refused, and not that the
 * harness never worked.
 */

interface Recorder {
  readonly calls: string[];
  readonly lines: string[];
  readonly deps: Parameters<typeof createStage2Producers>[0];
  trusted: boolean;
}

function recorder(options: { trusted: boolean; acquired?: boolean }): Recorder {
  const calls: string[] = [];
  const lines: string[] = [];
  const logger = new SanitizedLogger([{ appendLine: (line: string) => lines.push(line) }]);
  const acquired = options.acquired ?? true;
  const note = <T>(name: string, value: T): T => {
    calls.push(name);
    return value;
  };

  const state = {
    trusted: options.trusted,
    calls,
    lines
  };

  const deps = {
    isWorkspaceTrusted: () => state.trusted,
    logger,
    store: {
      getRunMap: () => note('store.getRunMap', {})
    },
    auditWriter: {
      append: async () => {
        note('auditWriter.append', undefined);
      }
    },
    lock: {
      tryAcquire: async () => note('lock.tryAcquire', { acquired, ownerId: 'window-a' })
    },
    controller: {
      resumeExistingFromActivation: async () => {
        note('controller.resumeExistingFromActivation', undefined);
      },
      resumeExisting: () => {
        note('controller.resumeExisting', undefined);
      },
      scheduleAutoDrain: () => {
        note('controller.scheduleAutoDrain', undefined);
      }
    },
    watchdog: {
      reattachOnActivation: async () => {
        note('watchdog.reattachOnActivation', undefined);
      }
    },
    scheduledStartCoordinator: {
      reArm: async () => {
        note('scheduledStartCoordinator.reArm', undefined);
      }
    },
    replayEvidenceBacklog: async () => {
      note('replayEvidenceBacklog', undefined);
    },
    runSafety: {
      replayTerminalTransitions: async () => {
        note('runSafety.replayTerminalTransitions', undefined);
      },
      sweepCheckpointRetention: async () => note('runSafety.sweepCheckpointRetention', undefined)
    },
    backendCapabilities: {
      scan: async () => note('backendCapabilities.scan', undefined)
    },
    startMountProbe: () => {
      note('startMountProbe', undefined);
    },
    refreshCatalog: async () => {
      note('refreshCatalog', undefined);
    }
  } as unknown as Parameters<typeof createStage2Producers>[0];

  return {
    calls,
    lines,
    deps,
    get trusted() {
      return state.trusted;
    },
    set trusted(next: boolean) {
      state.trusted = next;
    }
  };
}

/**
 * Every act this module can perform, named once. The untrusted case asserts the
 * whole list is absent and the trusted-primary case asserts the whole list is
 * present, so a new dependency that nobody adds here shows up as a trusted case
 * that passes while claiming less than it should — which is why the trusted
 * assertion is an exact set comparison rather than a membership check.
 */
const EVERY_ACT = Object.freeze([
  'lock.tryAcquire',
  'startMountProbe',
  'runSafety.replayTerminalTransitions',
  'replayEvidenceBacklog',
  'refreshCatalog',
  'runSafety.sweepCheckpointRetention',
  'backendCapabilities.scan',
  'scheduledStartCoordinator.reArm',
  'watchdog.reattachOnActivation',
  'controller.resumeExistingFromActivation',
  'store.getRunMap',
  'controller.scheduleAutoDrain'
]);

/** The five FR-R3-070 installers, gated on the election rather than on trust. */
const PRIMACY_GATED = Object.freeze([
  'scheduledStartCoordinator.reArm',
  'watchdog.reattachOnActivation',
  'controller.resumeExistingFromActivation',
  'store.getRunMap',
  'controller.scheduleAutoDrain'
]);

describe('stage 2 producers: nothing happens in an untrusted window', () => {
  it('performs no act at all while untrusted, and says so once at info', async () => {
    const r = recorder({ trusted: false });
    const producers = createStage2Producers(r.deps);

    await producers.run();

    expect(r.calls).toEqual([]);
    expect(producers.hasRun()).toBe(false);
    expect(r.lines.filter((line) => line.includes('workspace is not trusted'))).toHaveLength(1);
  });

  it('performs every act while trusted and primary — the control for the case above', async () => {
    const r = recorder({ trusted: true });
    const producers = createStage2Producers(r.deps);

    await producers.run();
    // `sweepCheckpointRetention`, `scan` and `resumePersistedRuns` are launched
    // without being awaited, exactly as they were at their old call sites.
    await Promise.resolve();
    await Promise.resolve();

    expect([...r.calls].sort()).toEqual([...EVERY_ACT].sort());
    expect(producers.hasRun()).toBe(true);
  });

  it('elects first, and replays before it recovers', async () => {
    // FR-R3-136 C2 plus FR-R3-070's ordering, read off the call sequence rather
    // than off the source text. `elect-before-recovering.test.ts` holds the same
    // rule as a shape rule on the file; this holds it as a fact about a run, so
    // a reordering that survives the text scan still fails here.
    const r = recorder({ trusted: true });

    await createStage2Producers(r.deps).run();

    expect(r.calls[0]).toBe('lock.tryAcquire');
    expect(r.calls.indexOf('runSafety.replayTerminalTransitions')).toBeLessThan(
      r.calls.indexOf('replayEvidenceBacklog')
    );
    expect(r.calls.indexOf('replayEvidenceBacklog')).toBeLessThan(
      r.calls.indexOf('refreshCatalog')
    );
    expect(r.calls.indexOf('refreshCatalog')).toBeLessThan(
      r.calls.indexOf('scheduledStartCoordinator.reArm')
    );
  });

  it('sweeps every queue for drainable work, after the recovery installers', async () => {
    // Bug "there is no way to start a pending task" (2026-09-02), second finding.
    //
    // The drain is edge-triggered — nothing polls — so every transition to
    // `pending` needs a call site that asks for one. Two producers of pending
    // rows have no call site to put a trigger in: `queue-state-migrator.ts`
    // demotes rows a crashed host left `in-flight`, during state load, before a
    // controller exists; and a queue whose drain was refused mid-session (at the
    // concurrency ceiling, or by a lost execution lease) was never re-asked.
    // `pending-transition-drain-trigger.test.ts` excuses the migrator on the
    // recorded grounds that "the drain that picks these up is the one activation
    // performs once the controller is up" — this is that drain, and until it
    // existed the excuse named nothing and the rows survived every restart.
    //
    // LAST, and that ordering is the assertion. `replayTerminalTransitions`
    // finishes Runs whose completion was journalled but not projected, and the
    // three installers above re-arm or resume the Runs a live queue already
    // owns. A sweep that ran before them would read a queue as busy on a Run
    // that had already ended, or start a second Run on a queue about to resume
    // its own — so this asks last, once the picture is settled.
    const r = recorder({ trusted: true });

    await createStage2Producers(r.deps).run();

    expect(r.calls).toContain('controller.scheduleAutoDrain');
    expect(r.calls.filter((c) => c === 'controller.scheduleAutoDrain')).toHaveLength(1);
    expect(r.calls.indexOf('runSafety.replayTerminalTransitions')).toBeLessThan(
      r.calls.indexOf('controller.scheduleAutoDrain')
    );
    expect(r.calls.indexOf('controller.resumeExistingFromActivation')).toBeLessThan(
      r.calls.indexOf('controller.scheduleAutoDrain')
    );
    expect(r.calls.indexOf('store.getRunMap')).toBeLessThan(
      r.calls.indexOf('controller.scheduleAutoDrain')
    );
  });

  it('runs on the grant, from the same object that refused at activation (FR-005)', async () => {
    // The shape of `onDidGrantWorkspaceTrust`: the producers object was built
    // during an untrusted activation and is never rebuilt, so a captured `false`
    // anywhere in this module would make the grant subscriber a no-op.
    const r = recorder({ trusted: false });
    const producers = createStage2Producers(r.deps);

    await producers.run();
    expect(r.calls).toEqual([]);

    r.trusted = true;
    await producers.run();

    expect(r.calls).toContain('lock.tryAcquire');
    expect(producers.hasRun()).toBe(true);
  });

  it('is a no-op on a second grant', async () => {
    const r = recorder({ trusted: true });
    const producers = createStage2Producers(r.deps);

    await producers.run();
    const afterFirst = r.calls.length;
    await producers.run();
    await producers.run();

    expect(r.calls.length).toBe(afterFirst);
    expect(r.calls.filter((c) => c === 'lock.tryAcquire')).toHaveLength(1);
  });

  it('elects once across concurrent grants', async () => {
    // Two grants in flight at the same time. The `ran` boolean alone cannot
    // close this — every landmark in `runOnce` is awaited, so a second call
    // arrives while the first is suspended and `ran` is still false at the top.
    const r = recorder({ trusted: true });
    const producers = createStage2Producers(r.deps);

    await Promise.all([producers.run(), producers.run(), producers.run()]);

    expect(r.calls.filter((c) => c === 'lock.tryAcquire')).toHaveLength(1);
    expect(r.calls.filter((c) => c === 'replayEvidenceBacklog')).toHaveLength(1);
  });

  it('installs no recovery in a trusted non-primary window, but still does its own writes', async () => {
    // FR-R3-070 remains a separate gate from trust, and this is the case that
    // proves the two are not accidentally the same condition: trust granted,
    // election lost.
    const r = recorder({ trusted: true, acquired: false });

    await createStage2Producers(r.deps).run();
    await Promise.resolve();
    await Promise.resolve();

    for (const installer of PRIMACY_GATED) {
      expect(r.calls, `${installer} must not run in a non-primary window`).not.toContain(installer);
    }
    // Its own work is not the primary's to do: the migration events this window
    // recorded, the mount verdict for this machine, the installed-backend list.
    expect(r.calls).toContain('replayEvidenceBacklog');
    expect(r.calls).toContain('startMountProbe');
    expect(r.calls).toContain('backendCapabilities.scan');
    expect(r.lines.some((line) => line.includes('window is not primary'))).toBe(true);
  });
});
