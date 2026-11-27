/**
 * FR-R8-04 (`04-02`) — Compile-time mandatory collaborator and named-target
 * checks (`@ts-expect-error`) plus runtime UI `CMD_ACK` / persisted store /
 * zero-effect parity across rejected launch and continuation scenarios.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowLeafTarget } from '../../../../src/contracts/workflow-leaf-target';
import {
  CMD_CONTINUE_WORKFLOW,
  CMD_LAUNCH_WORKFLOW,
  type ContinueWorkflowCommand,
  type LaunchWorkflowCommand
} from '../../../../src/contracts/sidebar-ipc';
import type { PhaseDefinition } from '../../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../../src/contracts/workflow-definitions';
import type { PipelineCatalog } from '../../../../src/config/pipeline-config';
import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  createCutoverAuthorityGuard,
  createDefaultDurableArtifactHandoverSeam,
  createDesktopWorkflowComposition,
  createProductionWorkflowComposition,
  type DesktopWorkflowCompositionOptions
} from '../../../../src/services/workflow-execution/production-workflow-composition';
import type { PhaseHandoffCoordinator } from '../../../../src/services/phase-context/phase-handoff-coordinator';
import {
  resolveRootInvocationId,
  type ConnectedWorkflowRun
} from '../../../../src/state/connected-workflow-run';
import { disposeWorkspaceFolderPicker } from '../../../../src/state/workspace-folder-picker';
import { KEYS, type Memento } from '../../../../src/state/workspace-state';
import { handler as handleLaunchWorkflow } from '../../../../src/ui/sidebar/commands/cmd-launch-workflow';
import { handler as handleContinueWorkflow } from '../../../../src/ui/sidebar/commands/cmd-continue-workflow';
import type { HandlerContext } from '../../../../src/ui/sidebar/commands/handler-contract';
import type { RouterDeps } from '../../../../src/ui/sidebar/commands/router-types';
import { removeTempRoot } from '../../../temp-root-cleanup';

function createMemoryStore() {
  const raw = new Map<string, unknown>();
  const connected = new Map<string, ConnectedWorkflowRun>();
  const memento: Memento & {
    getConnectedRun(id: string): ConnectedWorkflowRun | null;
    getConnectedRuns(): Readonly<Record<string, ConnectedWorkflowRun>>;
    compareAndSetConnectedRun(
      next: ConnectedWorkflowRun,
      expectedRevision: number
    ): Promise<
      | { readonly outcome: 'written'; readonly run: ConnectedWorkflowRun }
      | { readonly outcome: 'stale'; readonly current: ConnectedWorkflowRun | null }
    >;
    readChildState(queueItemId: string): 'in-flight' | 'completed' | 'failed' | 'canceled';
  } = {
    get<T>(key: string, defaultValue?: T): T | undefined {
      if (connected.has(key)) return connected.get(key) as unknown as T;
      if (raw.has(key)) return raw.get(key) as T;
      return defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) raw.delete(key);
      else raw.set(key, structuredClone(value));
    },
    getConnectedRun(id: string): ConnectedWorkflowRun | null {
      return connected.get(id) ?? null;
    },
    getConnectedRuns(): Readonly<Record<string, ConnectedWorkflowRun>> {
      return Object.fromEntries(connected.entries());
    },
    async compareAndSetConnectedRun(next, expectedRevision) {
      const existing = connected.get(next.connectedRunId) ?? null;
      if (expectedRevision === 0) {
        if (existing !== null) return { outcome: 'stale', current: existing };
        const written = Object.freeze({ ...next, revision: Math.max(1, next.revision) });
        connected.set(next.connectedRunId, written);
        return { outcome: 'written', run: written };
      }
      if (existing === null || existing.revision !== expectedRevision) {
        return { outcome: 'stale', current: existing };
      }
      const written = Object.freeze({ ...next, revision: existing.revision + 1 });
      connected.set(next.connectedRunId, written);
      return { outcome: 'written', run: written };
    },
    readChildState(): 'in-flight' | 'completed' | 'failed' | 'canceled' {
      return 'completed';
    }
  };
  return { raw, connected, memento };
}

function makeStubHandoffCoordinator(): PhaseHandoffCoordinator {
  return {
    prepareTransitionHandoff: async () => ({ kind: 'no-handoff' }),
    planAndAuthorizeAttemptDelivery: async () => ({ ok: true, delivery: null }) as never,
    inspectHandoff: () => ({ ok: false, code: 'handoff-not-found', message: 'stub' }) as never,
    settleAttemptDispatch: () => ({ ok: true }),
    reconcileInterruptedDispatches: () => []
  } as unknown as PhaseHandoffCoordinator;
}

function makeValidDesktopOptions(workspaceRoot: string): DesktopWorkflowCompositionOptions {
  const { memento } = createMemoryStore();
  return {
    store: memento,
    workspaceRoot,
    isWorkspaceTrusted: () => true,
    resolveExecutionFence: (run, queueId) => ({
      primacyClaim: 'primacy:win-1:g1',
      queueClaim: `queue:${queueId}:owner:win-1:g1`,
      rootGeneration: run.revision >= 1 ? run.revision : 1
    }),
    verifyLiveFence: async () => true,
    isLocalFenceCurrent: () => true,
    durableHandoffSeam: createDefaultDurableArtifactHandoverSeam({ status: 'qualified' }),
    phaseHandoffCoordinator: makeStubHandoffCoordinator(),
    cutoverAuthorityGuard: createCutoverAuthorityGuard({
      mode: 'post-cutover-strict',
      storeAuthority: 'sqlite-f04',
      runtimeAuthority: 'acp-f13'
    })
  };
}

/**
 * Compile-time negative checks enforced by `npm run typecheck:tests`.
 * Never invoked at runtime — each `@ts-expect-error` fails `tsc` if desktop
 * collaborators become optional again or `WorkflowLeafTarget` regresses to
 * positional strings.
 */
