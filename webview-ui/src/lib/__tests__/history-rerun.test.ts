import { describe, it, expect } from 'vitest';
import {
  resolveRerunTarget,
  rerunUnavailableMessage,
  type RerunTarget,
  type RerunUnavailableReason
} from '../history-rerun';
import type { HistoryRow } from '../history-rows';
import type { LaunchProjection, QueueRuntime } from '../snapshot-types';
import { buildQueueRuntime } from './queue-runtime-fixture';

// Feature 103 (T059-T062, US5) — the re-run decision, made where it can be read
// without mounting anything.
//
// Every FR in this file is about a claim the form makes before the operator
// touches it: which version it will run, which queue it will land in, and
// whether it is repeating one Pipeline out of a Workflow. Those are exactly the
// claims that are dangerous when silently wrong, so they are resolved by a pure
// function and asserted here, rather than inferred from rendered text.

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  const base: HistoryRow = {
    runId: 'run-1',
    queueId: 'default',
    queueName: 'Default',
    source: 'recorded',
    status: 'completed',
    definitionId: 'pipe-a',
    catalogVersion: { kind: 'pipeline', id: 'pipe-a', versionId: 'v1' },
    origin: { kind: 'standalone' },
    descriptionPreview: 'ship the thing',
    descriptionLength: 14,
    orderingKey: '2026-05-10T12:00:42.000Z',
    startedAt: '2026-05-10T12:00:00.000Z',
    completedAt: '2026-05-10T12:00:42.000Z',
    durationMs: 42_000
  };
  return Object.freeze({ ...base, ...overrides });
}

function projection(activeVersionId = 'v1'): LaunchProjection {
  return {
    pipelines: {
      state: 'entries',
      entries: [
        {
          kind: 'pipeline',
          id: 'pipe-a',
          name: 'Pipeline A',
          activeVersionId,
          inputs: []
        }
      ]
    },
    workflows: { state: 'entries', entries: [] }
  };
}

// The registry as the snapshot publishes it, built through the shared fixture so
// a field added to `QueueRuntime` reaches this suite too.
const QUEUES: readonly QueueRuntime[] = Object.freeze([
  buildQueueRuntime({ queueId: 'default', name: 'Default', position: 0 }),
  buildQueueRuntime({
    queueId: '5f1c9a2e-0000-4000-8000-000000000001',
    name: 'Nightly',
    position: 1
  })
]);

/** Narrow for the assertions below; a failure here is the test's own bug. */
function ready(target: RerunTarget): Extract<RerunTarget, { state: 'ready' }> {
  if (target.state !== 'ready') {
    throw new Error(`expected a ready target, got unavailable/${target.reason}`);
  }
  return target;
}

describe('resolveRerunTarget — the version it will run (FR-034, FR-035, FR-036)', () => {
  it('targets the Active version, never the historical one', () => {
    const target = ready(
      resolveRerunTarget(row({ catalogVersion: { kind: 'pipeline', id: 'pipe-a', versionId: 'v1' } }),
        projection('v7'),
        QUEUES)
    );

    // The launchable IS the Active version — the projection lists nothing else.
    expect(target.launchable.activeVersionId).toBe('v7');
  });

  it('reports the historical version when it differs, so the form can say so', () => {
    const target = ready(resolveRerunTarget(row(), projection('v7'), QUEUES));
    expect(target.supersededVersionId).toBe('v1');
  });

  it('reports no difference when the historical version is still Active', () => {
    const target = ready(resolveRerunTarget(row(), projection('v1'), QUEUES));
    // `null` and not `'v1'`: the notice is driven off this field, and a value
    // here would make the form announce a difference that does not exist.
    expect(target.supersededVersionId).toBeNull();
  });
});

