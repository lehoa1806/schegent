import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TreeTeardownOutcome, TreeTeardownResult } from '../../../src/contracts/backend-runner';
import {
  recordTeardownEvidence,
  type HostTeardownRecorderDeps
} from '../../../src/controller/host-teardown-recorder';
import type { TeardownReport } from '../../../src/runner/backend-runner-registry';

/**
 * FR-R4-F06 (FR-023; T25; contract S, S7; TA15) -- shutdown evidence is written before ownership
 * is released.
 *
 * WHAT IS RECORDED. A tree the ladder could not answer for: Windows (`platform-unanswerable`,
 * `taskkill` was sent but no tree can be confirmed) and a ladder still pending at the bound
 * (`bound-elapsed`). Neither is `process-tree-unconfirmed`, which means a delivered SIGKILL and a
 * surviving group, so neither can reuse it. `group-gone` and `tree-unconfirmed` write nothing
 * here: the first needs no evidence, and the second is filed by the tree recorder, whose
 * in-flight appends this function waits for.
 *
 * WHY BEFORE RELEASE. The audit writer refuses appends outside the owner window, so the row must
 * land while this window is still primary. The control is M15: running this after the lease
 * release turns the ordering case red.
 *
 * It starts no timer and makes no wait of its own, so it adds nothing to the teardown bound beyond
 * its appends (TA15).
 */
const BOUND_MS = 2_750;

const outcomeOf = (
  result: TreeTeardownResult,
  over: Partial<TreeTeardownOutcome> = {}
): TreeTeardownOutcome => ({
  attribution: { runId: 'run-1', phase: 'speckit-implement', iteration: 2 },
  runner: 'codex-cli',
  pid: 4242,
  result,
  ...over
});

const reportOf = (...outcomes: TreeTeardownOutcome[]): TeardownReport => ({
  outcomes,
  boundMs: BOUND_MS,
  elapsedMs: 120
});

type Appended = Parameters<HostTeardownRecorderDeps['append']>[0];

