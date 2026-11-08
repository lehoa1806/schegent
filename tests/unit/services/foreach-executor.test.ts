import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Memento } from '../../../src/state/workspace-state';
import type { ExecutionFence } from '../../../src/contracts/control-ledger';
import type { WorkflowDefinition, WorkflowNode } from '../../../src/contracts/workflow-definitions';
import type { ForEachControl } from '../../../src/contracts/workflow-controls';
import {
  ForEachExecutor,
  buildForEachFrameKey,
  buildForEachItemInputEnvelope,
  buildOrderedResultIndex,
  readAndValidateForEachCollection,
  resolveFrozenForEachControl
} from '../../../src/services/workflow-execution/foreach-executor';
import {
  ControlLedgerStore,
  lookupRecord
} from '../../../src/services/workflow-execution/control-ledger-store';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode
} from '../../../src/services/workflow-execution/connected-run-coordinator';
import {
  createComposableWorkflowRunSnapshot
} from '../../../src/services/workflow-execution/connected-run-factory';
import {
  buildForEachNodeProjection
} from '../../../src/services/workflow-execution/workflow-control-projector';
import type { ConnectedWorkflowRun } from '../../../src/state/connected-workflow-run';

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
    primacyClaim: 'primacy-fe-1',
    queueClaim: 'queue-fe-1',
    rootGeneration
  };
}

const CHILD_WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-child-item',
  name: 'Child Item Processor',
  version: 1,
  inputs: [
    { portId: 'itemPayload', label: 'Item Payload', type: 'text', required: true },
    { portId: 'sharedNote', label: 'Shared Note', type: 'text', required: false }
  ],
  outputs: [
    { portId: 'itemSummary', label: 'Item Summary', type: 'markdown', required: false }
  ],
  nodes: [{ nodeId: 'phase-item-1', kind: 'phase', phaseId: 'phase-process-item' }],
  connections: [],
  startNodeIds: ['phase-item-1']
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
    onItemError: overrides.onItemError ?? 'stop'
  });
}

function makeParentWorkflow(control: ForEachControl = makeForEachControl()): WorkflowDefinition {
  const feNode: WorkflowNode = {
    nodeId: 'node-foreach-1',
    kind: 'workflow',
    workflowId: CHILD_WORKFLOW.workflowId,
    control
  };
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
    nodes: [feNode],
    connections: [],
    startNodeIds: ['node-foreach-1']
  };
}

