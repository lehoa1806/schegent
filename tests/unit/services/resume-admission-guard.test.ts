import { describe, expect, it, vi } from 'vitest';

import {
  admitResumeCandidate,
  toResumeAdmission,
  type ResumeAdmissionGuardDeps,
  type ResumeAdmissionRefusal
} from '../../../src/services/resume-admission-guard';
import {
  NOT_RESUMED,
  NOT_RESUMED_SHUTDOWN,
  NOT_RESUMED_TREE_LIVE
} from '../../../src/controller/run-admission';
import { declineMessage, orphanedGroupDeclineMessage } from '../../../src/services/resume-decision';
import type { LivenessProbe } from '../../../src/services/process-liveness';
import type { SpawnIdentity } from '../../../src/contracts/spawn-identity';
import type { WorkflowRun } from '../../../src/state/workflow-run';

/**
 * FR-R4-F06 (FR-016, FR-018; T18; contract P, P7 and P8; data-model section 7; TA3 to TA5) --
 * the admission guard every resume reaches.
 *
 * WHAT THE SEAM IS FOR. Only the activation sweep used to ask whether the previous backend's
 * tree was gone. A Run the sweep declined kept its in-flight status and its identity, so a
 * manual resume, the drain's `admitResume` or an unattended wakeup then admitted it with no
 * check at all. The guard moves the question to the one place every path passes, and asks it
 * again on every attempt.
 *
 * WHAT IT ALSO OWNS. The two refusals that opened `resumeExistingOnQueue` (no Run, a Run that
 * has ended) move here unchanged, and a third is added: once the coordinator is closed, no
 * resume begins. The order is part of the contract, because the first refusal that applies is
 * the one the operator and the audit trail see.
 *
 * The control is M12: removing the liveness step turns the refusal cases red.
 */
const QUEUE = 'queue-1';
const IDENTITY: SpawnIdentity = { pid: 4242, pgid: 4242, startedAtMs: 1_700_000_000_000 };

function runOf(over: Record<string, unknown> = {}): WorkflowRun {
  return {
    id: 'run-9',
    status: 'running',
    currentPhase: 'speckit-implement',
    currentIteration: 3,
    spawnIdentity: IDENTITY,
    ...over
  } as unknown as WorkflowRun;
}

/** What each member of the probe answers; every member counts how often it was asked. */
interface ProbeScript {
  exists?: () => boolean;
  startedAtMs?: () => Promise<number | null>;
  groupExists?: () => boolean;
}

function probeOf(script: ProbeScript = {}): { probe: LivenessProbe; asked: () => number } {
  let asked = 0;
  return {
    asked: () => asked,
    probe: {
      platform: 'darwin',
      exists: () => {
        asked += 1;
        return (script.exists ?? (() => true))();
      },
      startedAtMs: async () => {
        asked += 1;
        return (script.startedAtMs ?? (async () => IDENTITY.startedAtMs))();
      },
      groupExists: () => {
        asked += 1;
        return (script.groupExists ?? (() => false))();
      }
    }
  };
}

interface Harness {
  readonly deps: ResumeAdmissionGuardDeps;
  readonly appended: Array<Parameters<ResumeAdmissionGuardDeps['appendAudit']>[0]>;
  readonly notices: string[];
  readonly probeAsked: () => number;
}

function harness(
  over: {
    run?: WorkflowRun | null;
    driving?: boolean;
    closed?: boolean;
    probe?: ProbeScript;
    appendAudit?: ResumeAdmissionGuardDeps['appendAudit'];
  } = {}
): Harness {
  const appended: Harness['appended'] = [];
  const notices: string[] = [];
  const { probe, asked } = probeOf(over.probe);
  const run = over.run === undefined ? runOf() : over.run;
  return {
    appended,
    notices,
    probeAsked: asked,
    deps: {
      getRun: (_queueId: string) => run,
      isDriving: () => over.driving ?? false,
      isClosed: () => over.closed ?? false,
      liveness: probe,
      appendAudit:
        over.appendAudit ??
        (async (entry) => {
          appended.push(entry);
        }),
      notify: (message) => void notices.push(message)
    }
  };
}

