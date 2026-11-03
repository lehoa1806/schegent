// The material the operator attaches when launching a Workflow belongs to the whole run,
// not to its first Phase. Each test drives a production dispatcher (launcher, completion,
// control, recovery) against the real workspace store, so a record the store would refuse
// on read fails here too.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reconcileComposableWorkflowRuns,
  recordConnectedWorkflowTransition
} from '../../src/activation/run-safety-wiring';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { RunOutputRecord } from '../../src/contracts/run-results';
import type {
  FrozenRunPlan,
  RunRequest,
  SupplementalInput
} from '../../src/contracts/run-request';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import type { SanitizedLogger } from '../../src/lib/logger';
import { validateRunRequest } from '../../src/services/run-request/run-request-validator';
import { continueConnectedRun } from '../../src/services/workflow-execution/continuation-service';
import { launchComposableWorkflow } from '../../src/services/workflow-execution/workflow-launcher';
import type { ConnectedWorkflowRun } from '../../src/state/connected-workflow-run';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { isNodeStartable, projectConnectedRun } from '../../src/ui/sidebar/connected-run-projector';

const DRAFT_PHASE: PhaseDefinition = {
  phaseId: 'draft-phase',
  name: 'Draft',
  version: 1,
  instruction: 'Draft it'
};

const VERIFY_PHASE: PhaseDefinition = {
  phaseId: 'verify-phase',
  name: 'Verify',
  version: 1,
  instruction: 'Verify it'
};

const LEAF_WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-leaf',
  name: 'Leaf',
  version: 1,
  outputs: [{ portId: 'verification-note', label: 'Note', type: 'file', required: true }],
  startNodeIds: ['verify'],
  nodes: [{ nodeId: 'verify', kind: 'phase', phaseId: 'verify-phase' }],
  connections: [
    { from: { nodeId: 'verify' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }
  ],
  bindings: [{ kind: 'output', portId: 'verification-note', nodeId: 'verify', outputKey: 'note' }]
};

const ROOT_WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-root',
  name: 'Root',
  version: 1,
  outputs: [
    { portId: 'report', label: 'Report', type: 'file', required: true },
    { portId: 'plan', label: 'Plan', type: 'file', required: true }
  ],
  startNodeIds: ['draft'],
  nodes: [
    { nodeId: 'draft', kind: 'phase', phaseId: 'draft-phase' },
    { nodeId: 'call', kind: 'workflow', workflowId: 'wf-leaf' }
  ],
  connections: [
    { from: { nodeId: 'draft' }, to: { kind: 'node', nodeId: 'call' }, handoff: 'auto', priority: 0 },
    { from: { nodeId: 'call' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }
  ],
  bindings: [
    { kind: 'output', portId: 'report', nodeId: 'call', sourcePortId: 'verification-note' },
    { kind: 'output', portId: 'plan', nodeId: 'draft', outputKey: 'plan-file' }
  ]
};

const RUN_ID = 'crun-material';
const ROOT_INVOCATION_ID = `${RUN_ID}:root`;
const PLAN_TARGET = 'out/plan.md';
const REPORT_TARGET = 'out/report.md';
const PRIOR_RECORD: RunOutputRecord = {
  name: 'earlier-note',
  status: 'resolved',
  reference: 'notes/earlier.md'
};

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function memento(): Memento {
  const entries = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => entries.get(key) as T | undefined,
    update: (key: string, value: unknown): Thenable<void> => {
      // Round-trip through JSON: a reader must see what a restart would see.
      entries.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      return Promise.resolve();
    }
  };
}

/** Declares no public output, so a launch needs no target and can attach nothing at all. */
const ROOT_WITHOUT_OUTPUTS: WorkflowDefinition = { ...ROOT_WORKFLOW, outputs: [], bindings: [] };

interface LaunchMaterial {
  readonly rootWorkflow?: WorkflowDefinition;
  readonly instructions?: string;
  readonly supplemental?: readonly SupplementalInput[];
  readonly outputs?: RunRequest['outputs'];
}

const DEFAULT_OUTPUTS: RunRequest['outputs'] = [
  { portId: 'report', target: REPORT_TARGET },
  { portId: 'plan', target: PLAN_TARGET }
];