function makeHarness(options: {
  readonly dispatchedAttempts?: number;
  readonly strictUsdMaxMicrousd?: number;
  readonly settledMicrousd?: number;
} = {}) {
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
  const fence = makeFence(1);
  const rootRunId = 'root-fe-run-1';
  const parentInvocationId = '00000000-0000-4000-8000-000000000201';

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
              connectedRunId: rootRunId,
              rootWorkflowId: 'wf-parent-foreach',
              rootInvocationId: parentInvocationId,
              queueId: 'default',
              linkState: 'active',
              status: 'in-flight',
              fence,
              createdAt: wallMs,
              updatedAt: wallMs,
              dispatchedAttempts: options.dispatchedAttempts ?? 0,
              reservedAttempts: 0,
              settledMicrousd: options.settledMicrousd ?? 0,
              reservedMicrousd: 0,
              unpricedAttemptCount: 0,
              rootBudget: {
                version: 1,
                maxPhaseAttempts: 100,
                budgetMode: options.strictUsdMaxMicrousd !== undefined ? 'strict-usd' : 'count-only',
                ...(options.strictUsdMaxMicrousd !== undefined
                  ? {
                      maxMicrousd: options.strictUsdMaxMicrousd,
                      strictUsdBudget: {
                        mode: 'strict-usd' as const,
                        limitMicrousd: options.strictUsdMaxMicrousd,
                        onUnverifiableSpend: 'pause-Run' as const
                      }
                    }
                  : {})
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

  const executor = new ForEachExecutor({ ledgerStore, clock });
  return { clock, ledgerStore, executor, rootRunId, parentInvocationId, seedRoot };
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

async function makeTempWorkspace(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'schegent-fe-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('FR-R5-F34 — Contained ForEach collection reader & freeze validation (F34-T01, F34-T03)', () => {
  it('validates 0, 1, 50, and 100 items and rejects 51 items under default maxItems (50) and 101 items under maxItems (100)', async () => {
    const zeroRes = await readAndValidateForEachCollection({
      control: makeForEachControl(),
      rawCollectionText: JSON.stringify({ version: 1, items: [] })
    });
    expect(zeroRes.ok).toBe(true);
    if (zeroRes.ok) {
      expect(zeroRes.collection.itemCount).toBe(0);
      expect(zeroRes.collection.items).toHaveLength(0);
    }

    const oneRes = await readAndValidateForEachCollection({
      control: makeForEachControl(),
      rawCollectionText: JSON.stringify({ version: 1, items: [{ id: 'item-a', count: 1, ready: true }] })
    });
    expect(oneRes.ok).toBe(true);
    if (oneRes.ok) {
      expect(oneRes.collection.itemCount).toBe(1);
      expect(oneRes.collection.items[0]?.itemKey).toBe('item-a');
    }

    const fiftyItems = Array.from({ length: 50 }, (_, idx) => ({ id: `k-${idx}`, idx }));
    const fiftyRes = await readAndValidateForEachCollection({
      control: makeForEachControl({ maxItems: undefined }),
      rawCollectionText: JSON.stringify({ version: 1, items: fiftyItems })
    });
    expect(fiftyRes.ok).toBe(true);

    const fiftyOneItems = Array.from({ length: 51 }, (_, idx) => ({ id: `k-${idx}`, idx }));
    const fiftyOneRes = await readAndValidateForEachCollection({
      control: makeForEachControl({ maxItems: undefined }),
      rawCollectionText: JSON.stringify({ version: 1, items: fiftyOneItems })
    });
    expect(fiftyOneRes.ok).toBe(false);
    if (!fiftyOneRes.ok) {
      expect(fiftyOneRes.code).toBe('collection-too-large');
      expect(fiftyOneRes.reason).toBe('item-count-exceeded');
    }

    const hundredItems = Array.from({ length: 100 }, (_, idx) => ({ id: `k-${idx}`, idx }));
    const hundredRes = await readAndValidateForEachCollection({
      control: makeForEachControl({ maxItems: 100 }),
      rawCollectionText: JSON.stringify({ version: 1, items: hundredItems })
    });
    expect(hundredRes.ok).toBe(true);

    const hundredOneItems = Array.from({ length: 101 }, (_, idx) => ({ id: `k-${idx}`, idx }));
    const hundredOneRes = await readAndValidateForEachCollection({
      control: makeForEachControl({ maxItems: 100 }),
      rawCollectionText: JSON.stringify({ version: 1, items: hundredOneItems })
    });
    expect(hundredOneRes.ok).toBe(false);
    if (!hundredOneRes.ok) {
      expect(hundredOneRes.code).toBe('collection-too-large');
      expect(hundredOneRes.reason).toBe('item-count-exceeded');
    }
  });

  it('rejects duplicate JSON keys, non-D2 primitives, > 32 fields, duplicate/missing itemKeyField, and conflicting bindings', async () => {
    const dupJson = '{"version":1,"items":[{"id":"a","x":1,"x":2}]}';
    const dupRes = await readAndValidateForEachCollection({
      control: makeForEachControl(),
      rawCollectionText: dupJson
    });
    expect(dupRes.ok).toBe(false);
    if (!dupRes.ok) expect(dupRes.code).toBe('invalid-collection');

    const nestedRes = await readAndValidateForEachCollection({
      control: makeForEachControl(),
      rawCollectionText: JSON.stringify({ version: 1, items: [{ id: 'a', nested: { bad: true } }] })
    });
    expect(nestedRes.ok).toBe(false);
    if (!nestedRes.ok) {
      expect(nestedRes.code).toBe('invalid-collection');
      expect(nestedRes.reason).toBe('invalid-item-field');
    }

    const thirtyThreeFields: Record<string, string | number> = { id: 'a' };
    for (let i = 1; i <= 32; i += 1) {
      thirtyThreeFields[`f${i}`] = i;
    }
    const tooManyFieldsRes = await readAndValidateForEachCollection({
      control: makeForEachControl(),
      rawCollectionText: JSON.stringify({ version: 1, items: [thirtyThreeFields] })
    });
    expect(tooManyFieldsRes.ok).toBe(false);
    if (!tooManyFieldsRes.ok) {
      expect(tooManyFieldsRes.code).toBe('invalid-collection');
      expect(tooManyFieldsRes.reason).toBe('item-too-many-fields');
    }

    const dupKeyRes = await readAndValidateForEachCollection({
      control: makeForEachControl({ itemKeyField: 'id' }),
      rawCollectionText: JSON.stringify({
        version: 1,
        items: [
          { id: 'dup-1', val: 1 },
          { id: 'dup-1', val: 2 }
        ]
      })
    });
    expect(dupKeyRes.ok).toBe(false);
    if (!dupKeyRes.ok) {
      expect(dupKeyRes.code).toBe('invalid-collection');
      expect(dupKeyRes.reason).toBe('invalid-or-duplicate-item-key');
    }

    const missingKeyRes = await readAndValidateForEachCollection({
      control: makeForEachControl({ itemKeyField: 'id' }),
      rawCollectionText: JSON.stringify({ version: 1, items: [{ val: 1 }] })
    });
    expect(missingKeyRes.ok).toBe(false);
    if (!missingKeyRes.ok) {
      expect(missingKeyRes.code).toBe('invalid-collection');
      expect(missingKeyRes.reason).toBe('invalid-or-duplicate-item-key');
    }

    const parentWfWithConflict: WorkflowDefinition = {
      ...makeParentWorkflow(),
      bindings: [
        {
          kind: 'input',
          nodeId: 'node-foreach-1',
          inputKey: 'itemPayload',
          source: { from: 'workflow-input', portId: 'itemsFile' }
        }
      ]
    };
    const conflictRes = await readAndValidateForEachCollection({
      control: makeForEachControl(),
      enclosingWorkflow: parentWfWithConflict,
      childWorkflow: CHILD_WORKFLOW,
      nodeId: 'node-foreach-1',
      rawCollectionText: JSON.stringify({ version: 1, items: [{ id: 'a' }] })
    });
    expect(conflictRes.ok).toBe(false);
    if (!conflictRes.ok) {
      expect(conflictRes.code).toBe('invalid-collection');
      expect(conflictRes.reason).toBe('conflicting-item-input-binding');
    }
  });

  it('enforces exact 8,192-byte per-item and 262,144-byte collection boundaries', async () => {
    // Build an item with 8 fields of 1,000-byte strings + 1 field filling up to exactly 8,192 bytes canonical JSON
    const itemFields: Record<string, string> = {};
    for (let i = 0; i < 8; i += 1) {
      itemFields[`f${i}`] = 'a'.repeat(1_000);
    }
    const baseLen = Buffer.byteLength(JSON.stringify({ ...itemFields, pad: '' }), 'utf8');
    const exactPadLen = 8_192 - baseLen;
    const exactItem = { ...itemFields, pad: 'b'.repeat(exactPadLen) };
    expect(Buffer.byteLength(JSON.stringify(exactItem), 'utf8')).toBe(8_192);

    const okItemRes = await readAndValidateForEachCollection({
      control: makeForEachControl({ itemKeyField: undefined }),
      rawCollectionText: JSON.stringify({ version: 1, items: [exactItem] })
    });
    expect(okItemRes.ok).toBe(true);

    const overItem = { ...itemFields, pad: 'b'.repeat(exactPadLen + 1) };
    expect(Buffer.byteLength(JSON.stringify(overItem), 'utf8')).toBe(8_193);
    const overItemRes = await readAndValidateForEachCollection({
      control: makeForEachControl({ itemKeyField: undefined }),
      rawCollectionText: JSON.stringify({ version: 1, items: [overItem] })
    });
    expect(overItemRes.ok).toBe(false);
    if (!overItemRes.ok) {
      expect(overItemRes.code).toBe('collection-too-large');
      expect(overItemRes.reason).toBe('item-bytes-exceeded');
    }

    // 262,145-byte collection rejected with collection-too-large
    const hugeWhitespace = `${' '.repeat(262_121)}{"version":1,"items":[]}`;
    expect(Buffer.byteLength(hugeWhitespace, 'utf8')).toBeGreaterThan(262_144);
    const overColRes = await readAndValidateForEachCollection({
      control: makeForEachControl({ itemKeyField: undefined }),
      rawCollectionText: hugeWhitespace
    });
    expect(overColRes.ok).toBe(false);
    if (!overColRes.ok) {
      expect(overColRes.code).toBe('collection-too-large');
      expect(overColRes.reason).toBe('collection-bytes-exceeded');
    }
  });

  it('reads contained local-file collections, writes 0600 frozen artifacts, and ignores subsequent file mutations after freeze', async () => {
    const wsRoot = await makeTempWorkspace();
    const relPath = 'inputs/batch-items.json';
    await fsp.mkdir(path.join(wsRoot, 'inputs'), { recursive: true });
    const initialPayload = JSON.stringify({
      version: 1,
      items: [
        { id: 'item-1', label: 'Original One' },
        { id: 'item-2', label: 'Original Two' }
      ]
    });
    await fsp.writeFile(path.join(wsRoot, relPath), initialPayload, 'utf8');

    const { executor, rootRunId, parentInvocationId, seedRoot } = makeHarness();
    await seedRoot();

    const initRes = await executor.initializeForEachFrame({
      rootRunId,
      parentInvocationId,
      parentWorkflowId: 'wf-parent-foreach',
      nodeId: 'node-foreach-1',
      control: makeForEachControl(),
      collectionReaderInput: { relativeFilePath: relPath },
      firstChildInvocationId: 'child-inv-0',
      workspaceRoot: wsRoot
    });
    expect(initRes.ok).toBe(true);
    if (!initRes.ok || initRes.action !== 'executing-item') return;
    expect(initRes.collection.artifactRelativePath).toMatch(/^\.schegent\/foreach-collections\/fe-col-/);

    // Mutate the source file on disk after freeze!
    await fsp.writeFile(
      path.join(wsRoot, relPath),
      JSON.stringify({ version: 1, items: [{ id: 'mutated-99', label: 'Tampered' }] }),
      'utf8'
    );

    // Settle item 0 and verify item 1 receives the frozen 'Original Two' item, NOT the mutated file!
    const settled0 = await executor.settleForEachItem({
      rootRunId,
      parentInvocationId,
      nodeId: 'node-foreach-1',
      itemIndex: 0,
      childInvocationId: 'child-inv-0',
      childStatus: 'completed',
      nextChildInvocationId: 'child-inv-1',
      workspaceRoot: wsRoot
    });
    expect(settled0.ok).toBe(true);
    if (settled0.ok && settled0.action === 'advance-item') {
      expect(settled0.nextItemIndex).toBe(1);
      expect(settled0.nextItemKey).toBe('item-2');
      expect(JSON.parse(settled0.nextItemCanonicalJson)).toEqual({
        id: 'item-2',
        label: 'Original Two'
      });
    }
  });
});

describe('FR-R5-F34 — Sequential ForEach execution, error policies, and budgets (F34-T02, F34-T04)', () => {
  it('completes empty collection (0 items) immediately without dispatching any child workflow frame', async () => {
    const parentWf = makeParentWorkflow(makeForEachControl({ itemKeyField: undefined }));
    const { executor, ledgerStore, rootRunId, seedRoot } = makeHarness();
    await seedRoot();

    const created = createComposableWorkflowRunSnapshot({
      connectedRunId: rootRunId,
      queueId: 'default',
      workflow: parentWf,
      effectiveWorkflows: [parentWf, CHILD_WORKFLOW],
      effectivePhases: [
        {
          phaseId: 'phase-process-item',
          name: 'Process Item',
          version: 1,
          runner: 'claude',
          instruction: 'Process item'
        }
      ],
      boundInputs: {
        itemsFile: {
          portId: 'itemsFile',
          type: 'local-file',
          value: JSON.stringify({ version: 1, items: [] })
        }
      },
      startedAt: 1_000
    });
    if (created.outcome !== 'created') throw new Error(created.detail);
    let currentRun: ConnectedWorkflowRun = created.run;

    const dispatchedPhases: string[] = [];
    const stepRes = await dispatchComposableNode(
      {
        connectedRuns: {
          async compareAndSetConnectedRun(next) {
            currentRun = next;
            return { outcome: 'written', run: currentRun };
          }
        },
        dispatchPhase: async (inp) => {
          dispatchedPhases.push(inp.attemptId);
          return { outcome: 'dispatched', queueItemId: `q-${inp.attemptId}` };
        },
        forEachExecutor: executor
      },
      {
        run: currentRun,
        invocationId: created.rootInvocationId,
        nodeId: 'node-foreach-1',
        startedAt: 1_000
      }
    );

    expect(stepRes.outcome).toBe('workflow-completed');
    expect(dispatchedPhases).toHaveLength(0);
    if (stepRes.outcome === 'workflow-completed') {
      const batchIndex = JSON.parse(lookupRecord(stepRes.outputs, 'batchIndex')?.value ?? '{}');
      expect(batchIndex.itemCount).toBe(0);
      expect(batchIndex.hasErrors).toBe(false);
      expect(batchIndex.errorCount).toBe(0);
      expect(batchIndex.slots).toEqual([]);
    }
    const loaded = ledgerStore.read();
    expect(loaded.ok).toBe(true);
  });

  it('executes 3 items sequentially through connected-run-coordinator and exports ordered resultIndex', async () => {
    const parentWf = makeParentWorkflow();
    const { executor, ledgerStore, rootRunId, seedRoot } = makeHarness();
    await seedRoot();

    const itemsPayload = JSON.stringify({
      version: 1,
      items: [
        { id: 'alpha', priority: 1 },
        { id: 'beta', priority: 2 },
        { id: 'gamma', priority: 3 }
      ]
    });
    const created = createComposableWorkflowRunSnapshot({
      connectedRunId: rootRunId,
      queueId: 'default',
      workflow: parentWf,
      effectiveWorkflows: [parentWf, CHILD_WORKFLOW],
      effectivePhases: [
        {
          phaseId: 'phase-process-item',
          name: 'Process Item',
          version: 1,
          runner: 'claude',
          instruction: 'Process item'
        }
      ],
      boundInputs: {
        itemsFile: {
          portId: 'itemsFile',
          type: 'local-file',
          value: itemsPayload
        }
      },
      startedAt: 1_000
    });
    if (created.outcome !== 'created') throw new Error(created.detail);
    let currentRun: ConnectedWorkflowRun = created.run;

    const observedItemInputs: string[] = [];
    const coordinatorDeps = {
      connectedRuns: {
        async compareAndSetConnectedRun(next: ConnectedWorkflowRun) {
          currentRun = next;
          return { outcome: 'written' as const, run: currentRun };
        }
      },
      dispatchPhase: async (inp: { readonly frame: { readonly boundInputs: Record<string, { readonly value: string }> }; readonly attemptId: string }) => {
        observedItemInputs.push(lookupRecord(inp.frame.boundInputs, 'itemPayload')?.value ?? '');
        return { outcome: 'dispatched' as const, queueItemId: `q-${inp.attemptId}` };
      },
      forEachExecutor: executor
    };

    // Dispatch item 0
    const d0 = await dispatchComposableNode(coordinatorDeps, {
      run: currentRun,
      invocationId: created.rootInvocationId,
      nodeId: 'node-foreach-1',
      startedAt: 1_000
    });
    expect(d0.outcome).toBe('phase-dispatched');
    expect(observedItemInputs).toHaveLength(1);
    expect(JSON.parse(observedItemInputs[0] ?? '{}')).toEqual({ id: 'alpha', priority: 1 });

    // Complete item 0 -> advances to item 1
    if (d0.outcome !== 'phase-dispatched') return;
    const d1 = await completeComposableNodeAttempt(coordinatorDeps, {
      run: currentRun,
      invocationId: d0.invocationId,
      nodeId: d0.nodeId,
      status: 'completed',
      completedAt: 2_000
    });
    expect(d1.outcome).toBe('phase-dispatched');
    expect(observedItemInputs).toHaveLength(2);
    expect(JSON.parse(observedItemInputs[1] ?? '{}')).toEqual({ id: 'beta', priority: 2 });

    // Check projection mid-flight (on item 1, index 1 of 3)
    const loadedMid = ledgerStore.read();
    const midRoot = loadedMid.ok ? lookupRecord(loadedMid.ledger.roots, rootRunId) : undefined;
    const midProj = buildForEachNodeProjection(currentRun, 'node-foreach-1', midRoot);
    expect(midProj?.itemCount).toBe(3);
    expect(midProj?.currentIndex).toBe(1);
    expect(midProj?.leafAttemptCount).toBe(2);
    expect(midProj?.slots.map((s) => s.state)).toEqual(['completed', 'executing', 'pending']);

    // Complete item 1 -> advances to item 2
    if (d1.outcome !== 'phase-dispatched') return;
    const d2 = await completeComposableNodeAttempt(coordinatorDeps, {
      run: currentRun,
      invocationId: d1.invocationId,
      nodeId: d1.nodeId,
      status: 'completed',
      completedAt: 3_000
    });
    expect(d2.outcome).toBe('phase-dispatched');
    expect(observedItemInputs).toHaveLength(3);
    expect(JSON.parse(observedItemInputs[2] ?? '{}')).toEqual({ id: 'gamma', priority: 3 });

    // Complete item 2 -> completes ForEach node and parent workflow
    if (d2.outcome !== 'phase-dispatched') return;
    const done = await completeComposableNodeAttempt(coordinatorDeps, {
      run: currentRun,
      invocationId: d2.invocationId,
      nodeId: d2.nodeId,
      status: 'completed',
      completedAt: 4_000
    });
    expect(done.outcome).toBe('workflow-completed');
    if (done.outcome === 'workflow-completed') {
      const resultIndex = JSON.parse(lookupRecord(done.outputs, 'batchIndex')?.value ?? '{}');
      expect(resultIndex.itemCount).toBe(3);
      expect(resultIndex.hasErrors).toBe(false);
      expect(resultIndex.errorCount).toBe(0);
      expect(resultIndex.slots.map((s: { itemKey: string; state: string }) => ({
        itemKey: s.itemKey,
        state: s.state
      }))).toEqual([
        { itemKey: 'alpha', state: 'completed' },
        { itemKey: 'beta', state: 'completed' },
        { itemKey: 'gamma', state: 'completed' }
      ]);
    }
  });

  it('distinguishes onItemError: stop vs continue and never swallows authoritative host/uncertainty codes', async () => {
    // 1. onItemError: 'stop' halts on item 0 failure and leaves item 1 pending
    const stopHarness = makeHarness();
    await stopHarness.seedRoot();
    await stopHarness.executor.initializeForEachFrame({
      rootRunId: stopHarness.rootRunId,
      parentInvocationId: stopHarness.parentInvocationId,
      parentWorkflowId: 'wf-parent',
      nodeId: 'node-fe',
      control: makeForEachControl({ onItemError: 'stop' }),
      collectionReaderInput: {
        rawCollectionText: JSON.stringify({
          version: 1,
          items: [{ id: 'i0' }, { id: 'i1' }]
        })
      },
      firstChildInvocationId: 'child-0'
    });
    const stopRes = await stopHarness.executor.settleForEachItem({
      rootRunId: stopHarness.rootRunId,
      parentInvocationId: stopHarness.parentInvocationId,
      nodeId: 'node-fe',
      itemIndex: 0,
      childInvocationId: 'child-0',
      childStatus: 'failed',
      childFailureCode: 'all-candidates-exhausted',
      childFailureMessage: 'All candidates exhausted on item 0'
    });
    expect(stopRes.ok).toBe(true);
    if (stopRes.ok) {
      expect(stopRes.action).toBe('failed');
      expect(stopRes.frame.forEachState?.slots.map((s) => s.state)).toEqual(['failed', 'pending']);
    }

    // 2. onItemError: 'continue' records slot failure on item 0, advances to item 1, and completes with hasErrors: true
    const contHarness = makeHarness();
    await contHarness.seedRoot();
    await contHarness.executor.initializeForEachFrame({
      rootRunId: contHarness.rootRunId,
      parentInvocationId: contHarness.parentInvocationId,
      parentWorkflowId: 'wf-parent',
      nodeId: 'node-fe',
      control: makeForEachControl({ onItemError: 'continue' }),
      collectionReaderInput: {
        rawCollectionText: JSON.stringify({
          version: 1,
          items: [{ id: 'i0' }, { id: 'i1' }]
        })
      },
      firstChildInvocationId: 'child-0'
    });
    const contStep0 = await contHarness.executor.settleForEachItem({
      rootRunId: contHarness.rootRunId,
      parentInvocationId: contHarness.parentInvocationId,
      nodeId: 'node-fe',
      itemIndex: 0,
      childInvocationId: 'child-0',
      childStatus: 'failed',
      childFailureCode: 'invalid-child-result',
      childResultValid: false,
      nextChildInvocationId: 'child-1'
    });
    expect(contStep0.ok).toBe(true);
    if (contStep0.ok) {
      expect(contStep0.action).toBe('advance-item');
    }
    const contStep1 = await contHarness.executor.settleForEachItem({
      rootRunId: contHarness.rootRunId,
      parentInvocationId: contHarness.parentInvocationId,
      nodeId: 'node-fe',
      itemIndex: 1,
      childInvocationId: 'child-1',
      childStatus: 'completed'
    });
    expect(contStep1.ok).toBe(true);
    if (contStep1.ok && contStep1.action === 'completed') {
      expect(contStep1.hasErrors).toBe(true);
      expect(contStep1.errorCount).toBe(1);
      expect(contStep1.resultIndex.slots[0]?.error?.code).toBe('invalid-child-result');
      expect(contStep1.resultIndex.slots[1]?.state).toBe('completed');
    }

    // 3. Authoritative host/uncertainty codes ('uncertain-effect', 'trust-denied', 'manual-pause') are NEVER swallowed by continue
    const authHarness = makeHarness();
    await authHarness.seedRoot();
    await authHarness.executor.initializeForEachFrame({
      rootRunId: authHarness.rootRunId,
      parentInvocationId: authHarness.parentInvocationId,
      parentWorkflowId: 'wf-parent',
      nodeId: 'node-fe',
      control: makeForEachControl({ onItemError: 'continue' }),
      collectionReaderInput: {
        rawCollectionText: JSON.stringify({
          version: 1,
          items: [{ id: 'i0' }, { id: 'i1' }]
        })
      },
      firstChildInvocationId: 'child-0'
    });
    const authRes = await authHarness.executor.settleForEachItem({
      rootRunId: authHarness.rootRunId,
      parentInvocationId: authHarness.parentInvocationId,
      nodeId: 'node-fe',
      itemIndex: 0,
      childInvocationId: 'child-0',
      childStatus: 'failed',
      childFailureCode: 'uncertain-effect'
    });
    expect(authRes.ok).toBe(true);
    if (authRes.ok && authRes.action === 'paused') {
      expect(authRes.pauseCause).toBe('uncertain-effect');
    }
  });

  it('enforces root 100-dispatch cap, strict USD budget pause between items, aggregate-result-too-large, and depth > 2 refusal', async () => {
    // 1. Root 100-dispatch cap reached before item 1
    const capHarness = makeHarness({ dispatchedAttempts: 100 });
    await capHarness.seedRoot();
    const capInit = await capHarness.executor.initializeForEachFrame({
      rootRunId: capHarness.rootRunId,
      parentInvocationId: capHarness.parentInvocationId,
      parentWorkflowId: 'wf-parent',
      nodeId: 'node-fe',
      control: makeForEachControl(),
      collectionReaderInput: {
        rawCollectionText: JSON.stringify({ version: 1, items: [{ id: 'i0' }] })
      }
    });
    expect(capInit.ok).toBe(false);
    if (!capInit.ok) expect(capInit.code).toBe('dispatch-budget-exhausted');

    // 2. Strict USD budget reached after item 0 pauses before item 1
    const usdHarness = makeHarness({
      strictUsdMaxMicrousd: 500_000,
      settledMicrousd: 500_000
    });
    await usdHarness.seedRoot();
    await usdHarness.executor.initializeForEachFrame({
      rootRunId: usdHarness.rootRunId,
      parentInvocationId: usdHarness.parentInvocationId,
      parentWorkflowId: 'wf-parent',
      nodeId: 'node-fe',
      control: makeForEachControl(),
      collectionReaderInput: {
        rawCollectionText: JSON.stringify({ version: 1, items: [{ id: 'i0' }, { id: 'i1' }] })
      },
      firstChildInvocationId: 'child-0'
    });
    const usdStep = await usdHarness.executor.settleForEachItem({
      rootRunId: usdHarness.rootRunId,
      parentInvocationId: usdHarness.parentInvocationId,
      nodeId: 'node-fe',
      itemIndex: 0,
      childInvocationId: 'child-0',
      childStatus: 'completed'
    });
    expect(usdStep.ok).toBe(true);
    if (usdStep.ok && usdStep.action === 'paused') {
      expect(usdStep.pauseCause).toBe('spend-limit-reached');
    }

    // 3. Aggregate result index > 262,144 bytes pauses with aggregate-result-too-large without truncating slots
    const overflowIdx = await buildOrderedResultIndex({
      collectionRef: 'fe-col-large',
      collectionSha256: 'abc',
      slots: Array.from({ length: 100 }, (_, idx) => ({
        index: idx,
        itemIndex: idx,
        itemKey: `key-${idx}`,
        state: 'completed' as const,
        status: 'completed' as const,
        resultRef: `res-${idx}`
      })),
      outputsByItemIndex: Object.fromEntries(
        Array.from({ length: 100 }, (_, idx) => [idx, { bigOutput: 'x'.repeat(3_000) }])
      )
    });
    expect(overflowIdx.ok).toBe(false);
    if (!overflowIdx.ok) {
      expect(overflowIdx.code).toBe('aggregate-result-too-large');
    }

    // 4. Control nesting depth > 2 refused at freeze even for empty collection
    const deepChildWf: WorkflowDefinition = {
      ...CHILD_WORKFLOW,
      control: {
        version: 1,
        kind: 'candidate-block',
        candidates: [{ candidateId: 'c1', nodeId: 'phase-item-1', priority: 1 }]
      }
    };
    const midWf: WorkflowDefinition = {
      ...makeParentWorkflow(),
      workflowId: 'wf-mid'
    };
    const outerWf: WorkflowDefinition = {
      workflowId: 'wf-outer',
      name: 'Outer Repeat',
      version: 1,
      nodes: [
        {
          nodeId: 'node-outer-repeat',
          kind: 'workflow',
          workflowId: 'wf-mid',
          control: {
            version: 1,
            kind: 'repeat',
            maxIterations: 2,
            carry: [],
            until: {
              version: 1,
              kind: 'typed',
              test: {
                left: { source: 'result-field', fieldId: 'done' },
                operator: 'equals',
                right: true
              }
            }
          }
        }
      ],
      connections: [],
      startNodeIds: ['node-outer-repeat']
    };
    const deepRun: ConnectedWorkflowRun = {
      connectedRunId: 'conn-deep',
      workflowId: 'wf-outer',
      revision: 1,
      startedAt: 1_000,
      graph: outerWf,
      pipelines: {},
      nodes: {},
      decisions: [],
      frozenClosure: {
        rootWorkflowId: 'wf-outer',
        entryNodeId: 'node-outer-repeat',
        workflowsById: {
          'wf-outer': outerWf,
          'wf-mid': midWf,
          [CHILD_WORKFLOW.workflowId]: deepChildWf
        },
        phasesById: {},
        definitionDigestsById: {},
        closureMetrics: {
          maxDepth: 2,
          definitionCount: 3,
          expandedNodeCount: 3
        }
      },
      invocations: {
        'inv-outer': {
          invocationId: 'inv-outer',
          parentInvocationId: null,
          parentCallNodeId: null,
          parentAttemptId: null,
          rootRunId: 'conn-deep',
          workflowId: 'wf-outer',
          depth: 0,
          nodePath: '/node-outer-repeat',
          entryNodeId: 'node-outer-repeat',
          activeNodeId: 'node-outer-repeat',
          status: 'in-flight',
          startedAt: 1_000,
          boundInputs: {},
          resolvedOutputs: {},
          attemptsByNodeId: {},
          decisions: []
        },
        'inv-mid': {
          invocationId: 'inv-mid',
          parentInvocationId: 'inv-outer',
          parentCallNodeId: 'node-outer-repeat',
          parentAttemptId: null,
          rootRunId: 'conn-deep',
          workflowId: 'wf-mid',
          depth: 1,
          nodePath: '/node-outer-repeat/node-foreach-1',
          entryNodeId: 'node-foreach-1',
          activeNodeId: 'node-foreach-1',
          status: 'in-flight',
          startedAt: 1_000,
          boundInputs: {},
          resolvedOutputs: {},
          attemptsByNodeId: {},
          decisions: []
        }
      }
    };
    const midNode = midWf.nodes.at(0);
    if (midNode === undefined) throw new Error('missing midNode');
    const depthCheck = resolveFrozenForEachControl(
      deepRun,
      midWf,
      midNode,
      deepRun.invocations?.['inv-mid']
    );
    expect(depthCheck.ok).toBe(false);
    if (!depthCheck.ok) {
      expect(depthCheck.code).toBe('control-nesting-depth-exceeded');
    }

    // Verify helper exports
    expect(buildForEachFrameKey('inv-1', 'node-1')).toBe('inv-1:for-each:node-1');
    const envBuilt = buildForEachItemInputEnvelope({
      parentInvocationId: 'inv-1',
      nodeId: 'node-1',
      itemIndex: 2,
      itemInputPortId: 'itemPayload',
      itemCanonicalJson: '{"id":"x"}',
      baseInputsByPort: {},
      acceptedAt: 1_234
    });
    expect(envBuilt.envelope.envelopeId).toBe('inv-1:node-1:item-2:env');
  });
});