describe('the refusals that moved from the controller (T18)', () => {
  it('refuses a queue with no Run, and asks nothing', async () => {
    const h = harness({ run: null });
    expect(await admitResumeCandidate(h.deps, QUEUE)).toEqual({
      admitted: false,
      refusal: 'no-run'
    });
    expect(h.probeAsked()).toBe(0);
  });

  it.each(['completed', 'canceled'])('refuses a %s Run as run-ended, and asks nothing', async (status) => {
    const h = harness({ run: runOf({ status }) });
    expect(await admitResumeCandidate(h.deps, QUEUE)).toEqual({
      admitted: false,
      refusal: 'run-ended'
    });
    expect(h.probeAsked()).toBe(0);
  });

  it('admits a failed Run: a retry is a resume of a failed Run', async () => {
    const run = runOf({ status: 'failed', spawnIdentity: undefined });
    const h = harness({ run });
    expect(await admitResumeCandidate(h.deps, QUEUE)).toEqual({ admitted: true, run });
  });
});

describe('the shutdown refusal (S4)', () => {
  it('refuses once the coordinator is closed, before any liveness question', async () => {
    const h = harness({ closed: true });
    expect(await admitResumeCandidate(h.deps, QUEUE)).toEqual({
      admitted: false,
      refusal: 'shutdown-begun'
    });
    expect(h.probeAsked()).toBe(0);
    expect(h.appended).toEqual([]);
    expect(h.notices).toEqual([]);
  });
});

describe('the order of refusals (data-model section 7)', () => {
  it('reports no-run before a closed coordinator', async () => {
    const h = harness({ run: null, closed: true });
    expect(await admitResumeCandidate(h.deps, QUEUE)).toEqual({ admitted: false, refusal: 'no-run' });
  });

  it('reports run-ended before a closed coordinator', async () => {
    const h = harness({ run: runOf({ status: 'completed' }), closed: true });
    expect(await admitResumeCandidate(h.deps, QUEUE)).toEqual({
      admitted: false,
      refusal: 'run-ended'
    });
  });

  it('reports shutdown-begun before a live tree, without asking liveness', async () => {
    const h = harness({ closed: true, probe: { exists: () => true } });
    expect(await admitResumeCandidate(h.deps, QUEUE)).toEqual({
      admitted: false,
      refusal: 'shutdown-begun'
    });
    expect(h.probeAsked()).toBe(0);
  });
});