export function _compileTimeNegativeChecks(valid: DesktopWorkflowCompositionOptions): void {
  const { store: _dropStore, ...withoutStore } = valid;
  void _dropStore;
  // @ts-expect-error store is mandatory in DesktopWorkflowCompositionOptions
  createDesktopWorkflowComposition(withoutStore);

  const { workspaceRoot: _dropRoot, ...withoutRoot } = valid;
  void _dropRoot;
  // @ts-expect-error workspaceRoot is mandatory in DesktopWorkflowCompositionOptions
  createDesktopWorkflowComposition(withoutRoot);

  const { isWorkspaceTrusted: _dropTrust, ...withoutTrust } = valid;
  void _dropTrust;
  // @ts-expect-error isWorkspaceTrusted is mandatory in DesktopWorkflowCompositionOptions
  createDesktopWorkflowComposition(withoutTrust);

  const { resolveExecutionFence: _dropResolve, ...withoutResolve } = valid;
  void _dropResolve;
  // @ts-expect-error resolveExecutionFence is mandatory in DesktopWorkflowCompositionOptions
  createDesktopWorkflowComposition(withoutResolve);

  const { verifyLiveFence: _dropFence, ...withoutLiveFence } = valid;
  void _dropFence;
  // @ts-expect-error verifyLiveFence is mandatory in DesktopWorkflowCompositionOptions
  createDesktopWorkflowComposition(withoutLiveFence);

  const { isLocalFenceCurrent: _dropLocal, ...withoutLocal } = valid;
  void _dropLocal;
  // @ts-expect-error isLocalFenceCurrent is mandatory in DesktopWorkflowCompositionOptions
  createDesktopWorkflowComposition(withoutLocal);

  const { durableHandoffSeam: _dropSeam, ...withoutSeam } = valid;
  void _dropSeam;
  // @ts-expect-error durableHandoffSeam is mandatory in DesktopWorkflowCompositionOptions
  createDesktopWorkflowComposition(withoutSeam);

  const { phaseHandoffCoordinator: _dropCoord, ...withoutCoord } = valid;
  void _dropCoord;
  // @ts-expect-error phaseHandoffCoordinator is mandatory in DesktopWorkflowCompositionOptions
  createDesktopWorkflowComposition(withoutCoord);

  const { cutoverAuthorityGuard: _dropCutover, ...withoutCutover } = valid;
  void _dropCutover;
  // @ts-expect-error cutoverAuthorityGuard is mandatory in DesktopWorkflowCompositionOptions
  createDesktopWorkflowComposition(withoutCutover);

  // @ts-expect-error pre-cutover-compatible guard is rejected by DesktopWorkflowCompositionOptions
  createDesktopWorkflowComposition({ ...valid, cutoverAuthorityGuard: createCutoverAuthorityGuard() });

  // @ts-expect-error requireLiveFenceVerifier cannot be overridden on desktop composition
  createDesktopWorkflowComposition({ ...valid, requireLiveFenceVerifier: false });

  // @ts-expect-error allowFixtureCapabilities cannot be enabled on desktop composition
  createDesktopWorkflowComposition({ ...valid, allowFixtureCapabilities: true });

  // @ts-expect-error collaboratorOverrides cannot disable collaborators on desktop composition
  createDesktopWorkflowComposition({ ...valid, collaboratorOverrides: { controlAdmission: false } });

  // @ts-expect-error admissionDeps cannot override fencing on desktop composition
  createDesktopWorkflowComposition({ ...valid, admissionDeps: { requireLiveFenceVerifier: false } });

  // @ts-expect-error commandServiceDeps cannot override trust/fencing on desktop composition
  createDesktopWorkflowComposition({ ...valid, commandServiceDeps: { isTrusted: () => true } });

  const comp = createDesktopWorkflowComposition(valid);
  const { memento } = createMemoryStore();
  comp.createCoordinatorDeps({
    connectedRuns: memento,
    dispatchPhase: async () => ({ outcome: 'dispatched', queueItemId: 'q-1' }),
    // @ts-expect-error cancelOrphanedQueueItem takes named WorkflowLeafTarget, never positional strings
    cancelOrphanedQueueItem: (queueId: string, taskId: string) => {
      void queueId;
      void taskId;
    }
  });

  // @ts-expect-error WorkflowLeafTarget requires taskId
  const missingTask: WorkflowLeafTarget = { queueId: 'default' };
  // @ts-expect-error WorkflowLeafTarget requires queueId
  const missingQueue: WorkflowLeafTarget = { taskId: 'task-1' };
  void missingTask;
  void missingQueue;
}

