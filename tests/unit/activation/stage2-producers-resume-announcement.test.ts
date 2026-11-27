import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createStage2Producers } from '../../../src/activation/stage2-producers';
import type { ResumeAdmission } from '../../../src/controller/run-admission';
import { SanitizedLogger } from '../../../src/lib/logger';

const showWarningMessage = vi.hoisted(() => vi.fn(async (_message: string) => undefined));

vi.mock('vscode', () => ({
  window: { showWarningMessage: showWarningMessage }
}));

/**
 * FR-R3-192 (T1862, FR-001, FR-006, FR-007) — path 1, the activation walk of persisted `running`
 * Runs, announces each Run it resumes.
 *
 * The walk is driven through `createStage2Producers(...).run()` and its real `resumePersistedRuns`.
 * The fake controller provides BOTH `resumeExisting` and `admitResume`, and `resumeExisting` is
 * `admitResume` plus an await of `completed`, as the real one is. So at the base the walk resumes the
 * Run by `resumeExisting` and the cases fail on the warning count, not on a missing method.
 *
 * The walk is not awaited by `run()`, so the cases wait with `vi.waitFor`. The Runs carry no
 * `spawnIdentity`, which `checkLiveness` reports as `unrecorded` without probing a process.
 */

interface FakeRun {
  readonly id: string;
  readonly status: string;
  readonly currentPhase: string;
  readonly currentIteration: number;
}

interface Harness {
  readonly producers: ReturnType<typeof createStage2Producers>;
  readonly admitResume: ReturnType<typeof vi.fn>;
  readonly resumeExisting: ReturnType<typeof vi.fn>;
  readonly completions: Map<string, () => void>;
}

const TITLES = ['Schegent: Show Active Run', 'Schegent: Cancel In-Flight Workflow'] as const;

function fakeRun(id: string, currentPhase: string): FakeRun {
  return { id, status: 'running', currentPhase, currentIteration: 1 };
}

function harness(options: {
  runs: Record<string, FakeRun>;
  acquired?: boolean;
  resumed?: boolean;
}): Harness {
  const completions = new Map<string, () => void>();
  const resumed = options.resumed ?? true;
  const admitResume = vi.fn(async (queueId: string): Promise<ResumeAdmission> => {
    if (!resumed) return { resumed: false, completed: Promise.resolve() };
    const completed = new Promise<void>((done) => {
      completions.set(queueId, done);
    });
    return { resumed: true, completed };
  });
  const resumeExisting = vi.fn(async (queueId: string): Promise<boolean> => {
    const admission = await admitResume(queueId);
    await admission.completed;
    return admission.resumed;
  });
  const deps = {
    isWorkspaceTrusted: () => true,
    logger: new SanitizedLogger(),
    store: {
      getRunMap: () => options.runs,
      getRun: (queueId: string) => options.runs[queueId] ?? null
    },
    auditWriter: { append: async () => undefined },
    lock: {
      tryAcquire: async () => ({ acquired: options.acquired ?? true, ownerId: 'window-a' })
    },
    controller: {
      resumeExistingFromActivation: async () => undefined,
      resumeExisting,
      admitResume,
      scheduleAutoDrain: () => undefined
    },
    watchdog: { reattachOnActivation: async () => undefined },
    scheduledStartCoordinator: { reArm: async () => undefined },
    replayEvidenceBacklog: async () => undefined,
    runSafety: {
      replayTerminalTransitions: async () => undefined,
      sweepCheckpointRetention: async () => undefined
    },
    backendCapabilities: { scan: async () => undefined },
    startMountProbe: () => undefined,
    refreshCatalog: async () => undefined
  } as unknown as Parameters<typeof createStage2Producers>[0];
  return { producers: createStage2Producers(deps), admitResume, resumeExisting, completions };
}

const settle = (): Promise<void> => new Promise((done) => setImmediate(done));

describe('FR-R3-192 — path 1, the activation walk', () => {
  beforeEach(() => {
    showWarningMessage.mockClear();
  });

  it('announces one resumed Run once, naming its queue, Run, phase and both titles, while it is still going', async () => {
    const h = harness({ runs: { default: fakeRun('1afda4d8-1111-4222-8333-444455556666', 'speckit-implement') } });
    await h.producers.run();

    await vi.waitFor(() => expect(showWarningMessage).toHaveBeenCalledTimes(1));
    const message = showWarningMessage.mock.lastCall?.[0];
    expect(message).toContain('queue "default"');
    expect(message).toContain('run 1afda4d8 ');
    expect(message).toContain('phase "speckit-implement"');
    for (const title of TITLES) expect(message).toContain(title);

    // The Run has not completed: the announcement came at admission.
    expect(h.completions.has('default')).toBe(true);
    await settle();
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    h.completions.get('default')?.();
  });

  it('announces two resumed Runs on two queues twice, each with its own queue, Run and phase', async () => {
    const h = harness({
      runs: {
        alpha: fakeRun('aaaaaaaa-1111-4222-8333-444455556666', 'speckit-plan'),
        beta: fakeRun('bbbbbbbb-1111-4222-8333-444455556666', 'speckit-tasks')
      }
    });
    await h.producers.run();

    await vi.waitFor(() => expect(showWarningMessage).toHaveBeenCalledTimes(2));
    const messages = showWarningMessage.mock.calls.map((call) => call[0]);
    const alpha = messages.find((m) => m.includes('queue "alpha"'));
    const beta = messages.find((m) => m.includes('queue "beta"'));
    expect(alpha).toContain('run aaaaaaaa ');
    expect(alpha).toContain('phase "speckit-plan"');
    expect(beta).toContain('run bbbbbbbb ');
    expect(beta).toContain('phase "speckit-tasks"');
    h.completions.get('alpha')?.();
    h.completions.get('beta')?.();
  });

  it('announces nothing for a resume that admission refuses', async () => {
    const h = harness({
      runs: { default: fakeRun('1afda4d8-1111-4222-8333-444455556666', 'speckit-implement') },
      resumed: false
    });
    await h.producers.run();

    await vi.waitFor(() => expect(h.admitResume).toHaveBeenCalledTimes(1));
    await settle();
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('resumes nothing and announces nothing in a window that is not primary', async () => {
    const h = harness({
      runs: { default: fakeRun('1afda4d8-1111-4222-8333-444455556666', 'speckit-implement') },
      acquired: false
    });
    await h.producers.run();
    await settle();

    expect(h.resumeExisting).not.toHaveBeenCalled();
    expect(h.admitResume).not.toHaveBeenCalled();
    expect(showWarningMessage).not.toHaveBeenCalled();
  });
});
