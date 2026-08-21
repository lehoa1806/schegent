// Feature 103 (T024, US2 — FR-010, FR-013) — recorded provenance is a
// historical fact, and a historical fact does not change.
//
// Both fields could plausibly be answered at read time instead of stamped at
// completion, and both answers would be wrong later:
//
//   * `origin` would be answered by looking for the run's queue item on a live
//     `ConnectedWorkflowRun`. That aggregate is deletable — a Workflow run that
//     is cleaned up, or a workspace whose connected-run map was pruned, takes
//     the answer with it. A reader would then report every past member run as
//     `standalone`, which is not a degraded answer but a false one.
//   * `catalogVersion` would be answered by asking the catalog what version that
//     definition is on. The catalog moves; the run does not. A reader would
//     re-label a run with a version it never froze, which is precisely the
//     confusion FR-009 exists to remove.
//
// So the claim under test is negative and structural: after the sources are
// gone or have moved on, what the store hands back is byte-identical to what
// was written. The teeth are in the controls — each case first shows the
// would-be deriver answering *differently*, so a green result means the reader
// did not consult it rather than that there was nothing to consult.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { HistoryRecorder } from '../../src/services/history-recorder';
import { resolveRunOrigin } from '../../src/services/run-origin-resolver';
import { HistoryStore } from '../../src/state/history-store';
import {
  WorkspaceStateStore,
  type Memento
} from '../../src/state/workspace-state';
import type { ConnectedWorkflowRun } from '../../src/state/connected-workflow-run';
import { SanitizedLogger } from '../../src/lib/logger';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { projectHistory } from '../../src/ui/sidebar/history-projector';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

const QUEUE = 'queue-a';
const FROZEN = { kind: 'pipeline' as const, id: 'pipe-deploy', versionId: 'ver-3' };

/** A member run: its queue item is an attempt on a node of the connected run. */
function memberRun(): WorkflowRun {
  return {
    id: 'run-member',
    featureId: 'queue-item-7',
    featureDir: 'specs/001-member',
    status: 'completed',
    currentPhase: 'done',
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_001_000,
    phasesCompleted: [],
    lastError: null,
    pipeline: { id: 'pipe-deploy', name: 'Deploy', phases: [], catalogVersion: FROZEN },
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null
  } as unknown as WorkflowRun;
}

function connectedRun(): ConnectedWorkflowRun {
  return {
    connectedRunId: 'connected-1',
    workflowId: 'wf-release',
    graph: { id: 'wf-release', name: 'Release', nodes: [], edges: [] },
    pipelines: {},
    nodes: { deploy: { nodeId: 'deploy', attempts: [{ queueItemId: 'queue-item-7', startedAt: 1 }] } },
    decisions: [],
    revision: 1,
    startedAt: 1_700_000_000_000
  } as unknown as ConnectedWorkflowRun;
}

/**
 * The recorder wired the way the composition roots wire it, over a real store.
 *
 * `connectedRuns` is handed in by reference and read through the same accessor
 * the production port uses, so a test can delete the aggregate mid-flight and
 * see what a read-time deriver would have seen.
 */
function harness(connectedRuns: Record<string, ConnectedWorkflowRun>) {
  const memento = new FakeMemento();
  const state = new WorkspaceStateStore(memento);
  const history = new HistoryStore(state);
  const getConnectedRuns = () => connectedRuns;

  const recorder = new HistoryRecorder({
    historyStore: history,
    logger: new SanitizedLogger(),
    queueIdForTask: () => QUEUE,
    originForTask: (taskId: string) => resolveRunOrigin(getConnectedRuns(), taskId),
    descriptions: {
      write: vi.fn().mockResolvedValue('.schegent/history/run-member.txt'),
      remove: vi.fn().mockResolvedValue(undefined)
    }
  });

  return { memento, state, history, recorder, getConnectedRuns };
}

/** Re-reads from the persisted bytes, not from the store instance that wrote them. */
function rereadFromDisk(memento: Memento) {
  return new HistoryStore(new WorkspaceStateStore(memento)).list();
}

// ---------------------------------------------------------------------------
// origin
// ---------------------------------------------------------------------------

