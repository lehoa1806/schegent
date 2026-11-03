import { describe, expect, it, vi } from 'vitest';
import type { PhaseDefinition } from '../../../../src/contracts/process-definitions';
import type { FrozenOutputRequest, FrozenSupplementalInput } from '../../../../src/contracts/run-request';
import type { WorkflowDefinition } from '../../../../src/contracts/workflow-definitions';
import type { GuardedScheduleRequest } from '../../../../src/services/guarded-run-service';
import type { PhaseAttemptDispatchInput } from '../../../../src/services/workflow-execution/connected-run-coordinator';
import {
  createChildWorkflowInvocationFrame,
  createComposableWorkflowRunSnapshot,
  createNodeAttemptRecord
} from '../../../../src/services/workflow-execution/connected-run-factory';
import type {
  NodeRunStartDeps,
  NodeRunStartResult
} from '../../../../src/services/workflow-execution/node-run-starter';
import {
  buildPhaseAttemptRequest,
  launchContextOf,
  phaseDispatchResultOf,
  startPhaseAttempt
} from '../../../../src/services/workflow-execution/phase-attempt-start';
import {
  assertConnectedRunInvariants,
  ConnectedRunInvariantError,
  recordNodeAttempt,
  upsertInvocationFrame,
  type ConnectedRunLaunchContext,
  type ConnectedWorkflowRun,
  type InvocationInputEnvelope,
  type WorkflowInvocationFrame
} from '../../../../src/state/connected-workflow-run';

const PHASES: readonly PhaseDefinition[] = ['one', 'two', 'three'].map((id) => ({
  phaseId: id,
  name: id,
  version: 1,
  instruction: `Do ${id}`
}));

