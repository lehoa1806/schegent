import { describe, expect, it } from 'vitest';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { patchRunForResume } from '../../../src/controller/resume-pause-fields';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import {
  ALL_RUN_STATUSES,
  type WorkflowRun
} from '../../../src/state/workflow-run';
import {
  ALL_RUN_TRANSITION_ACTORS,
  DEFAULT_ACTOR_BY_RUN_UPDATE_LABEL,
  KEYS,
  QueueMutationRejected,
  RUN_STATUS_TRANSITIONS,
  RUN_UPDATE_LABELS,
  RunFieldInvariantError,
  RunInvariantError,
  RunTransitionError,
  WorkspaceStateStore,
  allowedSameStatusFor,
  allowedSourceStatusesFor,
  allowedSourceStatusesForTargets,
  decideRunTransition,
  isRunRaceRefusal,
  type Memento
} from '../../../src/state/workspace-state';

class FakeMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-transition-test',
    featureId: 'feat-1',
    featureDir: 'specs/315-run-transition-table',
    status: 'running',
    currentPhase: 'speckit-plan',
    currentIteration: 1,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    creditPause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...overrides
  };
}

async function openStoreWith(run: WorkflowRun): Promise<WorkspaceStateStore> {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
  return store;
}

describe('FR-R7-01 — Run status transition table & decideRunTransition (SC-001)', () => {
  it('covers all 25 (from, to) pairs x 4 actors (100 combinations) consistently', () => {
    let checked = 0;
    for (const from of ALL_RUN_STATUSES) {
      for (const to of ALL_RUN_STATUSES) {
        const expectedActors = RUN_STATUS_TRANSITIONS[from][to];
        for (const actor of ALL_RUN_TRANSITION_ACTORS) {
          checked += 1;
          const decision = decideRunTransition({
            current: makeRun({ status: from }),
            targetStatus: to,
            actor
          });
          const statusOnlyDecision = decideRunTransition({
            current: from,
            targetStatus: to,
            actor
          });
          expect(statusOnlyDecision).toEqual(decision);

          if (expectedActors.includes(actor)) {
            expect(decision, `${from} -> ${to} (${actor})`).toEqual({ allowed: true });
          } else {
            expect(decision.allowed, `${from} -> ${to} (${actor})`).toBe(false);
            if (!decision.allowed) {
              expect(decision.from).toBe(from);
              expect(decision.to).toBe(to);
              expect(decision.actor).toBe(actor);
              if ((from === 'completed' || from === 'canceled') && to !== from) {
                expect(decision.reasonCode).toBe('terminal-status-immutable');
              } else if (expectedActors.length === 0) {
                expect(decision.reasonCode).toBe('illegal-transition');
              } else {
                expect(decision.reasonCode).toBe('actor-not-permitted');
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(100);
  });

  it('maps every RunUpdateLabel to a valid RunTransitionActor', () => {
    const actorSet = new Set<string>(ALL_RUN_TRANSITION_ACTORS);
    expect(Object.keys(DEFAULT_ACTOR_BY_RUN_UPDATE_LABEL).sort()).toEqual(
      [...RUN_UPDATE_LABELS].sort()
    );
    for (const label of RUN_UPDATE_LABELS) {
      expect(actorSet.has(DEFAULT_ACTOR_BY_RUN_UPDATE_LABEL[label])).toBe(true);
    }
  });

  it('derives caller allowedStatuses helpers directly from the table', () => {
    expect(allowedSourceStatusesFor('running', 'operator')).toEqual([
      'running',
      'paused',
      'failed'
    ]);
    expect(allowedSourceStatusesFor('running', 'watchdog')).toEqual(['running', 'paused']);
    expect(allowedSameStatusFor('operator')).toEqual(['running', 'paused', 'failed']);
    expect(allowedSameStatusFor('watchdog')).toEqual(['running', 'paused']);
    expect(allowedSameStatusFor('driver')).toEqual([
      'running',
      'paused',
      'failed',
      'completed',
      'canceled'
    ]);
    expect(
      allowedSourceStatusesForTargets(['paused', 'failed', 'completed', 'canceled'], 'driver')
    ).toEqual(['running', 'paused', 'failed', 'completed', 'canceled']);
    expect(
      allowedSourceStatusesForTargets(['paused', 'failed', 'completed'], 'driver')
    ).toEqual(['running', 'paused', 'failed', 'completed']);
  });
});

describe('FR-R7-01 — WorkspaceStateStore.setRun & updateRun transition enforcement (SC-001)', () => {
  const CLAIM = unfencedCommit('test-fixture');

  it('enforces every (from, to) pair across actors through setRun and leaves persisted state unchanged on refusal', async () => {
    for (const from of ALL_RUN_STATUSES) {
      for (const to of ALL_RUN_STATUSES) {
        for (const actor of ALL_RUN_TRANSITION_ACTORS) {
          const initial = makeRun({
            status: from,
            ...(from === 'failed' ? { failureCause: 'phase_failed' as const } : {})
          });
          const store = await openStoreWith(initial);
          const next = makeRun({
            status: to,
            lastTransitionAt: initial.lastTransitionAt + 1_000,
            ...(to === 'failed' ? { failureCause: 'phase_failed' as const } : {})
          });
          const expected = decideRunTransition({ current: from, targetStatus: to, actor });

          if (expected.allowed) {
            await expect(store.setRun(DEFAULT_QUEUE_ID, next, CLAIM, actor)).resolves.toBeUndefined();
            expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe(to);
          } else {
            let caught: unknown;
            try {
              await store.setRun(DEFAULT_QUEUE_ID, next, CLAIM, actor);
            } catch (err) {
              caught = err;
            }
            expect(caught, `${from} -> ${to} (${actor})`).toBeInstanceOf(RunInvariantError);
            expect(caught, `${from} -> ${to} (${actor})`).toBeInstanceOf(RunTransitionError);
            const err = caught as RunTransitionError;
            expect(err.from).toBe(from);
            expect(err.to).toBe(to);
            expect(err.actor).toBe(actor);
            expect(err.reasonCode).toBe(expected.reasonCode);
            expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe(from);
            expect(store.getRun(DEFAULT_QUEUE_ID)?.lastTransitionAt).toBe(initial.lastTransitionAt);
          }
        }
      }
    }
  });

  it('enforces every (from, to) pair across actors through updateRun and leaves persisted state unchanged on refusal', async () => {
    for (const from of ALL_RUN_STATUSES) {
      for (const to of ALL_RUN_STATUSES) {
        for (const actor of ALL_RUN_TRANSITION_ACTORS) {
          const initial = makeRun({
            status: from,
            ...(from === 'failed' ? { failureCause: 'phase_failed' as const } : {})
          });
          const store = await openStoreWith(initial);
          const expected = decideRunTransition({ current: from, targetStatus: to, actor });
          const runUpdate = {
            runId: initial.id,
            allowedStatuses: ALL_RUN_STATUSES,
            label: 'driver-transition' as const,
            actor,
            patch: () => ({
              status: to,
              lastTransitionAt: initial.lastTransitionAt + 2_000,
              failureCause: to === 'failed' ? ('phase_failed' as const) : undefined
            })
          };

          if (expected.allowed) {
            const written = await store.updateRun(DEFAULT_QUEUE_ID, runUpdate, CLAIM);
            expect(written.status).toBe(to);
            expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe(to);
          } else {
            let caught: unknown;
            try {
              await store.updateRun(DEFAULT_QUEUE_ID, runUpdate, CLAIM);
            } catch (err) {
              caught = err;
            }
            expect(caught, `${from} -> ${to} (${actor})`).toBeInstanceOf(RunInvariantError);
            expect(caught, `${from} -> ${to} (${actor})`).toBeInstanceOf(RunTransitionError);
            const err = caught as RunTransitionError;
            expect(err.from).toBe(from);
            expect(err.to).toBe(to);
            expect(err.actor).toBe(actor);
            expect(err.reasonCode).toBe(expected.reasonCode);
            expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe(from);
            expect(store.getRun(DEFAULT_QUEUE_ID)?.lastTransitionAt).toBe(initial.lastTransitionAt);
          }
        }
      }
    }
  });

  it('allows replacing a completed Run on a queue with a new Run carrying a different id', async () => {
    const first = makeRun({ id: 'run-old', status: 'completed' });
    const store = await openStoreWith(first);
    const second = makeRun({ id: 'run-new', status: 'running' });

    await expect(store.setRun(DEFAULT_QUEUE_ID, second, CLAIM)).resolves.toBeUndefined();
    expect(store.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-new');
    expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('running');
  });

  it('throws RunTransitionError (terminal-status-immutable) when any actor tries to move completed -> running', async () => {
    const store = await openStoreWith(makeRun({ status: 'completed' }));
    for (const actor of ALL_RUN_TRANSITION_ACTORS) {
      let caught: unknown;
      try {
        await store.updateRun(
          DEFAULT_QUEUE_ID,
          {
            runId: 'run-transition-test',
            allowedStatuses: ALL_RUN_STATUSES,
            label: 'resume',
            actor,
            patch: () => ({ status: 'running' })
          },
          CLAIM
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RunTransitionError);
      const err = caught as RunTransitionError;
      expect(err.from).toBe('completed');
      expect(err.to).toBe('running');
      expect(err.actor).toBe(actor);
      expect(err.reasonCode).toBe('terminal-status-immutable');
    }
    expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('completed');
  });

  it('enforces strict check ordering: allowedStatuses race refusal precedes decideRunTransition, and decideRunTransition precedes validateRunInvariants', async () => {
    const store = await openStoreWith(makeRun({ status: 'completed' }));

    // 1. In updateRun: excluded from allowedStatuses -> QueueMutationRejected('run-status-precondition')
    // (isRunRaceRefusal === true), NOT RunTransitionError.
    let raceErr: unknown;
    try {
      await store.updateRun(
        DEFAULT_QUEUE_ID,
        {
          runId: 'run-transition-test',
          allowedStatuses: ['running'],
          label: 'resume',
          actor: 'operator',
          patch: () => ({ status: 'running', manualPauseAt: 123, manualPauseCause: null })
        },
        CLAIM
      );
    } catch (err) {
      raceErr = err;
    }
    expect(raceErr).toBeInstanceOf(QueueMutationRejected);
    expect(isRunRaceRefusal(raceErr)).toBe(true);

    // 2. In updateRun: allowedStatuses admits 'completed', patch violates BOTH decideRunTransition
    // AND validateRunInvariants -> decideRunTransition wins (RunTransitionError, NOT race refusal).
    let updateOrderErr: unknown;
    try {
      await store.updateRun(
        DEFAULT_QUEUE_ID,
        {
          runId: 'run-transition-test',
          allowedStatuses: ALL_RUN_STATUSES,
          label: 'resume',
          actor: 'operator',
          patch: () => ({ status: 'running', manualPauseAt: 123, manualPauseCause: null })
        },
        CLAIM
      );
    } catch (err) {
      updateOrderErr = err;
    }
    expect(updateOrderErr).toBeInstanceOf(RunTransitionError);
    expect(isRunRaceRefusal(updateOrderErr)).toBe(false);

    // 3. In setRun: combined illegal transition + broken field invariant -> RunTransitionError wins.
    let setOrderErr: unknown;
    try {
      await store.setRun(
        DEFAULT_QUEUE_ID,
        makeRun({ status: 'running', manualPauseAt: 123, manualPauseCause: null }),
        CLAIM,
        'operator'
      );
    } catch (err) {
      setOrderErr = err;
    }
    expect(setOrderErr).toBeInstanceOf(RunTransitionError);
    expect(isRunRaceRefusal(setOrderErr)).toBe(false);
  });

  it('re-validates livePrevious inside serialize(KEYS.run) when two concurrent setRun calls race', async () => {
    const store = await openStoreWith(makeRun({ status: 'running' }));

    // Queue two setRun calls synchronously without awaiting the first:
    // Both pass pre-chain validation against status 'running', then the first settles the Run
    // to 'completed' and the second must be refused against livePrevious ('completed' -> 'running').
    const first = store.setRun(
      DEFAULT_QUEUE_ID,
      makeRun({ status: 'completed', lastTransitionAt: 1_700_000_001_000 }),
      CLAIM,
      'driver'
    );
    const second = store.setRun(
      DEFAULT_QUEUE_ID,
      makeRun({ status: 'running', lastTransitionAt: 1_700_000_002_000 }),
      CLAIM,
      'driver'
    );

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toBeInstanceOf(RunTransitionError);
    expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('completed');
  });

  it('enforces running status, same-id transition legality, and undefined rollback on admitRunAtomically', async () => {
    const memento = new FakeMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();

    // Non-running Run refused with RunFieldInvariantError('invalid-admission-status').
    expect(() =>
      store.admitRunAtomically(
        DEFAULT_QUEUE_ID,
        makeRun({ id: 'run-paused', status: 'paused' }),
        (queue) => ({ queue, result: undefined }),
        CLAIM
      )
    ).toThrow(RunFieldInvariantError);
    try {
      await store.admitRunAtomically(
        DEFAULT_QUEUE_ID,
        makeRun({ id: 'run-paused', status: 'paused' }),
        (queue) => ({ queue, result: undefined }),
        CLAIM
      );
    } catch (err) {
      expect((err as RunFieldInvariantError).code).toBe('invalid-admission-status');
    }

    // Bare FakeMemento rollback restores KEYS.run to undefined when KEYS.run was absent and KEYS.queue write throws.
    await memento.update(KEYS.run, undefined);
    expect(memento.get(KEYS.run)).toBeUndefined();
    const origUpdate = memento.update.bind(memento);
    memento.update = (key: string, value: unknown): Thenable<void> => {
      if (key === KEYS.queue) return Promise.reject(new Error('queue-write-failed'));
      return origUpdate(key, value);
    };
    await expect(
      store.admitRunAtomically(
        DEFAULT_QUEUE_ID,
        makeRun({ id: 'run-rollback', status: 'running' }),
        (queue) => ({ queue, result: 'ok' }),
        CLAIM
      )
    ).rejects.toThrow('queue-write-failed');
    memento.update = origUpdate;
    expect(memento.get(KEYS.run)).toBeUndefined();

    // Same-run.id resurrection over a terminal Run throws RunTransitionError.
    await store.setRun(
      DEFAULT_QUEUE_ID,
      makeRun({ id: 'run-done', status: 'completed' }),
      CLAIM,
      'driver'
    );
    expect(() =>
      store.admitRunAtomically(
        DEFAULT_QUEUE_ID,
        makeRun({ id: 'run-done', status: 'running' }),
        (queue) => ({ queue, result: 'ok' }),
        CLAIM
      )
    ).toThrow(RunTransitionError);
  });

  it('treats watchdog resume-prompt race on a failed Run as a benign race refusal (null)', async () => {
    const failedRun = makeRun({ status: 'failed', failureCause: 'phase_failed' });
    const store = await openStoreWith(failedRun);
    const result = await patchRunForResume(
      store,
      DEFAULT_QUEUE_ID,
      failedRun,
      'resume-prompt',
      () => ({ resumePrompt: 'continue' }),
      'watchdog'
    );
    expect(result).toBeNull();
  });
});

describe('FR-R7-01 — Typed RunFieldInvariantError hierarchy (SC-002)', () => {
  const CLAIM = unfencedCommit('test-fixture');

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly run: WorkflowRun;
    readonly expectedCode: RunFieldInvariantError['code'];
    readonly messagePattern: RegExp;
  }> = [
    {
      name: 'invalid rawTranscriptMode',
      run: makeRun({ rawTranscriptMode: 'bogus' as NonNullable<WorkflowRun['rawTranscriptMode']> }),
      expectedCode: 'invalid-raw-transcript-mode',
      messagePattern: /^WorkflowRun invariant violation: invalid rawTranscriptMode$/
    },
    {
      name: 'one-sided pendingRetryAt',
      run: makeRun({ status: 'paused', pendingRetryAt: 1000, pendingRetryCause: null }),
      expectedCode: 'one-sided-pending-retry',
      messagePattern: /^WorkflowRun invariant violation: pendingRetryAt/
    },
    {
      name: 'pending retry on running Run',
      run: makeRun({ status: 'running', pendingRetryAt: 1000, pendingRetryCause: 'rate_limit' }),
      expectedCode: 'pending-retry-requires-paused',
      messagePattern: /^WorkflowRun invariant violation: pendingRetryAt .* require status 'paused'/
    },
    {
      name: 'delayedRetryCount at cap on running Run',
      run: makeRun({ status: 'running', delayedRetryCount: 5 }),
      expectedCode: 'delayed-retry-cap-status',
      messagePattern: /^WorkflowRun invariant violation: delayedRetryCount >= 5 requires status 'paused' or 'failed'/
    },
    {
      name: 'delayedRetryCount out of bounds',
      run: makeRun({ delayedRetryCount: -1 }),
      expectedCode: 'delayed-retry-count-range',
      messagePattern: /^WorkflowRun invariant violation: delayedRetryCount must be in \[0, 20\]/
    },
    {
      name: 'one-sided manualPauseAt',
      run: makeRun({ manualPauseAt: 1000, manualPauseCause: null }),
      expectedCode: 'one-sided-manual-pause',
      messagePattern: /^WorkflowRun invariant violation: manualPauseAt/
    },
    {
      name: 'creditPause on running Run',
      run: makeRun({
        status: 'running',
        creditPause: { pausedAt: 1000, windowStartedAt: null, stoppedAt: null }
      }),
      expectedCode: 'invalid-credit-pause-shape',
      messagePattern: /^WorkflowRun invariant violation: creditPause requires status 'paused'/
    },
    {
      name: 'failureCause on non-failed Run',
      run: makeRun({ status: 'running', failureCause: 'phase_failed' }),
      expectedCode: 'failure-cause-requires-failed',
      messagePattern: /^WorkflowRun invariant violation: failureCause requires status 'failed'/
    },
    {
      name: 'non-array phaseBreakpoints',
      run: makeRun({ phaseBreakpoints: null as unknown as WorkflowRun['phaseBreakpoints'] }),
      expectedCode: 'invalid-phase-breakpoints',
      messagePattern: /^WorkflowRun invariant violation: phaseBreakpoints must be an array/
    },
    {
      name: 'duplicate phaseBreakpoint',
      run: makeRun({
        phaseBreakpoints: [
          { phaseId: 'speckit-plan', setAt: 1, actor: 'operator' },
          { phaseId: 'speckit-plan', setAt: 2, actor: 'operator' }
        ]
      }),
      expectedCode: 'duplicate-phase-breakpoint',
      messagePattern: /^WorkflowRun invariant violation: phaseBreakpoints contains duplicate phaseId/
    },
    {
      name: 'breakpoint phase not in pipeline',
      run: makeRun({
        pipeline: {
          id: 'p',
          name: 'P',
          phases: [{ id: 'speckit-plan', name: 'Plan', instruction: 'plan' }]
        },
        phaseBreakpoints: [{ phaseId: 'unknown', setAt: 1, actor: 'operator' }]
      }),
      expectedCode: 'unknown-breakpoint-phase',
      messagePattern: /^WorkflowRun invariant violation: phaseBreakpoints phaseId 'unknown' is not in pipeline\.phases$/
    },
    {
      name: 'phase in both breakpoints and overrides',
      run: makeRun({
        phaseBreakpoints: [{ phaseId: 'speckit-plan', setAt: 1, actor: 'operator' }],
        phaseOverrides: [{ phaseId: 'speckit-plan', action: 'disabled', setAt: 1, actor: 'op' }]
      }),
      expectedCode: 'breakpoint-override-conflict',
      messagePattern: /^WorkflowRun invariant violation: phaseId 'speckit-plan' appears in BOTH phaseBreakpoints AND phaseOverrides$/
    },
    {
      name: 'resumeTargetPhaseId mismatch',
      run: makeRun({ resumeTargetPhaseId: 'speckit-plan', manualPauseCause: null }),
      expectedCode: 'resume-target-phase-mismatch',
      messagePattern: /^WorkflowRun invariant violation: resumeTargetPhaseId/
    }
  ];

  for (const testCase of cases) {
    it(`throws RunFieldInvariantError('${testCase.expectedCode}') for ${testCase.name}`, async () => {
      const store = new WorkspaceStateStore(new FakeMemento());
      await store.initialize();
      let caught: unknown;
      try {
        await store.setRun(DEFAULT_QUEUE_ID, testCase.run, CLAIM);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RunInvariantError);
      expect(caught).toBeInstanceOf(RunFieldInvariantError);
      const err = caught as RunFieldInvariantError;
      expect(err.code).toBe(testCase.expectedCode);
      expect(err.message).toMatch(testCase.messagePattern);
    });
  }
});
