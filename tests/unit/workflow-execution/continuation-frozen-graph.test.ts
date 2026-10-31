// Feature 254 (FR-R4-F07, C-T5, contract C7; FR-031, US5 AS5) — a Run started from a Workflow whose
// condition can never match keeps its frozen plan, and continues and resumes unchanged.
//
// The graph validator now refuses an unreachable condition (`condition-comparison-unsupported`), so a
// stored Workflow carrying one is invalid and cannot be launched. A connected Run that was launched from
// it BEFORE the change froze that graph into itself (`run.graph`), and a continuation reads nothing but
// the run's own snapshot (continuation-service.ts: "like its launch sibling, a continuation reads NO
// catalog"). This pin holds both halves of "only new launches are refused":
//
//   * the Run continues: the offered node starts, the attempt is recorded, a row is queued;
//   * the Run resumes: a completed node can be restarted;
//   * and neither path reads a catalog, nor runs the graph validator over the frozen graph.
//
// Green at baseline (TA8): a Run in flight already continues from `run.graph`. This guards the change,
// because the rule is a validator and a validator that started running on the frozen graph would turn
// an in-flight Run into a refusal. The graph validator is spied behind its real implementation, so a
// regression that re-validated would be seen as a call and not guessed from an outcome.
//
// The frozen Run is built the way an older build built it: from a valid graph, then with its one
// connection's operator set to the ordering operator the rule now refuses. The factory is the launch
// path; it is not asked to accept the unreachable graph, which is exactly the thing a launch no longer does.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const graphValidatorSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/config/workflow-graph-validator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/workflow-graph-validator')>();
  return {
    ...actual,
    validateWorkflowGraph: (...args: Parameters<typeof actual.validateWorkflowGraph>) => {
      graphValidatorSpy(...args);
      return actual.validateWorkflowGraph(...args);
    }
  };
});

import {
  buildCatalog,
  type PhaseDef,
  type PipelineDef
} from '../../../src/config/pipeline-config';
import { validateWorkflowGraph } from '../../../src/config/workflow-graph-validator';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { continueWorkflowRun } from '../../../src/headless/workflow-run-api';
import { createConnectedRunSnapshot } from '../../../src/services/workflow-execution/connected-run-factory';
import type { ContinuationDeps } from '../../../src/services/workflow-execution/continuation-service';
import {
  appendAttempt,
  appendDecision,
  type ConnectedWorkflowRun
} from '../../../src/state/connected-workflow-run';
import {
  isNodeStartable,
  projectConnectedRun
} from '../../../src/ui/sidebar/connected-run-projector';

const PHASE: PhaseDef = { id: 'phase-one', name: 'Phase One', version: 1, instruction: 'Do the work.' };

const FLOW: PipelineDef = {
  id: 'flow',
  name: 'Flow',
  phases: [PHASE.id],
  inputs: [{ portId: 'brief', label: 'Brief', type: 'text', required: true }],
  outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }]
};

/** The graph as launched, valid. The condition's operator is changed below, after the Run is frozen. */
const LAUNCHED: WorkflowDefinition = {
  workflowId: 'wf',
  name: 'Workflow',
  version: 1,
  nodes: [
    { nodeId: 'first', pipelineId: FLOW.id },
    { nodeId: 'second', pipelineId: FLOW.id }
  ],
  connections: [
    {
      from: { nodeId: 'first', portId: 'report' },
      to: { nodeId: 'second', portId: 'brief' },
      condition: { left: { source: 'node-status', nodeId: 'first' }, operator: 'equals', right: 'completed' }
    }
  ],
  startNodeIds: ['first']
};

const STARTED_AT = 1_700_000_000_000;
const NOW = 1_760_000_100_000;
const RUN_ID = 'frozen-run';
/** Opened (1), one attempt on `first` (2), one decision offering connection 0 (3). */
const REVISION = 3;

/** Freeze depth-first, as the factory does: a run's graph is a frozen snapshot, and the store checks it. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

/** A Run frozen before the rule existed: its one connection asks a node status an ordering question. */
function frozenRunWithUnreachableCondition(): ConnectedWorkflowRun {
  const snapshot = createConnectedRunSnapshot({
    connectedRunId: RUN_ID,
    workflow: LAUNCHED,
    catalog: buildCatalog([PHASE], [FLOW], { claude: [], codex: [], agy: [] }, FLOW.id),
    startedAt: STARTED_AT,
    defaultRunnerKind: 'claude'
  });
  if (snapshot.outcome !== 'created') throw new Error(`fixture could not open a run: ${snapshot.reason}`);
  const withAttempt = appendAttempt(snapshot.run, 'first', { queueItemId: 'child-1', startedAt: STARTED_AT });
  const decided = appendDecision(withAttempt, {
    nodeId: 'first',
    attemptIndex: 0,
    decidedAt: STARTED_AT + 1_000,
    operands: [],
    connections: [{ index: 0, matched: true, isDefault: false }],
    defaultApplied: false,
    eligible: [0]
  });
  const connection = decided.graph.connections.at(0);
  if (connection?.condition === undefined) throw new Error('fixture lost its condition');
  return {
    ...decided,
    graph: deepFreeze({
      ...decided.graph,
      connections: [
        {
          ...connection,
          condition: { ...connection.condition, operator: 'greaterThan' as const }
        }
      ]
    })
  };
}