const GRANDCHILD: WorkflowDefinition = {
  workflowId: 'wf-grandchild',
  name: 'Grandchild',
  version: 1,
  outputs: [{ portId: 'deep-port', label: 'Deep', type: 'file', required: true }],
  startNodeIds: ['deep'],
  nodes: [{ nodeId: 'deep', kind: 'phase', phaseId: 'three' }],
  connections: [
    { from: { nodeId: 'deep' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }
  ],
  bindings: [{ kind: 'output', portId: 'deep-port', nodeId: 'deep', outputKey: 'deep-key' }]
};

const CHILD: WorkflowDefinition = {
  workflowId: 'wf-child',
  name: 'Child',
  version: 1,
  outputs: [{ portId: 'child-port', label: 'Child', type: 'file', required: true }],
  startNodeIds: ['inner-call'],
  nodes: [{ nodeId: 'inner-call', kind: 'workflow', workflowId: 'wf-grandchild' }],
  connections: [
    { from: { nodeId: 'inner-call' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }
  ],
  bindings: [{ kind: 'output', portId: 'child-port', nodeId: 'inner-call', sourcePortId: 'deep-port' }]
};

const ROOT: WorkflowDefinition = {
  workflowId: 'wf-root',
  name: 'Root',
  version: 1,
  outputs: [
    { portId: 'report', label: 'Report', type: 'file', required: true },
    { portId: 'plan', label: 'Plan', type: 'file', required: true },
    { portId: 'twin', label: 'Twin', type: 'file', required: false }
  ],
  startNodeIds: ['first'],
  nodes: [
    { nodeId: 'first', kind: 'phase', phaseId: 'one' },
    { nodeId: 'fallback', kind: 'phase', phaseId: 'two' },
    { nodeId: 'call', kind: 'workflow', workflowId: 'wf-child' }
  ],
  connections: [
    { from: { nodeId: 'first' }, to: { kind: 'node', nodeId: 'call' }, handoff: 'auto', priority: 0 },
    { from: { nodeId: 'call' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 },
    { from: { nodeId: 'fallback' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }
  ],
  bindings: [
    { kind: 'output', portId: 'plan', nodeId: 'first', outputKey: 'plan-key' },
    { kind: 'output', portId: 'twin', nodeId: 'first', outputKey: 'plan-key' },
    { kind: 'output', portId: 'plan', nodeId: 'fallback', sourcePortId: 'fallback-source', outputKey: 'ignored' },
    { kind: 'output', portId: 'report', nodeId: 'call', sourcePortId: 'child-port' }
  ]
};

function target(portId: string, path: string, overwriteConfirmed = false): FrozenOutputRequest {
  return { portId, type: 'file', target: path, overwriteConfirmed };
}

const CONTEXT: ConnectedRunLaunchContext = {
  supplemental: [{ kind: 'text', value: 'Style guide' }],
  outputs: [
    target('report', 'out/report.md'),
    target('plan', 'out/plan.md'),
    target('twin', 'out/twin.md')
  ],
  instructions: 'Keep it small'
};

interface Fixture {
  readonly run: ConnectedWorkflowRun;
  readonly root: WorkflowInvocationFrame;
}

function openRun(launchContext?: ConnectedRunLaunchContext): Fixture {
  const created = createComposableWorkflowRunSnapshot({
    connectedRunId: 'crun-1',
    workflow: ROOT,
    entryNodeId: 'first',
    effectiveWorkflows: [ROOT, CHILD, GRANDCHILD],
    effectivePhases: PHASES,
    boundInputs: {},
    startedAt: 1000,
    ...(launchContext !== undefined ? { launchContext } : {})
  });
  if (created.outcome !== 'created') throw new Error('expected a run');
  const root = created.run.invocations?.[created.rootInvocationId];
  if (root === undefined) throw new Error('expected a root frame');
  return { run: created.run, root };
}

function envelope(
  frame: WorkflowInvocationFrame,
  nodeId: string,
  overrides: readonly FrozenOutputRequest[] = [],
  localInputs: readonly FrozenSupplementalInput[] = []
): InvocationInputEnvelope {
  return {
    envelopeId: `${frame.invocationId}:${nodeId}:envelope`,
    invocationId: frame.invocationId,
    targetNodeId: nodeId,
    source: 'binding',
    inputsByPort: {},
    localInputs,
    outputTargetOverrides: overrides,
    acceptedAt: 1000
  };
}

function dispatchInput(
  fixture: { readonly run: ConnectedWorkflowRun },
  frame: WorkflowInvocationFrame,
  nodeId: string,
  inputEnvelope: InvocationInputEnvelope = envelope(frame, nodeId)
): PhaseAttemptDispatchInput {
  const phase = PHASES.at(0);
  if (phase === undefined) throw new Error('expected a Phase');
  return {
    run: fixture.run,
    frame,
    node: { nodeId, kind: 'phase', phaseId: phase.phaseId },
    phase,
    boundInputs: {},
    inputEnvelope,
    attemptId: 'attempt-preview',
    attemptIndex: 1,
    queueId: 'q',
    startedAt: 2000
  };
}

/** Record an attempt of `nodeId` on `frame`, as the coordinator does after a dispatch. */
function withAttempt(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame,
  nodeId: string,
  nodeKind: 'phase' | 'workflow' = 'phase',
  inputEnvelope: InvocationInputEnvelope = envelope(frame, nodeId)
): { readonly run: ConnectedWorkflowRun; readonly frame: WorkflowInvocationFrame } {
  const attempt = createNodeAttemptRecord({
    frame,
    nodeId,
    nodeKind,
    targetDefinitionId: nodeKind === 'phase' ? 'one' : 'wf-child',
    inputEnvelope,
    startedAt: 1500,
    queueItemId: 'item'
  });
  const next = recordNodeAttempt(frame, attempt);
  return { run: upsertInvocationFrame(run, next), frame: next };
}

/** Enter `call` on `parent`: the call attempt goes on record, then the child frame opens. */
function enterChild(
  run: ConnectedWorkflowRun,
  parent: WorkflowInvocationFrame,
  callNodeId: string,
  childWorkflow: WorkflowDefinition
): { readonly run: ConnectedWorkflowRun; readonly parent: WorkflowInvocationFrame; readonly child: WorkflowInvocationFrame } {
  const called = withAttempt(run, parent, callNodeId, 'workflow');
  const attempts = called.frame.attemptsByNodeId[callNodeId] ?? [];
  const parentAttempt = attempts.at(-1);
  if (parentAttempt === undefined) throw new Error('expected a call attempt');
  const child = createChildWorkflowInvocationFrame({
    parentFrame: called.frame,
    callNodeId,
    parentAttemptId: parentAttempt.attemptId,
    childWorkflow,
    boundInputs: {},
    startedAt: 1600
  });
  return { run: upsertInvocationFrame(called.run, child), parent: called.frame, child };
}

function outputsOf(input: PhaseAttemptDispatchInput): ReadonlyArray<readonly [string, string, boolean | undefined]> {
  return buildPhaseAttemptRequest(input).outputs.map((output) => [
    output.portId,
    output.target,
    output.overwriteConfirmed
  ]);
}

describe('launchContextOf', () => {
  it('is absent when the launch attached nothing, so the record keeps its old shape', () => {
    expect(launchContextOf({ supplemental: [], outputs: [] })).toBeUndefined();
  });

  it('keeps whichever part was attached', () => {
    expect(launchContextOf({ supplemental: [], outputs: [], instructions: 'Go' })).toEqual({
      supplemental: [],
      outputs: [],
      instructions: 'Go'
    });
    expect(launchContextOf({ supplemental: [], outputs: [target('plan', 'p.md')] })).toEqual({
      supplemental: [],
      outputs: [target('plan', 'p.md')]
    });
  });
});

describe('a run keeps its launch context frozen', () => {
  it('is frozen by the snapshot and refused by the invariants when it is not', () => {
    const { run } = openRun(CONTEXT);
    expect(Object.isFrozen(run.launchContext)).toBe(true);
    expect(() => {
      assertConnectedRunInvariants({ ...run, launchContext: { ...CONTEXT } });
    }).toThrow(ConnectedRunInvariantError);
  });

  it('survives each write a run goes through', () => {
    const fixture = openRun(CONTEXT);
    const { run } = withAttempt(fixture.run, fixture.root, 'first');
    expect(run.launchContext).toEqual(CONTEXT);
  });
});

describe('buildPhaseAttemptRequest: what every Phase is given', () => {
  it('gives each Phase the instructions and the launch supplemental', () => {
    const fixture = openRun(CONTEXT);
    const request = buildPhaseAttemptRequest(dispatchInput(fixture, fixture.root, 'fallback'));
    expect(request.instructions).toBe('Keep it small');
    expect(request.supplemental).toEqual([{ kind: 'text', text: 'Style guide' }]);
  });

  it('lets a node\'s own local inputs replace the launch supplemental, and keeps the instructions', () => {
    const fixture = openRun(CONTEXT);
    const own = envelope(fixture.root, 'first', [], [{ kind: 'text', value: 'Only this' }]);
    const request = buildPhaseAttemptRequest(dispatchInput(fixture, fixture.root, 'first', own));
    expect(request.supplemental).toEqual([{ kind: 'text', text: 'Only this' }]);
    expect(request.instructions).toBe('Keep it small');
  });

  it('builds a run recorded before the field with what it always had', () => {
    const fixture = openRun();
    const override = target('plan-key', 'out/own.md');
    const own = envelope(fixture.root, 'first', [override], [{ kind: 'text', value: 'Local' }]);

    const request = buildPhaseAttemptRequest(dispatchInput(fixture, fixture.root, 'first', own));

    expect(request).toEqual({
      pipelineId: 'one',
      inputs: [],
      supplemental: [{ kind: 'text', text: 'Local' }],
      outputs: [override]
    });
    const bare = buildPhaseAttemptRequest(dispatchInput(fixture, fixture.root, 'first'));
    expect(bare.supplemental).toEqual([]);
    expect(bare.outputs).toEqual([]);
    expect(Object.keys(bare)).not.toContain('instructions');
  });
});

describe('buildPhaseAttemptRequest: where a target goes', () => {
  it('reads the key the binding reads, sourcePortId before outputKey before the port', () => {
    const fixture = openRun(CONTEXT);
    expect(outputsOf(dispatchInput(fixture, fixture.root, 'first'))).toEqual([
      ['plan-key', 'out/plan.md', false]
    ]);
    expect(outputsOf(dispatchInput(fixture, fixture.root, 'fallback'))).toEqual([
      ['fallback-source', 'out/plan.md', false]
    ]);
  });

  it('tells a node nothing about a port bound to another node', () => {
    const fixture = openRun(CONTEXT);
    const told = outputsOf(dispatchInput(fixture, fixture.root, 'first')).map(([, path]) => path);
    expect(told).not.toContain('out/report.md');
  });

  it('tells the first target when two ports read one key on one node', () => {
    const fixture = openRun(CONTEXT);
    const told = outputsOf(dispatchInput(fixture, fixture.root, 'first')).map(([, path]) => path);
    expect(told).toEqual(['out/plan.md']);
  });

  it('routes a root target down through every call, re-keyed at each level', () => {
    const opened = openRun(CONTEXT);
    const first = enterChild(opened.run, opened.root, 'call', CHILD);
    const second = enterChild(first.run, first.child, 'inner-call', GRANDCHILD);

    expect(outputsOf(dispatchInput({ run: second.run }, second.child, 'deep'))).toEqual([
      ['deep-key', 'out/report.md', false]
    ]);
  });

  it('lets an override win by port, and adds a port no binding reaches', () => {
    const fixture = openRun(CONTEXT);
    const own = envelope(fixture.root, 'first', [
      target('plan-key', 'out/override.md'),
      target('extra', 'out/extra.md')
    ]);
    expect(outputsOf(dispatchInput(fixture, fixture.root, 'first', own))).toEqual([
      ['plan-key', 'out/override.md', false],
      ['extra', 'out/extra.md', false]
    ]);
  });

  it('tells nothing when a corrupt parent chain loops, and does not hang', () => {
    const fixture = openRun(CONTEXT);
    const childA = createChildWorkflowInvocationFrame({
      parentFrame: fixture.root,
      callNodeId: 'call',
      parentAttemptId: 'a1',
      childWorkflow: CHILD,
      boundInputs: {},
      startedAt: 1600
    });
    const childB = createChildWorkflowInvocationFrame({
      parentFrame: childA,
      callNodeId: 'inner-call',
      parentAttemptId: 'a2',
      childWorkflow: GRANDCHILD,
      boundInputs: {},
      startedAt: 1700
    });
    const looped = { ...childA, parentInvocationId: childB.invocationId, parentCallNodeId: 'inner-call' };
    const run = upsertInvocationFrame(upsertInvocationFrame(fixture.run, looped), childB);

    expect(outputsOf(dispatchInput({ run }, childB, 'deep'))).toEqual([]);
  });

  it('tells nothing when a parent frame is missing', () => {
    const fixture = openRun(CONTEXT);
    const orphan = { ...fixture.root, invocationId: 'orphan', parentInvocationId: 'gone', parentCallNodeId: 'call' };
    expect(outputsOf(dispatchInput(fixture, orphan, 'first'))).toEqual([]);
  });
});

describe('buildPhaseAttemptRequest: consent to overwrite', () => {
  it('keeps the launch value on a first attempt', () => {
    const fixture = openRun(CONTEXT);
    expect(outputsOf(dispatchInput(fixture, fixture.root, 'first'))).toEqual([
      ['plan-key', 'out/plan.md', false]
    ]);

    const confirmed = openRun({ ...CONTEXT, outputs: [target('plan', 'out/plan.md', true)] });
    expect(outputsOf(dispatchInput(confirmed, confirmed.root, 'first'))).toEqual([
      ['plan-key', 'out/plan.md', true]
    ]);
  });

  it('confirms what an earlier attempt of the same node was told', () => {
    const fixture = openRun(CONTEXT);
    const { run, frame } = withAttempt(fixture.run, fixture.root, 'first');
    expect(outputsOf(dispatchInput({ run }, frame, 'first'))).toEqual([
      ['plan-key', 'out/plan.md', true]
    ]);
  });

  it('confirms what another node bound to the same port was told', () => {
    const fixture = openRun(CONTEXT);
    const { run, frame } = withAttempt(fixture.run, fixture.root, 'first');
    expect(outputsOf(dispatchInput({ run }, frame, 'fallback'))).toEqual([
      ['fallback-source', 'out/plan.md', true]
    ]);
  });

  it('does not confirm a target no Phase was told', () => {
    const fixture = openRun(CONTEXT);
    const entered = enterChild(fixture.run, fixture.root, 'call', CHILD);
    const deeper = enterChild(entered.run, entered.child, 'inner-call', GRANDCHILD);
    const { run } = withAttempt(deeper.run, entered.parent, 'first');
    // Only `first` wrote anything, and it was told out/plan.md.
    expect(outputsOf(dispatchInput({ run }, deeper.child, 'deep'))).toEqual([
      ['deep-key', 'out/report.md', false]
    ]);
  });

  it('does not count a call node attempt, which writes nothing and is recorded first', () => {
    const fixture = openRun(CONTEXT);
    const entered = enterChild(fixture.run, fixture.root, 'call', CHILD);
    const deeper = enterChild(entered.run, entered.child, 'inner-call', GRANDCHILD);
    expect(outputsOf(dispatchInput({ run: deeper.run }, deeper.child, 'deep'))).toEqual([
      ['deep-key', 'out/report.md', false]
    ]);
  });

  it('confirms what a retried child\'s earlier frame was told', () => {
    const fixture = openRun(CONTEXT);
    const entered = enterChild(fixture.run, fixture.root, 'call', CHILD);
    const deeper = enterChild(entered.run, entered.child, 'inner-call', GRANDCHILD);
    const failed = withAttempt(deeper.run, deeper.child, 'deep');

    // The retry calls the node again: a new frame, whose attempt numbering starts over.
    const retried = enterChild(failed.run, entered.parent, 'call', CHILD);
    const retriedDeep = enterChild(retried.run, retried.child, 'inner-call', GRANDCHILD);

    expect(retriedDeep.child.invocationId).not.toBe(deeper.child.invocationId);
    expect(outputsOf(dispatchInput({ run: retriedDeep.run }, retriedDeep.child, 'deep'))).toEqual([
      ['deep-key', 'out/report.md', true]
    ]);
  });

  it('confirms an override reused by a re-attempt, not the same override the first time', () => {
    const fixture = openRun();
    const own = envelope(fixture.root, 'first', [target('plan-key', 'out/own.md')]);
    expect(outputsOf(dispatchInput(fixture, fixture.root, 'first', own))).toEqual([
      ['plan-key', 'out/own.md', false]
    ]);

    const { run, frame } = withAttempt(fixture.run, fixture.root, 'first', 'phase', own);
    expect(outputsOf(dispatchInput({ run }, frame, 'first', own))).toEqual([
      ['plan-key', 'out/own.md', true]
    ]);
  });
});

describe('phaseDispatchResultOf', () => {
  it('reads an enqueued start as dispatched', () => {
    const started = { outcome: 'enqueued', queueItemId: 'item-1' } as unknown as NodeRunStartResult;
    expect(phaseDispatchResultOf(started)).toEqual({ outcome: 'dispatched', queueItemId: 'item-1' });
  });

  it('names each refused validation code once, and nothing else from the error', () => {
    const started: NodeRunStartResult = {
      outcome: 'rejected-validation',
      errors: [
        { field: 'outputs.a', code: 'output-overwrite-unconfirmed', message: 'secret/path/a.md' },
        { field: 'outputs.b', code: 'output-overwrite-unconfirmed', message: 'secret/path/b.md' },
        { field: 'inputs.c', code: 'missing-required-input', message: 'secret/path/c.md' }
      ]
    };
    expect(phaseDispatchResultOf(started)).toEqual({
      outcome: 'rejected',
      reason: 'rejected-validation',
      detail: 'output-overwrite-unconfirmed, missing-required-input'
    });
  });

  it('carries no detail on any other refusal', () => {
    const started: NodeRunStartResult = { outcome: 'rejected-queue', reason: 'queue-refused', detail: 'paused' };
    expect(phaseDispatchResultOf(started)).toEqual({ outcome: 'rejected', reason: 'rejected-queue' });
  });
});

describe('startPhaseAttempt: a next node is not a new admission', () => {
  async function admissionOf(options?: { readonly continuesWorkflow?: true }) {
    const scheduleOrEnqueue = vi.fn(() =>
      Promise.resolve({
        outcome: 'enqueued' as const,
        queueItemId: 'row-1',
        lifecycleAfter: 'active-empty' as const
      })
    );
    const deps = {
      guardedRun: { scheduleOrEnqueue },
      logger: { warn: vi.fn(), sanitize: (text: string) => text }
    } as unknown as NodeRunStartDeps;
    const fixture = openRun();
    const started = await startPhaseAttempt(
      deps,
      dispatchInput(fixture, fixture.root, 'first'),
      '/workspace',
      options
    );
    expect(started.outcome).toBe('enqueued');
    const calls = scheduleOrEnqueue.mock.calls as unknown as GuardedScheduleRequest[][];
    const request = calls.at(0)?.at(0);
    if (request === undefined) throw new Error('expected one admission');
    return request;
  }

  it('tells admission when the caller says this continues a Workflow', async () => {
    const request = await admissionOf({ continuesWorkflow: true });

    expect(request.continuesWorkflow).toBe(true);
  });

  it('claims nothing otherwise, so a launch waits for its Start', async () => {
    const request = await admissionOf();

    expect('continuesWorkflow' in request).toBe(false);
  });
});

describe('startPhaseAttempt', () => {
  it('refuses a run with no frozen closure, and starts nothing', async () => {
    const fixture = openRun(CONTEXT);
    const { frozenClosure: _closure, ...withoutClosure } = fixture.run;
    const started = await startPhaseAttempt(
      { logger: { warn: () => undefined, sanitize: (text) => text } },
      dispatchInput({ run: withoutClosure }, fixture.root, 'first'),
      '/tmp/ws'
    );
    expect(started).toEqual({ outcome: 'rejected-definition', reason: 'pipeline-not-found' });
  });
});
