import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Memento } from '../../src/state/workspace-state';
import type { ExecutionFence } from '../../src/contracts/control-ledger';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import type { ForEachControl } from '../../src/contracts/workflow-controls';
import {
  ForEachExecutor,
  buildForEachFrameKey,
  prepareForEachItemFrames
} from '../../src/services/workflow-execution/foreach-executor';
import {
  ControlLedgerStore,
  lookupRecord
} from '../../src/services/workflow-execution/control-ledger-store';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode
} from '../../src/services/workflow-execution/connected-run-coordinator';
import {
  createComposableWorkflowRunSnapshot
} from '../../src/services/workflow-execution/connected-run-factory';
import {
  WorkflowRecoveryService,
  type WorkflowRecoveryStore
} from '../../src/services/workflow-execution/workflow-recovery-service';
import {
  buildForEachNodeProjection
} from '../../src/services/workflow-execution/workflow-control-projector';
import {
  recordNodeAttempt,
  upsertInvocationFrame,
  type ConnectedWorkflowRun
} from '../../src/state/connected-workflow-run';

function makeMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return map.has(key) ? (map.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, structuredClone(value));
    }
  };
}

function makeFence(rootGeneration = 1): ExecutionFence {
  return {
    primacyClaim: 'primacy-fe-rec-1',
    queueClaim: 'queue-fe-rec-1',
    rootGeneration
  };
}

const CHILD_WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-child-item',
  name: 'Child Item Workflow',
  version: 1,
  inputs: [{ portId: 'itemPayload', label: 'Item Payload', type: 'text', required: true }],
  outputs: [{ portId: 'outSummary', label: 'Out Summary', type: 'markdown', required: false }],
  nodes: [{ nodeId: 'phase-item-1', kind: 'phase', phaseId: 'phase-process-item' }],
  connections: [],
  startNodeIds: ['phase-item-1']
};

const CHILD_CANDIDATE_WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-child-candidate',
  name: 'Child Candidate Workflow',
  version: 1,
  inputs: [{ portId: 'itemPayload', label: 'Item Payload', type: 'text', required: true }],
  outputs: [],
  nodes: [
    { nodeId: 'node-cand-1', kind: 'phase', phaseId: 'phase-cand-1' },
    { nodeId: 'node-cand-2', kind: 'phase', phaseId: 'phase-cand-2' }
  ],
  connections: [
    {
      from: { nodeId: 'node-cand-1' },
      to: { kind: 'node', nodeId: 'node-cand-2' },
      priority: 1,
      handoff: 'auto',
      condition: {
        left: { source: 'node-status', nodeId: 'node-cand-1' },
        operator: 'equals',
        right: 'failed'
      }
    },
    {
      from: { nodeId: 'node-cand-1' },
      to: { kind: 'return', nodeId: 'node-cand-1' },
      priority: 2,
      handoff: 'auto'
    }
  ],
  startNodeIds: ['node-cand-1'],
  control: {
    version: 1,
    kind: 'candidate-block',
    candidates: [
      { candidateId: 'cand-primary', nodeId: 'node-cand-1', priority: 1 },
      { candidateId: 'cand-fallback', nodeId: 'node-cand-2', priority: 2 }
    ]
  }
};

function makeForEachControl(
  overrides: {
    readonly collection?: ForEachControl['collection'] | undefined;
    readonly itemKeyField?: string | undefined;
    readonly itemInputPortId?: string | undefined;
    readonly maxItems?: number | undefined;
    readonly onItemError?: ForEachControl['onItemError'] | undefined;
  } = {}
): ForEachControl {
  const itemKeyField = 'itemKeyField' in overrides ? overrides.itemKeyField : 'id';
  const maxItems = 'maxItems' in overrides ? overrides.maxItems : 50;
  return Object.freeze({
    version: 1 as const,
    kind: 'for-each' as const,
    collection:
      overrides.collection ?? {
        source: 'workflow-input' as const,
        portId: 'itemsFile'
      },
    ...(itemKeyField !== undefined ? { itemKeyField } : {}),
    itemInputPortId: overrides.itemInputPortId ?? 'itemPayload',
    ...(maxItems !== undefined ? { maxItems } : {}),
    onItemError: overrides.onItemError ?? 'continue'
  });
}