interface World {
  readonly deps: ContinuationDeps;
  readonly writes: { readonly run: ConnectedWorkflowRun; readonly expectedRevision: number }[];
  readonly scheduled: unknown[];
  readonly reads: { catalog: number; resolveVersion: number };
}

function world(): World {
  const stored = frozenRunWithUnreachableCondition();
  const writes: World['writes'] = [];
  const scheduled: unknown[] = [];
  const reads = { catalog: 0, resolveVersion: 0 };
  const deps: ContinuationDeps = {
    connectedRuns: {
      get: (id: string) => (id === stored.connectedRunId ? stored : null),
      compareAndSetConnectedRun: async (run: ConnectedWorkflowRun, expectedRevision: number) => {
        writes.push({ run, expectedRevision });
        return { outcome: 'written' as const, run };
      },
      readChildState: () => 'completed' as const
    },
    guardedRun: {
      scheduleOrEnqueue: async (request) => {
        scheduled.push(request);
        return { outcome: 'enqueued', queueItemId: 'q-1' };
      }
    },
    // A catalog read of any kind would be a catalog consulted for a Run that froze its own: counted.
    getCatalog: () => {
      reads.catalog += 1;
      return buildCatalog([PHASE], [FLOW], { claude: [], codex: [], agy: [] }, FLOW.id);
    },
    resolveCatalogVersion: () => {
      reads.resolveVersion += 1;
      return undefined;
    },
    defaultRunnerKind: 'claude',
    logger: { warn: () => undefined, sanitize: (value: string) => value },
    projectRun: projectConnectedRun,
    isNodeStartable
  };
  return { deps, writes, scheduled, reads };
}

/** A node's attempts. Read through a `Map` so the lookup is `T | undefined` under both compiler settings. */
function attemptsOf(run: ConnectedWorkflowRun | undefined, nodeId: string) {
  return run === undefined ? undefined : new Map(Object.entries(run.nodes)).get(nodeId)?.attempts;
}

function payloadFor(nodeId: string) {
  return {
    connectedRunId: RUN_ID,
    expectedRevision: REVISION,
    nodeId,
    request: {
      pipelineId: FLOW.id,
      inputs: [{ portId: 'brief', type: 'text' as const, value: 'carry on' }],
      supplemental: [],
      outputs: [{ portId: 'report', target: `out/${nodeId}.md` }]
    }
  };
}

let workspaceRoot: string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'schegent-254-frozen-'));
});

afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('FR-R4-F07 C-T5 — a Run frozen with an unreachable condition continues from its own graph (FR-031)', () => {
  it('has the unreachable condition in its frozen graph (the fixture is what it claims)', () => {
    const run = frozenRunWithUnreachableCondition();
    expect(run.graph.connections[0]?.condition?.operator).toBe('greaterThan');
  });

  it('continues: the offered node starts, the attempt is recorded and a row is queued', async () => {
    const w = world();
    graphValidatorSpy.mockClear();

    const result = await continueWorkflowRun(w.deps, {
      payload: payloadFor('second'),
      workspaceRoot,
      startedAt: NOW
    });

    expect(result).toMatchObject({ outcome: 'started', revision: REVISION + 1, queueItemId: 'q-1' });
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0]!.expectedRevision).toBe(REVISION);
    expect(attemptsOf(w.writes.at(0)?.run, 'second')).toEqual([{ queueItemId: 'q-1', startedAt: NOW }]);
    expect(w.scheduled).toHaveLength(1);
  });

  it('resumes: a completed node can be restarted from the frozen plan', async () => {
    const w = world();
    graphValidatorSpy.mockClear();

    const result = await continueWorkflowRun(w.deps, {
      payload: payloadFor('first'),
      workspaceRoot,
      startedAt: NOW
    });

    expect(result).toMatchObject({ outcome: 'started', queueItemId: 'q-1' });
    expect(attemptsOf(w.writes.at(0)?.run, 'first')).toHaveLength(2);
  });

  it('reads no catalog and runs the graph validator over nothing, on either path', async () => {
    const w = world();
    graphValidatorSpy.mockClear();

    await continueWorkflowRun(w.deps, { payload: payloadFor('second'), workspaceRoot, startedAt: NOW });
    await continueWorkflowRun(w.deps, { payload: payloadFor('first'), workspaceRoot, startedAt: NOW });

    expect(w.reads.catalog).toBe(0);
    expect(w.reads.resolveVersion).toBe(0);
    expect(graphValidatorSpy).not.toHaveBeenCalled();
  });

  it('control: the spy would have seen the validator (it is wired to the real function)', () => {
    graphValidatorSpy.mockClear();
    validateWorkflowGraph(LAUNCHED, []);
    expect(graphValidatorSpy).toHaveBeenCalledTimes(1);
  });
});