describe('resolveRerunTarget — when re-run is unavailable (FR-037)', () => {
  const cases: ReadonlyArray<readonly [string, RerunTarget, RerunUnavailableReason]> = [
    [
      'the projection has not arrived',
      resolveRerunTarget(row(), undefined, QUEUES),
      'catalog-loading'
    ],
    [
      'the run recorded no version, so which definition it ran is not recoverable',
      resolveRerunTarget(row({ catalogVersion: null }), projection(), QUEUES),
      'definition-not-recorded'
    ],
    [
      'the catalog holds no Pipelines at all',
      resolveRerunTarget(row(), { pipelines: { state: 'no-definitions' }, workflows: { state: 'no-definitions' } }, QUEUES),
      'catalog-empty'
    ],
    [
      'Pipelines exist but none is published',
      resolveRerunTarget(row(), { pipelines: { state: 'none-active' }, workflows: { state: 'none-active' } }, QUEUES),
      'none-published'
    ],
    [
      'this Pipeline specifically has no Active version',
      resolveRerunTarget(row({ catalogVersion: { kind: 'pipeline', id: 'gone', versionId: 'v1' } }), projection(), QUEUES),
      'definition-not-published'
    ]
  ];

  for (const [when, target, reason] of cases) {
    it(`is unavailable, with a stated reason, when ${when}`, () => {
      expect(target.state).toBe('unavailable');
      expect(target).toMatchObject({ reason });
      // FR-037's second sentence — "It MUST NOT be silently absent." Every arm
      // has a sentence, and none of them is empty.
      expect(rerunUnavailableMessage(reason).length).toBeGreaterThan(0);
    });
  }

  it('gives each reason its own sentence, so two causes never read alike', () => {
    const reasons = cases.map(([, , reason]) => reason);
    const sentences = new Set(reasons.map(rerunUnavailableMessage));
    expect(sentences.size).toBe(reasons.length);
  });
});

describe('resolveRerunTarget — a Workflow member (FR-055)', () => {
  it('repeats that Pipeline alone, against the Pipeline’s Active version', () => {
    // The conflation this test exists for: a member's frozen body IS a Pipeline,
    // so `catalogVersion.kind` reads 'pipeline' while `origin.kind` reads
    // 'workflow-member'. Resolving off the version ref is what makes re-running
    // one member a Pipeline launch rather than a graph reconstruction.
    const target = ready(
      resolveRerunTarget(
        row({ origin: { kind: 'workflow-member', workflowId: 'wf-9' } }),
        projection('v7'),
        QUEUES
      )
    );

    expect(target.launchable.kind).toBe('pipeline');
    expect(target.launchable.id).toBe('pipe-a');
    // FR-055 — "MUST state that it is doing so".
    expect(target.workflowMemberOf).toBe('wf-9');
  });

  it('names no Workflow for a standalone run, and none for a run with no origin', () => {
    expect(ready(resolveRerunTarget(row(), projection(), QUEUES)).workflowMemberOf).toBeNull();
    expect(
      ready(resolveRerunTarget(row({ origin: null }), projection(), QUEUES)).workflowMemberOf
    ).toBeNull();
  });

  it('never resolves against the Workflows section, so no graph can be reached', () => {
    const target = resolveRerunTarget(
      row({ origin: { kind: 'workflow-member', workflowId: 'wf-9' } }),
      {
        pipelines: { state: 'none-active' },
        // A Workflow published under the same id as the member's Pipeline. If the
        // resolver ever fell back to this section it would hand the form a graph.
        workflows: {
          state: 'entries',
          entries: [
            { kind: 'workflow', id: 'pipe-a', name: 'Workflow A', activeVersionId: 'v1', inputs: [] }
          ]
        }
      },
      QUEUES
    );

    expect(target).toEqual({ state: 'unavailable', reason: 'none-published' });
  });
});

describe('resolveRerunTarget — the queue it will land in (FR-059)', () => {
  it('targets the historical queue while it still exists, and says it did not substitute', () => {
    const target = ready(
      resolveRerunTarget(
        row({ queueId: '5f1c9a2e-0000-4000-8000-000000000001', queueName: 'Nightly' }),
        projection(),
        QUEUES
      )
    );

    expect(target.queue).toEqual({
      queueId: '5f1c9a2e-0000-4000-8000-000000000001',
      name: 'Nightly',
      substituted: false
    });
  });

  it('falls back to the default queue when the historical one is gone, and says so', () => {
    const target = ready(
      resolveRerunTarget(row({ queueId: 'deleted-queue', queueName: 'deleted-queue' }), projection(), QUEUES)
    );

    // `substituted` is the whole point: FR-059 calls a silent swap the same
    // class of unstated substitution as re-running the historical version.
    expect(target.queue).toEqual({ queueId: 'default', name: 'Default', substituted: true });
  });

  it('substitutes for a run that was never attributed to a queue', () => {
    // `__unattributed__` is a real partition in history and never a registered
    // queue, so it can be listed but not enqueued into.
    const target = ready(
      resolveRerunTarget(row({ queueId: '__unattributed__', queueName: 'Unattributed' }), projection(), QUEUES)
    );

    expect(target.queue.substituted).toBe(true);
    expect(target.queue.queueId).toBe('default');
  });

  it('names the default by its id when the registry has not arrived', () => {
    const target = ready(resolveRerunTarget(row({ queueId: 'gone' }), projection(), undefined));
    expect(target.queue).toEqual({ queueId: 'default', name: 'default', substituted: true });
  });
});