async function launchJourney(material: LaunchMaterial = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'launch-material-'));
  workspaces.push(workspaceRoot);
  const store = new WorkspaceStateStore(memento());
  const plans: FrozenRunPlan[] = [];
  const warn = vi.fn();
  const logger = { warn, sanitize: (text: string) => text } as unknown as SanitizedLogger;
  const guardedRun = {
    scheduleOrEnqueue: (request: { readonly runPlan?: FrozenRunPlan }) => {
      if (request.runPlan !== undefined) plans.push(request.runPlan);
      return Promise.resolve({
        outcome: 'enqueued' as const,
        queueItemId: `item-${String(plans.length)}`
      });
    }
  };
  const historyStore = {
    list: () => [],
    outputsFor: (runId: string) => (runId === 'earlier-run' ? [PRIOR_RECORD] : null)
  };
  const rootWorkflow = material.rootWorkflow ?? ROOT_WORKFLOW;
  const validated = await validateRunRequest(
    {
      pipelineId: 'wf-root',
      workflowId: 'wf-root',
      entryNodeId: 'draft',
      inputs: [],
      supplemental: material.supplemental ?? [],
      outputs: material.outputs ?? ((rootWorkflow.outputs ?? []).length === 0 ? [] : DEFAULT_OUTPUTS),
      ...(material.instructions === undefined ? {} : { instructions: material.instructions })
    },
    {
      workflow: {
        rootWorkflow,
        workflows: [rootWorkflow, LEAF_WORKFLOW],
        phases: [DRAFT_PHASE, VERIFY_PHASE]
      },
      workspaceRoot,
      now: 1000,
      localInputs: {
        checkFile: () => Promise.resolve({ ok: true }),
        checkFolder: () => Promise.resolve({ ok: true })
      },
      outputProbe: { exists: () => Promise.resolve(false) },
      priorOutputs: historyStore
    }
  );
  if (!validated.ok) throw new Error(`expected a valid launch: ${JSON.stringify(validated.errors)}`);

  const launched = await launchComposableWorkflow(
    {
      guardedRun,
      logger,
      connectedRuns: store,
      isChildSettled: () => true,
      readPriorRunOutputs: historyStore.outputsFor
    },
    { connectedRunId: RUN_ID, envelope: validated.plan, workspaceRoot, startedAt: 1000 }
  );
  expect(launched.outcome).toBe('started');

  const terminalRuns: Record<string, WorkflowRun | undefined> = {};
  const port = {
    getConnectedRuns: () => store.getConnectedRuns(),
    getRunMap: () => terminalRuns,
    getHistory: () => [],
    compareAndSetConnectedRun: (next: ConnectedWorkflowRun, expected: number) =>
      store.compareAndSetConnectedRun(next, expected)
  };
  const wiring = { workspaceRoot, store: port, logger, historyStore, getGuardedRun: () => guardedRun };
  const leafRun = (
    queueItemId: string,
    status: WorkflowRun['status'],
    runOutputs: readonly RunOutputRecord[]
  ): WorkflowRun =>
    ({ featureId: queueItemId, status, lastTransitionAt: 2000, runOutputs }) as unknown as WorkflowRun;

  return {
    workspaceRoot,
    store,
    plans,
    warn,
    guardedRun,
    logger,
    historyStore,
    wiring,
    terminalRuns,
    leafRun,
    currentRun: (): ConnectedWorkflowRun => {
      const run = store.getConnectedRun(RUN_ID);
      if (run === null) throw new Error('expected the run to read back from the store');
      return run;
    },
    finish: (queueItemId: string, status: WorkflowRun['status'], outputs: readonly RunOutputRecord[]) =>
      recordConnectedWorkflowTransition(wiring, leafRun(queueItemId, status, outputs))
  };
}

type Journey = Awaited<ReturnType<typeof launchJourney>>;

function planAt(journey: Journey, index: number): FrozenRunPlan {
  const plan = journey.plans.at(index);
  if (plan === undefined) throw new Error(`expected a plan at ${String(index)}`);
  return plan;
}

function targetsOf(plan: FrozenRunPlan): ReadonlyArray<readonly [string, string, boolean]> {
  return plan.outputs.map((output) => [output.portId, output.target, output.overwriteConfirmed]);
}

function childFrame(run: ConnectedWorkflowRun) {
  const frame = Object.values(run.invocations ?? {}).find((f) => f.parentInvocationId !== null);
  if (frame === undefined) throw new Error('expected a child frame');
  return frame;
}

function rootFrame(run: ConnectedWorkflowRun) {
  const frame = run.invocations?.[ROOT_INVOCATION_ID];
  if (frame === undefined) throw new Error('expected the root frame');
  return frame;
}