describe('FR-R8-04 (04-02) — explicit desktop collaborators, named targets, and refusal parity', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root !== undefined) await removeTempRoot(root);
    }
  });

  it('createDesktopWorkflowComposition constructs cleanly with all mandatory collaborators and refuses runtime omission or bypass via cast', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-r8-0402-'));
    tempRoots.push(tmpRoot);

    const valid = makeValidDesktopOptions(tmpRoot);
    const composition = createDesktopWorkflowComposition(valid);
    expect(composition.compositionId).toBe('ProductionWorkflowComposition');
    expect(composition.workspaceRoot).toBe(tmpRoot);
    expect(composition.durableHandoffSeam.status).toBe('qualified');
    expect(composition.cutoverAuthorityGuard.mode).toBe('post-cutover-strict');
    composition.dispose();

    expect(() =>
      createDesktopWorkflowComposition(null as unknown as DesktopWorkflowCompositionOptions)
    ).toThrow(/DesktopWorkflowComposition missing mandatory collaborator\(s\): options/);

    const unsafeMissing = {
      ...valid,
      verifyLiveFence: undefined,
      cutoverAuthorityGuard: undefined
    } as unknown as DesktopWorkflowCompositionOptions;
    expect(() => createDesktopWorkflowComposition(unsafeMissing)).toThrow(
      /DesktopWorkflowComposition missing mandatory collaborator\(s\):.*verifyLiveFence.*cutoverAuthorityGuard/
    );

    const unsafePreCutover = {
      ...valid,
      cutoverAuthorityGuard: createCutoverAuthorityGuard()
    } as unknown as DesktopWorkflowCompositionOptions;
    expect(() => createDesktopWorkflowComposition(unsafePreCutover)).toThrow(
      /DesktopWorkflowComposition missing mandatory collaborator\(s\):.*cutoverAuthorityGuard/
    );

    const unsafeMalformedStubs = {
      ...valid,
      durableHandoffSeam: {},
      phaseHandoffCoordinator: {}
    } as unknown as DesktopWorkflowCompositionOptions;
    expect(() => createDesktopWorkflowComposition(unsafeMalformedStubs)).toThrow(
      /DesktopWorkflowComposition missing mandatory collaborator\(s\):.*durableHandoffSeam.*phaseHandoffCoordinator/
    );

    const unsafeBypass = {
      ...valid,
      requireLiveFenceVerifier: false,
      allowFixtureCapabilities: true,
      collaboratorOverrides: { controlAdmission: false },
      admissionDeps: { requireLiveFenceVerifier: false },
      commandServiceDeps: { isTrusted: () => true }
    } as unknown as DesktopWorkflowCompositionOptions;
    expect(() => createDesktopWorkflowComposition(unsafeBypass)).toThrow(
      /DesktopWorkflowComposition disallowed bypass option\(s\):.*requireLiveFenceVerifier.*allowFixtureCapabilities.*collaboratorOverrides.*admissionDeps.*commandServiceDeps/
    );
  });

  it('agrees across UI CMD_ACK, persisted store state, control ledger, and zero effects in rejected launch and continuation scenarios', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-r8-0402-parity-'));
    tempRoots.push(tmpRoot);

    const { raw, connected, memento } = createMemoryStore();
    const logger = new SanitizedLogger();
    const enqueueSpy = vi.fn(async () => ({ outcome: 'enqueued' as const, queueItemId: 'should-not-enqueue' }));

    const phaseA: PhaseDefinition = {
      phaseId: 'phase-a',
      version: 1,
      name: 'Phase A',
      runner: 'claude',
      instruction: 'Execute Phase A'
    };
    const workflowA: WorkflowDefinition = {
      workflowId: 'wf-a',
      version: 1,
      name: 'Workflow A',
      startNodeIds: ['node-a'],
      nodes: [{ nodeId: 'node-a', kind: 'phase', phaseId: 'phase-a' }],
      connections: [
        {
          from: { nodeId: 'node-a' },
          to: { nodeId: 'return', kind: 'return' },
          handoff: 'auto',
          priority: 0
        }
      ]
    };
    const emptyCatalog: PipelineCatalog = {
      phases: [],
      pipelines: [],
      models: { claude: [], codex: [], agy: [] },
      defaultPipelineId: 'default',
      phasesById: new Map(),
      pipelinesById: new Map()
    };

    const acks: Array<{
      readonly correlationId: string;
      readonly status: 'accepted' | 'rejected';
      readonly reason?: string | undefined;
      readonly result?: unknown;
    }> = [];

    const buildContext = (depsOverride: Partial<RouterDeps>, correlationId: string): HandlerContext => ({
      correlationId,
      postAck: async (msg) => {
        acks.push({
          correlationId: msg.correlationId,
          status: msg.status,
          reason: msg.reason,
          result: msg.result
        });
        return true;
      },
      deps: {
        logger,
        getCatalog: () => emptyCatalog,
        readPhaseConfig: () => ({ rows: [phaseA], revision: 'rev-p1' }),
        readWorkflowConfig: () => ({ rows: [workflowA], revision: 'rev-w1' }),
        readPipelineConfig: () => ({ rows: [], revision: 'rev-pl1' }),
        connectedRuns: memento,
        guardedRun: { scheduleOrEnqueue: enqueueSpy } as unknown as RouterDeps['guardedRun'],
        ...depsOverride
      } as unknown as RouterDeps
    });

    // Scenario 1: Unknown workflowId -> CMD_ACK rejected, 0 queue enqueues, 0 connected runs, 0 ledger roots
    const unknownLaunchCmd: LaunchWorkflowCommand = {
      type: CMD_LAUNCH_WORKFLOW,
      correlationId: 'corr-unknown-wf',
      payload: {
        workflowId: 'wf-does-not-exist',
        startNodeId: 'node-a',
        request: { pipelineId: 'phase-a', inputs: [], supplemental: [], outputs: [] }
      }
    };
    await handleLaunchWorkflow(buildContext({}, 'corr-unknown-wf'), unknownLaunchCmd);

    expect(acks.at(0)?.status).toBe('rejected');
    expect(acks.at(0)?.reason).toBe('rejected-definition');
    expect(enqueueSpy).toHaveBeenCalledTimes(0);
    expect(connected.size).toBe(0);
    expect(raw.get(KEYS.controlLedger)).toBeUndefined();

    // Scenario 2: Missing required collaborator (`controlAdmission: false`) -> CMD_ACK rejected-queue with missing-collaborator refusal, 0 effects
    const degradedComp = createProductionWorkflowComposition({
      store: memento,
      workspaceRoot: tmpRoot,
      collaboratorOverrides: { controlAdmission: false }
    });
    const missingCollabCmd: LaunchWorkflowCommand = {
      type: CMD_LAUNCH_WORKFLOW,
      correlationId: 'corr-missing-collab',
      payload: {
        workflowId: 'wf-a',
        startNodeId: 'node-a',
        request: { pipelineId: 'phase-a', inputs: [], supplemental: [], outputs: [] }
      }
    };
    const mutableWorkspace = vscode.workspace as unknown as {
      workspaceFolders?: readonly { readonly uri: { readonly fsPath: string; readonly scheme: string } }[] | undefined;
    };
    const priorFolders = mutableWorkspace.workspaceFolders;
    disposeWorkspaceFolderPicker();
    mutableWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot, scheme: 'file' } }];
    try {
      await handleLaunchWorkflow(
        buildContext({ getProductionComposition: () => degradedComp }, 'corr-missing-collab'),
        missingCollabCmd
      );
    } finally {
      mutableWorkspace.workspaceFolders = priorFolders;
      disposeWorkspaceFolderPicker();
    }
    expect(acks.at(1)?.status).toBe('rejected');
    expect(acks.at(1)?.reason).toBe('rejected-queue');
    expect((acks.at(1)?.result as { readonly refusal?: unknown } | undefined)?.refusal).toMatchObject({
      category: 'missing-collaborator',
      reasonCode: 'collaborator-absent:controlAdmission',
      attemptsConsumed: 0
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(0);
    expect(connected.size).toBe(0);
    const ledgerRead = degradedComp.ledgerStore.read();
    expect(ledgerRead.ok).toBe(true);
    if (ledgerRead.ok) {
      expect(ledgerRead.ledger.roots).toEqual({});
    }
    degradedComp.dispose();

    // Scenario 3: Stale revision continuation on an existing run -> CMD_ACK rejected, store untouched, 0 effects
    const seededRun: ConnectedWorkflowRun = Object.freeze({
      connectedRunId: 'conn-existing-1',
      workflowId: 'wf-a',
      workflowName: 'Workflow A',
      workflowVersion: 1,
      revision: 3,
      startedAt: 1_000,
      queueId: 'default',
      graph: workflowA,
      pipelines: {},
      nodes: {
        'node-a': {
          nodeId: 'node-a',
          attempts: []
        }
      },
      decisions: []
    });
    connected.set(seededRun.connectedRunId, seededRun);

    const staleContinueCmd: ContinueWorkflowCommand = {
      type: CMD_CONTINUE_WORKFLOW,
      correlationId: 'corr-stale-continue',
      payload: {
        connectedRunId: 'conn-existing-1',
        expectedRevision: 1,
        nodeId: 'node-a',
        request: { pipelineId: 'phase-a', inputs: [], supplemental: [], outputs: [] }
      }
    };
    const healthyComp = createDesktopWorkflowComposition(makeValidDesktopOptions(tmpRoot));
    await handleContinueWorkflow(
      buildContext({ getProductionComposition: () => healthyComp }, 'corr-stale-continue'),
      staleContinueCmd
    );
    expect(acks.at(2)?.status).toBe('rejected');
    expect(acks.at(2)?.reason).toBe('rejected-stale');
    expect(enqueueSpy).toHaveBeenCalledTimes(0);
    expect(connected.get('conn-existing-1')?.revision).toBe(3);
    expect(resolveRootInvocationId(seededRun)).toBeTruthy();
    healthyComp.dispose();
  });
});