function harness(over: Partial<HostTeardownRecorderDeps> = {}) {
  const events: string[] = [];
  const appended: Appended[] = [];
  const warnings: string[] = [];
  const deps: HostTeardownRecorderDeps = {
    treeRecorder: {
      settled: async () => {
        events.push('settled');
      }
    },
    append: async (entry) => {
      events.push('append');
      appended.push(entry);
      return undefined;
    },
    logger: { warn: (message: string) => void warnings.push(message) },
    ...over
  };
  return { deps, events, appended, warnings };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('recordTeardownEvidence (T25)', () => {
  it('awaits the tree recorder before it appends anything', async () => {
    let releaseSettled: () => void = () => undefined;
    const h = harness({
      treeRecorder: {
        settled: () =>
          new Promise<void>((resolve) => {
            h.events.push('settled-called');
            releaseSettled = () => {
              h.events.push('settled-resolved');
              resolve();
            };
          })
      }
    });

    const done = recordTeardownEvidence(reportOf(outcomeOf('bound-elapsed')), h.deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.events, 'nothing is appended while the tree recorder still has appends in flight').toEqual([
      'settled-called'
    ]);
    releaseSettled();
    await done;

    expect(h.events).toEqual(['settled-called', 'settled-resolved', 'append']);
  });

  it.each(['platform-unanswerable', 'bound-elapsed'] as const)(
    'appends one host-teardown-unconfirmed row for a %s outcome, attributed to its Run',
    async (result) => {
      const h = harness();
      await recordTeardownEvidence(reportOf(outcomeOf(result)), h.deps);

      expect(h.appended).toEqual([
        {
          runId: 'run-1',
          phase: 'speckit-implement',
          iteration: 2,
          eventType: 'host-teardown-unconfirmed',
          payload: { runner: 'codex-cli', pid: 4242, result, boundMs: BOUND_MS },
          outcome: 'info'
        }
      ]);
    }
  );

  it('appends one row per qualifying outcome, in order', async () => {
    const h = harness();
    await recordTeardownEvidence(
      reportOf(
        outcomeOf('bound-elapsed', { attribution: { runId: 'run-a', phase: 'speckit-plan', iteration: 1 } }),
        outcomeOf('group-gone'),
        outcomeOf('platform-unanswerable', {
          attribution: { runId: 'run-b', phase: 'speckit-tasks', iteration: 4 }
        })
      ),
      h.deps
    );
    expect(h.appended.map((entry) => entry.runId)).toEqual(['run-a', 'run-b']);
  });

  it.each(['group-gone', 'tree-unconfirmed'] as const)('writes no row for a %s outcome', async (result) => {
    const h = harness();
    await recordTeardownEvidence(reportOf(outcomeOf(result)), h.deps);
    expect(h.appended).toEqual([]);
  });

  it('drops an outcome with no Run, as the tree recorder does, rather than inventing one', async () => {
    const h = harness();
    await recordTeardownEvidence(
      reportOf(
        outcomeOf('bound-elapsed', {
          attribution: { runId: null, phase: 'speckit-implement', iteration: 1 }
        })
      ),
      h.deps
    );
    expect(h.appended).toEqual([]);
  });

  it('writes a closed payload: runner, pid, result and boundMs, and nothing else', async () => {
    const h = harness();
    await recordTeardownEvidence(reportOf(outcomeOf('bound-elapsed')), h.deps);
    expect(Object.keys(h.appended[0]?.payload ?? {}).sort()).toEqual([
      'boundMs',
      'pid',
      'result',
      'runner'
    ]);
  });

  it('records a null pid as null', async () => {
    const h = harness();
    await recordTeardownEvidence(reportOf(outcomeOf('platform-unanswerable', { pid: null })), h.deps);
    expect(h.appended[0]?.payload).toMatchObject({ pid: null });
  });

  it('resolves and logs by kind only when an append throws, then still tries the next outcome', async () => {
    const attempts: string[] = [];
    const secret = '/Users/someone/private/path SCHEGENT_TEST_SECRET_abc123';
    const h = harness({
      append: async (entry) => {
        attempts.push(entry.runId);
        throw new Error(secret);
      }
    });

    await expect(
      recordTeardownEvidence(
        reportOf(
          outcomeOf('bound-elapsed', { attribution: { runId: 'run-a', phase: 'speckit-plan', iteration: 1 } }),
          outcomeOf('platform-unanswerable', {
            attribution: { runId: 'run-b', phase: 'speckit-plan', iteration: 1 }
          })
        ),
        h.deps
      )
    ).resolves.toBeUndefined();

    expect(attempts).toEqual(['run-a', 'run-b']);
    expect(h.warnings).toHaveLength(2);
    for (const line of h.warnings) {
      expect(line).toContain('host-teardown-unconfirmed');
      expect(line, 'the thrown message may hold a path or a value').not.toContain(secret);
      expect(line).not.toContain('/Users/');
    }
  });

  it('resolves when the tree recorder cannot say it has settled', async () => {
    const h = harness({
      treeRecorder: {
        settled: async () => {
          throw new Error('the recorder is gone');
        }
      }
    });
    await expect(recordTeardownEvidence(reportOf(outcomeOf('bound-elapsed')), h.deps)).resolves.toBeUndefined();
    // The evidence still lands: a recorder that failed to settle is not a reason to lose this row.
    expect(h.appended).toHaveLength(1);
  });

  it('finishes before the lease release it precedes', async () => {
    const order: string[] = [];
    const h = harness({
      append: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('evidence-appended');
        return undefined;
      }
    });

    await recordTeardownEvidence(reportOf(outcomeOf('bound-elapsed')), h.deps);
    order.push('leases-released');

    expect(order).toEqual(['evidence-appended', 'leases-released']);
  });

  it('adds no wait of its own: it settles with no timer advanced and leaves none pending (TA15)', async () => {
    vi.useFakeTimers();
    const h = harness();

    await recordTeardownEvidence(
      reportOf(outcomeOf('bound-elapsed'), outcomeOf('platform-unanswerable')),
      h.deps
    );

    expect(h.appended).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