function makeParentWorkflow(
  childWorkflowId = CHILD_WORKFLOW.workflowId,
  control: ForEachControl = makeForEachControl()
): WorkflowDefinition {
  return {
    workflowId: 'wf-parent-foreach',
    name: 'Parent ForEach Workflow',
    version: 1,
    inputs: [{ portId: 'itemsFile', label: 'Items File', type: 'local-file', required: true }],
    outputs: [{ portId: 'batchIndex', label: 'Batch Index', type: 'structured-data', required: false }],
    bindings: [
      {
        kind: 'output',
        portId: 'batchIndex',
        nodeId: 'node-foreach-1',
        outputKey: 'resultIndex',
        type: 'structured-data'
      }
    ],
    nodes: [
      {
        nodeId: 'node-foreach-1',
        kind: 'workflow',
        workflowId: childWorkflowId,
        control
      }
    ],
    connections: [],
    startNodeIds: ['node-foreach-1']
  };
}

function makeRecoveryHarness(
  initialPayload: string,
  childWf: WorkflowDefinition = CHILD_WORKFLOW,
  control: ForEachControl = makeForEachControl()
) {
  let wallMs = 1_700_000_000_000;
  let monoMs = 1_000;
  const clock = {
    nowWallMs: () => wallMs,
    nowMonotonicMs: () => monoMs,
    advance(ms: number) {
      wallMs += ms;
      monoMs += ms;
    }
  };
  const ledgerStore = new ControlLedgerStore(makeMemoryMemento());
  const executor = new ForEachExecutor({ ledgerStore, clock });
  const rootRunId = 'root-fe-rec-1';
  const parentWf = makeParentWorkflow(childWf.workflowId, control);

  const created = createComposableWorkflowRunSnapshot({
    connectedRunId: rootRunId,
    queueId: 'default',
    workflow: parentWf,
    effectiveWorkflows: [parentWf, childWf],
    effectivePhases: [
      {
        phaseId: 'phase-process-item',
        name: 'Process Item',
        version: 1,
        runner: 'claude',
        instruction: 'Process item'
      },
      {
        phaseId: 'phase-cand-1',
        name: 'Primary Candidate',
        version: 1,
        runner: 'claude',
        instruction: 'Primary candidate'
      },
      {
        phaseId: 'phase-cand-2',
        name: 'Fallback Candidate',
        version: 1,
        runner: 'codex',
        instruction: 'Fallback candidate'
      }
    ],
    boundInputs: {
      itemsFile: {
        portId: 'itemsFile',
        type: 'local-file',
        value: initialPayload
      }
    },
    startedAt: wallMs
  });
  if (created.outcome !== 'created') throw new Error(created.detail);

  let storedRun: ConnectedWorkflowRun = created.run;

  const store: WorkflowRecoveryStore = {
    get(id) {
      return id === storedRun.connectedRunId ? storedRun : null;
    },
    list() {
      return [storedRun];
    },
    async compareAndSetConnectedRun(next) {
      storedRun = { ...next, revision: storedRun.revision + 1 };
      return { outcome: 'written', run: storedRun };
    }
  };

  const seedRoot = async () => {
    await ledgerStore.mutate({}, ({ ledger }) => ({
      commit: true,
      plan: {
        result: undefined,
        nextLedger: {
          ...ledger,
          roots: {
            ...ledger.roots,
            [rootRunId]: {
              version: 1,
              ledgerRunId: rootRunId,
              connectedRunId: storedRun.connectedRunId,
              rootWorkflowId: parentWf.workflowId,
              rootInvocationId: created.rootInvocationId,
              queueId: 'default',
              linkState: 'active',
              status: 'in-flight',
              fence: makeFence(1),
              createdAt: wallMs,
              updatedAt: wallMs,
              dispatchedAttempts: 0,
              reservedAttempts: 0,
              settledMicrousd: 0,
              reservedMicrousd: 0,
              unpricedAttemptCount: 0,
              rootBudget: {
                version: 1,
                maxPhaseAttempts: 100,
                budgetMode: 'count-only'
              },
              framesByKey: {},
              attemptsById: {},
              notificationsById: {},
              decisionSummaries: []
            }
          }
        }
      }
    }));
  };

  return {
    clock,
    ledgerStore,
    executor,
    rootRunId,
    parentWf,
    rootInvocationId: created.rootInvocationId,
    store,
    getRun: () => storedRun,
    setRun: (next: ConnectedWorkflowRun) => {
      storedRun = next;
    },
    seedRoot
  };
}

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