async function createTarget(journey: Journey, target: string): Promise<void> {
  const absolute = join(journey.workspaceRoot, target);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, 'written earlier');
}

function controlDeps(journey: Journey) {
  return {
    guardedRun: journey.guardedRun,
    logger: journey.logger,
    readPriorRunOutputs: journey.historyStore.outputsFor,
    connectedRuns: {
      get: (id: string) => journey.store.getConnectedRuns()[id] ?? null,
      compareAndSetConnectedRun: (next: ConnectedWorkflowRun, expected: number) =>
        journey.store.compareAndSetConnectedRun(next, expected),
      readChildState: () => null
    },
    projectRun: projectConnectedRun,
    isNodeStartable
  };
}

function retryRoot(journey: Journey) {
  return continueConnectedRun(controlDeps(journey), {
    payload: {
      connectedRunId: RUN_ID,
      expectedRevision: journey.currentRun().revision,
      nodeId: 'draft',
      invocationId: ROOT_INVOCATION_ID,
      operation: 'retry-invocation',
      request: { pipelineId: 'draft-phase', inputs: [], supplemental: [], outputs: [] }
    },
    workspaceRoot: journey.workspaceRoot,
    startedAt: 3000
  });
}

describe('the launch material reaches every Phase of a composable Workflow', () => {
  it('stores it on the run, and stores nothing when nothing was attached', async () => {
    const bare = await launchJourney({ rootWorkflow: ROOT_WITHOUT_OUTPUTS });
    expect(Object.keys(bare.currentRun())).not.toContain('launchContext');

    const attached = await launchJourney({
      instructions: 'Keep it small',
      supplemental: [{ kind: 'text', text: 'Style guide' }]
    });
    expect(attached.currentRun().launchContext).toMatchObject({
      instructions: 'Keep it small',
      supplemental: [{ kind: 'text', value: 'Style guide' }],
      outputs: [
        { portId: 'report', target: REPORT_TARGET },
        { portId: 'plan', target: PLAN_TARGET }
      ]
    });
  });

  it('carries instructions and supplemental into a later Phase through the completion path', async () => {
    const journey = await launchJourney({
      instructions: 'Keep it small',
      supplemental: [{ kind: 'text', text: 'Style guide' }]
    });

    await journey.finish('item-1', 'completed', [
      { name: 'plan-file', status: 'resolved', reference: PLAN_TARGET }
    ]);

    expect(journey.warn).not.toHaveBeenCalled();
    const later = planAt(journey, 1);
    expect(later.pipeline.id).toBe('verify-phase');
    expect(later.instructions).toBe('Keep it small');
    expect(later.supplemental).toEqual([{ kind: 'text', value: 'Style guide' }]);
  });

  it('accepts a prior-output attachment at a later Phase', async () => {
    const journey = await launchJourney({
      supplemental: [
        {
          kind: 'prior-output',
          reference: { sourceRunId: 'earlier-run', outputName: PRIOR_RECORD.name }
        }
      ]
    });

    await journey.finish('item-1', 'completed', [
      { name: 'plan-file', status: 'resolved', reference: PLAN_TARGET }
    ]);

    expect(journey.warn).not.toHaveBeenCalled();
    expect(journey.plans).toHaveLength(2);
    expect(planAt(journey, 1).supplemental.at(0)).toMatchObject({ kind: 'prior-output' });
    expect(rootFrame(journey.currentRun()).status).toBe('in-flight');
  });

  it('carries them into a Phase started by a Retry through the control path', async () => {
    const journey = await launchJourney({
      instructions: 'Keep it small',
      supplemental: [{ kind: 'text', text: 'Style guide' }]
    });
    await journey.finish('item-1', 'failed', []);
    expect(rootFrame(journey.currentRun()).status).toBe('failed');

    const retried = await retryRoot(journey);

    expect(retried.outcome).toBe('started');
    const again = planAt(journey, 1);
    expect(again.pipeline.id).toBe('draft-phase');
    expect(again.instructions).toBe('Keep it small');
    expect(again.supplemental).toEqual([{ kind: 'text', value: 'Style guide' }]);
    expect(targetsOf(again)).toEqual([['plan-file', PLAN_TARGET, true]]);
  });

  it('carries them into a Phase started by startup recovery', async () => {
    const journey = await launchJourney({
      instructions: 'Keep it small',
      supplemental: [{ kind: 'text', text: 'Style guide' }]
    });
    // The first Phase finished while the host was down: recovery finds it in the Run map.
    journey.terminalRuns.anyQueue = journey.leafRun('item-1', 'completed', [
      { name: 'plan-file', status: 'resolved', reference: PLAN_TARGET }
    ]);

    await reconcileComposableWorkflowRuns(journey.wiring);

    expect(journey.warn).not.toHaveBeenCalled();
    const later = planAt(journey, 1);
    expect(later.pipeline.id).toBe('verify-phase');
    expect(later.instructions).toBe('Keep it small');
    expect(later.supplemental).toEqual([{ kind: 'text', value: 'Style guide' }]);
    expect(targetsOf(later)).toEqual([['note', REPORT_TARGET, false]]);
  });
});