describe('a deleted ConnectedWorkflowRun does not change a recorded origin (FR-013)', () => {
  it('keeps the member origin after the aggregate it came from is gone', async () => {
    const connectedRuns: Record<string, ConnectedWorkflowRun> = { 'connected-1': connectedRun() };
    const { memento, recorder, getConnectedRuns } = harness(connectedRuns);

    await recorder.record(memberRun(), 'deploy the thing', 'completed');
    expect(rereadFromDisk(memento)[0]?.origin).toEqual({
      kind: 'workflow-member',
      workflowId: 'wf-release'
    });

    // The aggregate is cleaned up, as it is allowed to be.
    delete connectedRuns['connected-1'];

    // The control: a read-time deriver, asked the same question now, answers
    // differently. Without this the assertion below could pass on a resolver
    // that never worked.
    expect(resolveRunOrigin(getConnectedRuns(), 'queue-item-7')).toEqual({ kind: 'standalone' });

    expect(rereadFromDisk(memento)[0]?.origin).toEqual({
      kind: 'workflow-member',
      workflowId: 'wf-release'
    });
  });

  it('keeps a standalone origin after a Workflow later claims the same queue item', async () => {
    // The mirror image, and the one a "look it up on read" implementation gets
    // wrong in the other direction: queue item ids are not reserved forever, so
    // a later Workflow attempt reusing one would retroactively relabel a run
    // that genuinely ran alone.
    const connectedRuns: Record<string, ConnectedWorkflowRun> = {};
    const { memento, recorder, getConnectedRuns } = harness(connectedRuns);

    await recorder.record(memberRun(), 'deploy the thing', 'completed');
    expect(rereadFromDisk(memento)[0]?.origin).toEqual({ kind: 'standalone' });

    connectedRuns['connected-1'] = connectedRun();
    expect(resolveRunOrigin(getConnectedRuns(), 'queue-item-7')).toEqual({
      kind: 'workflow-member',
      workflowId: 'wf-release'
    });

    expect(rereadFromDisk(memento)[0]?.origin).toEqual({ kind: 'standalone' });
  });
});

// ---------------------------------------------------------------------------
// catalogVersion
// ---------------------------------------------------------------------------

describe('no reader fills an absent catalogVersion (FR-010)', () => {
  /**
   * A run that froze no version: a plan supplied ready-made, or a pre-feature
   * run.
   *
   * Its own `id`, because the second case below records this one and
   * `memberRun()` into the same store and then picks each out by `runId`. Two
   * records sharing an id make that lookup answer with whichever was written
   * first, so the version assertion would read the unversioned row and the
   * control would find nothing to compare against.
   */
  function unversionedRun(): WorkflowRun {
    return {
      ...memberRun(),
      id: 'run-unversioned',
      pipeline: { id: 'pipe-deploy', name: 'Deploy', phases: [] }
    } as unknown as WorkflowRun;
  }

  it('reads back with no version, and with no key where one could be inferred', async () => {
    const { memento, recorder } = harness({});
    await recorder.record(unversionedRun(), 'deploy the thing', 'completed');

    const [record] = rereadFromDisk(memento);
    expect(record).toBeDefined();
    // `pipelineId` is what a deriver would key off: the definition is known, so
    // "which version is it on" is answerable — and answering it would be a lie
    // about what this run executed.
    expect(record!.catalogVersion).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(record, 'catalogVersion')).toBe(false);
  });

  it('the wire projection does not fill it either', async () => {
    const { memento, recorder } = harness({});
    await recorder.record(unversionedRun(), 'deploy the thing', 'completed');
    await recorder.record(memberRun(), 'deploy the thing again', 'completed');

    const projected = projectHistory(new HistoryStore(new WorkspaceStateStore(memento)));

    const versioned = projected.find((row) => row.runId === 'run-member');
    const unversioned = projected.find((row) => row.runId === 'run-unversioned');
    expect(unversioned).toBeDefined();

    // The control: the projector does carry a version when one was recorded, so
    // the absence below is a decision and not a projector that drops the field.
    expect(versioned?.catalogVersion).toEqual(FROZEN);
    expect(unversioned?.catalogVersion).toBeUndefined();
  });

  it('the projector holds no catalog reference it could fill from', () => {
    // Structural, because behavioural coverage of "did not consult the catalog"
    // is only ever as good as the fixture's catalog. The projector takes a
    // history store and nothing else; a future edit that reaches for the
    // catalog here fails this line before it can fail an operator.
    const source = readFileSync(
      path.join(__dirname, '../../src/ui/sidebar/history-projector.ts'),
      'utf8'
    );
    const imports = source.split('\n').filter((line) => line.trimStart().startsWith('import'));
    expect(imports.join('\n')).not.toMatch(/catalog/i);
    expect(source).not.toMatch(/getCatalog|activeVersion|resolveVersion/);
  });
});