describe('FR-R5-F34 — ForEach nested CandidateBlock & crash recovery across all slot boundaries (F34-T04, F34-T05)', () => {
  it('executes ForEach over a child CandidateBlock workflow where item 0 recovers on fallback, item 1 fails under continue, and item 2 succeeds', async () => {
    const payload = JSON.stringify({
      version: 1,
      items: [{ id: 'item-0' }, { id: 'item-1' }, { id: 'item-2' }]
    });
    const h = makeRecoveryHarness(
      payload,
      CHILD_CANDIDATE_WORKFLOW,
      makeForEachControl({ onItemError: 'continue' })
    );
    await h.seedRoot();

    const dispatched: Array<{ invocationId: string; nodeId: string; itemPayload: string }> = [];
    const coordinatorDeps = {
      connectedRuns: h.store,
      dispatchPhase: async (inp: {
        readonly frame: { readonly invocationId: string; readonly boundInputs: Record<string, { readonly value: string }> };
        readonly node: { readonly nodeId: string };
        readonly attemptId: string;
      }) => {
        dispatched.push({
          invocationId: inp.frame.invocationId,
          nodeId: inp.node.nodeId,
          itemPayload: lookupRecord(inp.frame.boundInputs, 'itemPayload')?.value ?? ''
        });
        return { outcome: 'dispatched' as const, queueItemId: `q-${inp.attemptId}` };
      },
      forEachExecutor: h.executor
    };

    // Start ForEach -> dispatches item 0 primary candidate (node-cand-1)
    const step0a = await dispatchComposableNode(coordinatorDeps, {
      run: h.getRun(),
      invocationId: h.rootInvocationId,
      nodeId: 'node-foreach-1',
      startedAt: 1_000
    });
    expect(step0a.outcome).toBe('phase-dispatched');
    if (step0a.outcome !== 'phase-dispatched') return;
    expect(step0a.nodeId).toBe('node-cand-1');

    // Item 0 primary candidate fails -> routes to fallback candidate (node-cand-2) inside item 0's child workflow
    const step0b = await completeComposableNodeAttempt(coordinatorDeps, {
      run: h.getRun(),
      invocationId: step0a.invocationId,
      nodeId: 'node-cand-1',
      status: 'failed',
      completedAt: 1_500
    });
    expect(step0b.outcome).toBe('phase-dispatched');
    if (step0b.outcome !== 'phase-dispatched') return;
    expect(step0b.nodeId).toBe('node-cand-2');

    // Item 0 fallback candidate succeeds -> item 0 completes and ForEach advances to item 1
    const step1 = await completeComposableNodeAttempt(coordinatorDeps, {
      run: h.getRun(),
      invocationId: step0b.invocationId,
      nodeId: 'node-cand-2',
      status: 'completed',
      completedAt: 2_000
    });
    expect(step1.outcome).toBe('phase-dispatched');
    if (step1.outcome !== 'phase-dispatched') return;
    expect(JSON.parse(dispatched.at(-1)?.itemPayload ?? '{}')).toEqual({ id: 'item-1' });

    // Item 1 fails both primary and fallback candidates -> under onItemError: 'continue', ForEach records failed slot 1 and advances to item 2!
    const step1b = await completeComposableNodeAttempt(coordinatorDeps, {
      run: h.getRun(),
      invocationId: step1.invocationId,
      nodeId: 'node-cand-1',
      status: 'failed',
      completedAt: 2_500
    });
    expect(step1b.outcome).toBe('phase-dispatched');
    if (step1b.outcome !== 'phase-dispatched') return;
    const step2 = await completeComposableNodeAttempt(coordinatorDeps, {
      run: h.getRun(),
      invocationId: step1b.invocationId,
      nodeId: 'node-cand-2',
      status: 'failed',
      failureCode: 'all-candidates-exhausted',
      completedAt: 3_000
    });
    expect(step2.outcome).toBe('phase-dispatched');
    if (step2.outcome !== 'phase-dispatched') return;
    expect(JSON.parse(dispatched.at(-1)?.itemPayload ?? '{}')).toEqual({ id: 'item-2' });

    // Item 2 primary candidate succeeds -> ForEach completes with hasErrors: true, errorCount: 1, leafAttemptCount: 5
    const done = await completeComposableNodeAttempt(coordinatorDeps, {
      run: h.getRun(),
      invocationId: step2.invocationId,
      nodeId: 'node-cand-1',
      status: 'completed',
      completedAt: 3_500
    });
    expect(done.outcome).toBe('workflow-completed');
    if (done.outcome === 'workflow-completed') {
      const idx = JSON.parse(lookupRecord(done.outputs, 'batchIndex')?.value ?? '{}');
      expect(idx.itemCount).toBe(3);
      expect(idx.hasErrors).toBe(true);
      expect(idx.errorCount).toBe(1);
      expect(idx.slots.map((s: { itemKey: string; state: string }) => ({
        itemKey: s.itemKey,
        state: s.state
      }))).toEqual([
        { itemKey: 'item-0', state: 'completed' },
        { itemKey: 'item-1', state: 'failed' },
        { itemKey: 'item-2', state: 'completed' }
      ]);
    }

    const loaded = h.ledgerStore.read();
    const rootState = loaded.ok ? lookupRecord(loaded.ledger.roots, h.rootRunId) : undefined;
    const proj = buildForEachNodeProjection(h.getRun(), 'node-foreach-1', rootState);
    expect(proj?.itemCount).toBe(3);
    expect(proj?.leafAttemptCount).toBe(5);
    expect(proj?.hasErrors).toBe(true);
    expect(proj?.errorCount).toBe(1);
  });

  it('recovers interrupted ForEach runs across after-collection-freeze, after-child-admission, after-child-settlement, after-slot-commit, after-item-advance, and before-final-export without replaying settled slots', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'schegent-fe-rec-'));
    tempDirs.push(wsDir);
    const relPath = 'items.json';
    await fsp.writeFile(
      path.join(wsDir, relPath),
      JSON.stringify({ version: 1, items: [{ id: 's0' }, { id: 's1' }] }),
      'utf8'
    );

    // 1. Crash at after-collection-freeze (ledger frozen at currentIndex=0, before run created item 0 frame; file then mutated on disk)
    const hFreeze = makeRecoveryHarness(relPath);
    await hFreeze.seedRoot();
    await hFreeze.executor.initializeForEachFrame({
      rootRunId: hFreeze.rootRunId,
      parentInvocationId: hFreeze.rootInvocationId,
      parentWorkflowId: hFreeze.parentWf.workflowId,
      nodeId: 'node-foreach-1',
      control: makeForEachControl(),
      collectionReaderInput: { relativeFilePath: relPath },
      workspaceRoot: wsDir
    });
    // Mutate file on disk before recovery!
    await fsp.writeFile(
      path.join(wsDir, relPath),
      JSON.stringify({ version: 1, items: [{ id: 'tampered' }] }),
      'utf8'
    );
    const dispatchedFreeze: string[] = [];
    const recServiceFreeze = new WorkflowRecoveryService({
      connectedRuns: hFreeze.store,
      dispatchPhase: async (inp) => {
        dispatchedFreeze.push(lookupRecord(inp.frame.boundInputs, 'itemPayload')?.value ?? '');
        return { outcome: 'dispatched', queueItemId: `q-${inp.attemptId}` };
      },
      forEachExecutor: hFreeze.executor,
      workspaceRoot: wsDir
    });
    const recFreeze = await recServiceFreeze.reconcileRun(hFreeze.getRun().connectedRunId, 2_000);
    expect(recFreeze?.mutated).toBe(true);
    expect(recFreeze?.disposition?.reasonCode).toBe('foreach-slot-advance-recovered');
    expect(JSON.parse(dispatchedFreeze[0] ?? '{}')).toEqual({ id: 's0' });

    // 2. Crash at after-child-admission (childFrame for item 0 created on run, 0 phase attempts)
    const hAdmit = makeRecoveryHarness(
      JSON.stringify({ version: 1, items: [{ id: 's0' }, { id: 's1' }] })
    );
    await hAdmit.seedRoot();
    const prep0 = prepareForEachItemFrames({
      run: hAdmit.getRun(),
      parentFrame: hAdmit.getRun().invocations![hAdmit.rootInvocationId]!,
      node: hAdmit.parentWf.nodes[0]!,
      childWorkflow: CHILD_WORKFLOW,
      itemIndex: 0,
      itemInputPortId: 'itemPayload',
      itemCanonicalJson: '{"id":"s0"}',
      baseInputsByPort: hAdmit.getRun().invocations![hAdmit.rootInvocationId]!.boundInputs,
      startedAt: 1_000
    })!;
    hAdmit.setRun(prep0.nextRun);
    await hAdmit.executor.initializeForEachFrame({
      rootRunId: hAdmit.rootRunId,
      parentInvocationId: hAdmit.rootInvocationId,
      parentWorkflowId: hAdmit.parentWf.workflowId,
      nodeId: 'node-foreach-1',
      control: makeForEachControl(),
      collectionReaderInput: {
        rawCollectionText: JSON.stringify({ version: 1, items: [{ id: 's0' }, { id: 's1' }] })
      },
      firstChildInvocationId: prep0.childFrame.invocationId
    });
    const dispatchedAdmit: string[] = [];
    const recServiceAdmit = new WorkflowRecoveryService({
      connectedRuns: hAdmit.store,
      dispatchPhase: async (inp) => {
        dispatchedAdmit.push(inp.frame.invocationId);
        return { outcome: 'dispatched', queueItemId: `q-${inp.attemptId}` };
      },
      forEachExecutor: hAdmit.executor
    });
    const recAdmit = await recServiceAdmit.reconcileRun(hAdmit.getRun().connectedRunId, 2_000);
    expect(recAdmit?.mutated).toBe(true);
    expect(recAdmit?.disposition?.reasonCode).toBe('foreach-child-admission-recovered');
    expect(dispatchedAdmit).toEqual([prep0.childFrame.invocationId]);

    // 3. Crash at after-child-settlement / after-slot-commit (item 0 childFrame is 'completed' on run, parent ForEach has not yet advanced to item 1)
    const hSettle = makeRecoveryHarness(
      JSON.stringify({ version: 1, items: [{ id: 's0' }, { id: 's1' }] })
    );
    await hSettle.seedRoot();
    const dispatchedSettle: string[] = [];
    const d0 = await dispatchComposableNode(
      {
        connectedRuns: hSettle.store,
        dispatchPhase: async (inp) => {
          dispatchedSettle.push(lookupRecord(inp.frame.boundInputs, 'itemPayload')?.value ?? '');
          return { outcome: 'dispatched', queueItemId: `q-${inp.attemptId}` };
        },
        forEachExecutor: hSettle.executor
      },
      {
        run: hSettle.getRun(),
        invocationId: hSettle.rootInvocationId,
        nodeId: 'node-foreach-1',
        startedAt: 1_000
      }
    );
    expect(d0.outcome).toBe('phase-dispatched');
    if (d0.outcome !== 'phase-dispatched') return;
    // Simulate crash right after child frame was marked completed, before ForEach settled slot 0
    const childF = hSettle.getRun().invocations![d0.invocationId]!;
    const childAtt = childF.attemptsByNodeId['phase-item-1']![0]!;
    const completedChildF = {
      ...recordNodeAttempt(childF, { ...childAtt, status: 'completed', completedAt: 1_500 }),
      activeNodeId: null,
      status: 'completed' as const,
      completedAt: 1_500
    };
    hSettle.setRun(upsertInvocationFrame(hSettle.getRun(), completedChildF));

    const recServiceSettle = new WorkflowRecoveryService({
      connectedRuns: hSettle.store,
      dispatchPhase: async (inp) => {
        dispatchedSettle.push(lookupRecord(inp.frame.boundInputs, 'itemPayload')?.value ?? '');
        return { outcome: 'dispatched', queueItemId: `q-${inp.attemptId}` };
      },
      forEachExecutor: hSettle.executor
    });
    const recSettle = await recServiceSettle.reconcileRun(hSettle.getRun().connectedRunId, 2_000);
    expect(recSettle?.mutated).toBe(true);
    expect(recSettle?.disposition?.reasonCode).toBe('foreach-post-item-reconciled');
    // Verify slot 0 was NOT replayed and item 1 ('s1') was dispatched!
    expect(dispatchedSettle.map((raw) => JSON.parse(raw))).toEqual([{ id: 's0' }, { id: 's1' }]);

    // 4. Crash at after-item-advance (ledger already advanced currentIndex to 1 after slot 0 failed under continue, before run created item 1 frame)
    const hAdv = makeRecoveryHarness(
      JSON.stringify({ version: 1, items: [{ id: 's0' }, { id: 's1' }] })
    );
    await hAdv.seedRoot();
    const dAdv0 = await dispatchComposableNode(
      {
        connectedRuns: hAdv.store,
        dispatchPhase: async (inp) => ({ outcome: 'dispatched', queueItemId: `q-${inp.attemptId}` }),
        forEachExecutor: hAdv.executor
      },
      {
        run: hAdv.getRun(),
        invocationId: hAdv.rootInvocationId,
        nodeId: 'node-foreach-1',
        startedAt: 1_000
      }
    );
    expect(dAdv0.outcome).toBe('phase-dispatched');
    if (dAdv0.outcome !== 'phase-dispatched') return;
    // Settle slot 0 as failed (under continue) in ledger so currentIndex becomes 1
    await hAdv.executor.settleForEachItem({
      rootRunId: hAdv.rootRunId,
      parentInvocationId: hAdv.rootInvocationId,
      nodeId: 'node-foreach-1',
      itemIndex: 0,
      childInvocationId: dAdv0.invocationId,
      childStatus: 'failed',
      childFailureCode: 'child-failed',
      nextChildInvocationId: 'child-inv-1'
    });
    // Mark child 0 failed on run so leaf attempt finder does not pause it
    const childAdv0 = hAdv.getRun().invocations![dAdv0.invocationId]!;
    const attAdv0 = childAdv0.attemptsByNodeId['phase-item-1']![0]!;
    hAdv.setRun(
      upsertInvocationFrame(hAdv.getRun(), {
        ...recordNodeAttempt(childAdv0, { ...attAdv0, status: 'failed', completedAt: 1_500 }),
        activeNodeId: null,
        status: 'failed',
        completedAt: 1_500
      })
    );
    const dispatchedAdv: string[] = [];
    const recServiceAdv = new WorkflowRecoveryService({
      connectedRuns: hAdv.store,
      dispatchPhase: async (inp) => {
        dispatchedAdv.push(lookupRecord(inp.frame.boundInputs, 'itemPayload')?.value ?? '');
        return { outcome: 'dispatched', queueItemId: `q-${inp.attemptId}` };
      },
      forEachExecutor: hAdv.executor
    });
    const recAdv = await recServiceAdv.reconcileRun(hAdv.getRun().connectedRunId, 2_000);
    expect(recAdv?.mutated).toBe(true);
    expect(recAdv?.disposition?.reasonCode).toBe('foreach-slot-advance-recovered');
    // Only s1 was dispatched; failed slot 0 was NOT replayed!
    expect(dispatchedAdv.map((raw) => JSON.parse(raw))).toEqual([{ id: 's1' }]);

    // 5. Crash at before-final-export (single-item ForEach where child 0 completed on run before final export)
    const hFinal = makeRecoveryHarness(
      JSON.stringify({ version: 1, items: [{ id: 'only-item' }] })
    );
    await hFinal.seedRoot();
    const dFinal0 = await dispatchComposableNode(
      {
        connectedRuns: hFinal.store,
        dispatchPhase: async (inp) => ({ outcome: 'dispatched', queueItemId: `q-${inp.attemptId}` }),
        forEachExecutor: hFinal.executor
      },
      {
        run: hFinal.getRun(),
        invocationId: hFinal.rootInvocationId,
        nodeId: 'node-foreach-1',
        startedAt: 1_000
      }
    );
    expect(dFinal0.outcome).toBe('phase-dispatched');
    if (dFinal0.outcome !== 'phase-dispatched') return;
    const childFin0 = hFinal.getRun().invocations![dFinal0.invocationId]!;
    const attFin0 = childFin0.attemptsByNodeId['phase-item-1']![0]!;
    hFinal.setRun(
      upsertInvocationFrame(hFinal.getRun(), {
        ...recordNodeAttempt(childFin0, { ...attFin0, status: 'completed', completedAt: 1_500 }),
        activeNodeId: null,
        status: 'completed',
        completedAt: 1_500
      })
    );
    const recServiceFin = new WorkflowRecoveryService({
      connectedRuns: hFinal.store,
      dispatchPhase: async (inp) => ({ outcome: 'dispatched', queueItemId: `q-${inp.attemptId}` }),
      forEachExecutor: hFinal.executor
    });
    const recFin = await recServiceFin.reconcileRun(hFinal.getRun().connectedRunId, 2_000);
    expect(recFin?.mutated).toBe(true);
    expect(recFin?.run.invocations?.[hFinal.rootInvocationId]?.status).toBe('completed');
    const finalFrameKey = buildForEachFrameKey(hFinal.rootInvocationId, 'node-foreach-1');
    const finLoaded = hFinal.ledgerStore.read();
    const finRoot = finLoaded.ok ? lookupRecord(finLoaded.ledger.roots, hFinal.rootRunId) : undefined;
    expect(lookupRecord(finRoot?.framesByKey ?? {}, finalFrameKey)?.status).toBe('completed');
  });
});