describe('a root output target reaches the node bound to it', () => {
  it('tells each Phase its own target under the key its binding reads, and the run completes', async () => {
    const journey = await launchJourney();

    expect(targetsOf(planAt(journey, 0))).toEqual([['plan-file', PLAN_TARGET, false]]);

    await journey.finish('item-1', 'completed', [
      { name: 'plan-file', status: 'resolved', reference: PLAN_TARGET }
    ]);
    expect(targetsOf(planAt(journey, 1))).toEqual([['note', REPORT_TARGET, false]]);

    await journey.finish('item-2', 'completed', [
      { name: 'note', status: 'resolved', reference: REPORT_TARGET }
    ]);

    expect(journey.warn).not.toHaveBeenCalled();
    const root = rootFrame(journey.currentRun());
    expect(root.failureCode).toBeUndefined();
    expect(root.status).toBe('completed');
  });

  it('refuses a later Phase over a file someone else put at its target, naming the code and not the path', async () => {
    const journey = await launchJourney();
    await createTarget(journey, REPORT_TARGET);

    await journey.finish('item-1', 'completed', [
      { name: 'plan-file', status: 'resolved', reference: PLAN_TARGET }
    ]);

    expect(journey.plans).toHaveLength(1);
    const child = childFrame(journey.currentRun());
    expect(child.status).toBe('failed');
    expect(child.failureCode).toBe('rejected-validation');
    expect(child.failureMessage).toContain('output-overwrite-unconfirmed');
    expect(child.failureMessage).not.toContain(REPORT_TARGET);
    expect(rootFrame(journey.currentRun()).status).toBe('failed');
  });

  it('keeps refusing on a retry, because a refused dispatch recorded no attempt', async () => {
    const journey = await launchJourney();
    await createTarget(journey, REPORT_TARGET);
    await journey.finish('item-1', 'completed', [
      { name: 'plan-file', status: 'resolved', reference: PLAN_TARGET }
    ]);
    const refusedChild = childFrame(journey.currentRun());
    expect(refusedChild.status).toBe('failed');

    const retried = await continueConnectedRun(controlDeps(journey), {
      payload: {
        connectedRunId: RUN_ID,
        expectedRevision: journey.currentRun().revision,
        nodeId: 'verify',
        invocationId: refusedChild.invocationId,
        operation: 'retry-invocation',
        request: { pipelineId: 'verify-phase', inputs: [], supplemental: [], outputs: [] }
      },
      workspaceRoot: journey.workspaceRoot,
      startedAt: 3000
    });

    expect(retried.outcome).not.toBe('started');
    expect(journey.plans).toHaveLength(1);
  });

  it('lets a retried child overwrite what its earlier frame was told to write', async () => {
    const journey = await launchJourney();
    await journey.finish('item-1', 'completed', [
      { name: 'plan-file', status: 'resolved', reference: PLAN_TARGET }
    ]);
    await createTarget(journey, REPORT_TARGET);
    await journey.finish('item-2', 'failed', []);
    const failedChild = childFrame(journey.currentRun());
    expect(failedChild.status).toBe('failed');

    const retried = await continueConnectedRun(controlDeps(journey), {
      payload: {
        connectedRunId: RUN_ID,
        expectedRevision: journey.currentRun().revision,
        nodeId: 'verify',
        invocationId: failedChild.invocationId,
        operation: 'retry-invocation',
        request: { pipelineId: 'verify-phase', inputs: [], supplemental: [], outputs: [] }
      },
      workspaceRoot: journey.workspaceRoot,
      startedAt: 3000
    });

    expect(retried.outcome).toBe('started');
    expect(targetsOf(planAt(journey, 2))).toEqual([['note', REPORT_TARGET, true]]);
  });
});