describe('when liveness is asked (P7)', () => {
  it('asks when the Run carries an identity and this window is not driving the queue', async () => {
    const h = harness({ probe: { exists: () => false, groupExists: () => false } });
    const result = await admitResumeCandidate(h.deps, QUEUE);
    expect(h.probeAsked()).toBeGreaterThan(0);
    expect(result.admitted).toBe(true);
  });

  it('does not ask when the Run carries no identity', async () => {
    const run = runOf({ spawnIdentity: undefined });
    const h = harness({ run });
    expect(await admitResumeCandidate(h.deps, QUEUE)).toEqual({ admitted: true, run });
    expect(h.probeAsked()).toBe(0);
  });

  it('does not ask when this window is already driving the queue: the identity is its own child', async () => {
    // Probing it would decline the Run as an orphan of itself.
    const run = runOf();
    const h = harness({ run, driving: true });
    expect(await admitResumeCandidate(h.deps, QUEUE)).toEqual({ admitted: true, run });
    expect(h.probeAsked()).toBe(0);
    expect(h.appended).toEqual([]);
  });

  it.each<[string, ProbeScript]>([
    ['dead', { exists: () => false, groupExists: () => false }],
    [
      'unanswerable',
      {
        exists: () => false,
        groupExists: () => {
          throw new Error('EPERM');
        }
      }
    ]
  ])('admits on a %s verdict, with no row and no notice', async (_verdict, script) => {
    const run = runOf();
    const h = harness({ run, probe: script });
    expect(await admitResumeCandidate(h.deps, QUEUE)).toEqual({ admitted: true, run });
    expect(h.appended).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it('returns the Run it was given, unchanged and by identity', async () => {
    const run = runOf({ spawnIdentity: undefined });
    const h = harness({ run });
    const result = await admitResumeCandidate(h.deps, QUEUE);
    expect(result.admitted && result.run).toBe(run);
  });
});

describe('a liveness refusal is recorded and explained (P8)', () => {
  it('refuses previous-tree-alive, appends one failure row with the verdict, and notifies with the alive sentence', async () => {
    const h = harness({ probe: { exists: () => true } });

    const result = await admitResumeCandidate(h.deps, QUEUE);

    expect(result).toEqual({ admitted: false, refusal: 'previous-tree-alive' });
    expect(h.appended).toEqual([
      {
        runId: 'run-9',
        phase: 'speckit-implement',
        iteration: 3,
        eventType: 'run-resume-declined-orphan-alive',
        payload: { queueId: QUEUE, runId: 'run-9', liveness: 'alive' },
        outcome: 'failure'
      }
    ]);
    expect(h.notices).toEqual([declineMessage({ queueId: QUEUE, runId: 'run-9' })]);
  });

  it('refuses previous-group-orphaned, appends the orphaned-group verdict, and notifies with the group sentence', async () => {
    const h = harness({ probe: { exists: () => false, groupExists: () => true } });

    const result = await admitResumeCandidate(h.deps, QUEUE);

    expect(result).toEqual({ admitted: false, refusal: 'previous-group-orphaned' });
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]?.eventType).toBe('run-resume-declined-orphan-alive');
    expect(h.appended[0]?.payload.liveness).toBe('orphaned-group');
    expect(h.appended[0]?.outcome).toBe('failure');
    expect(h.notices).toEqual([orphanedGroupDeclineMessage({ queueId: QUEUE, runId: 'run-9' })]);
  });

  it('appends before it notifies, so the record cannot follow the message', async () => {
    const order: string[] = [];
    const h = harness({
      probe: { exists: () => true },
      appendAudit: async () => {
        order.push('audit');
      }
    });
    const notify = h.deps.notify;
    const result = await admitResumeCandidate(
      {
        ...h.deps,
        notify: (message) => {
          order.push('notify');
          notify(message);
        }
      },
      QUEUE
    );
    expect(result.admitted).toBe(false);
    expect(order).toEqual(['audit', 'notify']);
  });

  it.each<[ResumeAdmissionRefusal, ProbeScript]>([
    ['previous-tree-alive', { exists: () => true }],
    ['previous-group-orphaned', { exists: () => false, groupExists: () => true }]
  ])('an audit append that throws does not change the %s refusal', async (refusal, script) => {
    const notified = vi.fn();
    const h = harness({
      probe: script,
      appendAudit: async () => {
        throw new Error('audit sink unavailable');
      }
    });
    const result = await admitResumeCandidate({ ...h.deps, notify: notified }, QUEUE);
    expect(result).toEqual({ admitted: false, refusal });
    // The operator is still told: evidence about a decision must not silence the decision.
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it('is asked again on every attempt: the verdict is not cached', async () => {
    let groupAlive = true;
    const h = harness({ probe: { exists: () => false, groupExists: () => groupAlive } });

    expect(await admitResumeCandidate(h.deps, QUEUE)).toEqual({
      admitted: false,
      refusal: 'previous-group-orphaned'
    });
    groupAlive = false;
    expect((await admitResumeCandidate(h.deps, QUEUE)).admitted).toBe(true);
  });
});

describe('toResumeAdmission maps a refusal to the value the drain reads (TA3)', () => {
  it.each<[ResumeAdmissionRefusal, unknown]>([
    ['no-run', NOT_RESUMED],
    ['run-ended', NOT_RESUMED],
    ['shutdown-begun', NOT_RESUMED_SHUTDOWN],
    ['previous-tree-alive', NOT_RESUMED_TREE_LIVE],
    ['previous-group-orphaned', NOT_RESUMED_TREE_LIVE]
  ])('%s', (refusal, expected) => {
    expect(toResumeAdmission(refusal)).toBe(expected);
  });

  it('gives the two new values their own refusal codes, so the drain can tell them from NOT_RESUMED', () => {
    expect(NOT_RESUMED.refusal).toBeUndefined();
    expect(NOT_RESUMED_TREE_LIVE).toMatchObject({ resumed: false, refusal: 'previous-tree-live' });
    expect(NOT_RESUMED_SHUTDOWN).toMatchObject({ resumed: false, refusal: 'shutdown-begun' });
  });
});
