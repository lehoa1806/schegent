// Feature 266 (FR-R5-F07, T006) — Round 5 clean-install operator journey.
//
// Proves the consolidated Phase + Workflow model end-to-end on a clean empty
// catalog (FR-R3-014):
//   1. Preflight and publish `examples/example-nested-delivery.workflow.yaml`
//      into an empty catalog store; all 3 Phases and 3 Workflows become active
//      and resolve as `effective`.
//   2. Launch root Workflow `delivery-root`, step through its 3-level call
//      tree (`delivery-root` -> `delivery-plan-and-verify` ->
//      `delivery-verify-leaf`), and verify that the two occurrences of
//      `delivery-verify-leaf` carry distinct `invocationId` and `nodePath`
//      values in both runtime state and `projectConnectedRun`.
//   3. Launch child Workflow `delivery-verify-leaf` independently as its own
//      root invocation (`depth: 0`).
//   4. Exercise invocation-scoped `pause`, `resume`, and `cancel` via
//      `WorkflowControlService` and verify `projectConnectedRun`.
//   5. Verify that a legacy `kind: Pipeline` YAML document is refused at the
//      preflight boundary with `unsupported-kind` and leaves the store untouched.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/round5-clean-install-journey' },
    name: 'round5-clean-install-journey',
    index: 0
  })
}));

import { resolvePhaseCatalog } from '../../src/config/process-catalog';
import { resolveWorkflowCatalog } from '../../src/config/workflow-catalog';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../src/contracts/backend-kinds';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import {
  CMD_PREFLIGHT_PROCESS_YAML,
  CMD_PUBLISH_PACKAGE,
  type CommandAckMessage,
  type ImportPlan,
  type PreflightProcessYamlCommand,
  type PreflightProcessYamlResult,
  type PublishPackageCommand
} from '../../src/contracts/sidebar-ipc';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode,
  type PhaseAttemptDispatchInput
} from '../../src/services/workflow-execution/connected-run-coordinator';
import { createComposableWorkflowRunSnapshot } from '../../src/services/workflow-execution/connected-run-factory';
import {
  WorkflowControlService,
  type WorkflowControlStore
} from '../../src/services/workflow-execution/workflow-control-service';
import { WorkflowRecoveryService } from '../../src/services/workflow-execution/workflow-recovery-service';
import { selectProcessExportDocument } from '../../src/services/process-yaml/export-service';
import type { ConnectedWorkflowRun } from '../../src/state/connected-workflow-run';
import { publishDefinitionPackage } from '../../src/ui/sidebar/commands/cmd-catalog-lifecycle';
import { handler as preflightHandler } from '../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { projectConnectedRun } from '../../src/ui/sidebar/connected-run-projector';
import { fakeCatalogLifecycle } from '../fixtures/fake-catalog-lifecycle';
import { FakeCatalogStore, NO_WRITES, writesOf } from '../fixtures/fake-catalog-store';

const EXAMPLES_DIR = join(__dirname, '..', '..', 'examples');
const NESTED_DELIVERY_YAML = readFileSync(
  join(EXAMPLES_DIR, 'example-nested-delivery.workflow.yaml'),
  'utf8'
);

type ModelsConfig = Record<BackendRunnerKind, readonly string[]>;

interface CleanInstallHarness {
  readonly store: FakeCatalogStore;
  readonly preflight: (yamlText: string) => Promise<PreflightProcessYamlResult>;
  readonly publishPlannedPackage: (plan: ImportPlan) => Promise<readonly CommandAckMessage[]>;
}

function buildCleanInstallHarness(): CleanInstallHarness {
  const store = new FakeCatalogStore();
  let models = Object.fromEntries(
    SUPPORTED_BACKENDS.map((backend) => [backend, [] as readonly string[]])
  ) as ModelsConfig;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (v: string) => v
  };
  const layer = (kind: 'phase' | 'workflow') => () => ({
    rows: store.rowsOf(kind),
    revision: store.revisionOf(kind),
    ids: new Set(store.idsOf(kind))
  });
  const baseDeps = {
    readPhaseConfig: layer('phase'),
    readWorkflowConfig: layer('workflow'),
    readModelsConfig: () => models,
    audit: { append: async () => undefined },
    logger
  };

  return {
    store,
    async preflight(yamlText: string): Promise<PreflightProcessYamlResult> {
      const acks: CommandAckMessage[] = [];
      const ctx = {
        deps: {
          ...baseDeps,
          openProcessYamlDocument: async () => ({
            outcome: 'read' as const,
            bytes: new Uint8Array(Buffer.from(yamlText, 'utf8'))
          })
        },
        postAck: async (msg: CommandAckMessage) => {
          acks.push(msg);
          return true;
        },
        correlationId: 'round5-preflight-1'
      };
      const cmd: PreflightProcessYamlCommand = {
        type: CMD_PREFLIGHT_PROCESS_YAML,
        correlationId: 'round5-preflight-1',
        payload: {}
      };
      await preflightHandler(ctx as never, cmd);
      return acks[0]!.result as PreflightProcessYamlResult;
    },
    async publishPlannedPackage(plan: ImportPlan): Promise<readonly CommandAckMessage[]> {
      const acks: CommandAckMessage[] = [];
      const ctx = {
        deps: {
          ...baseDeps,
          catalogStore: store,
          catalogLifecycle: fakeCatalogLifecycle(store),
          refreshCatalog: async () => undefined,
          readConfig: () => undefined,
          updateConfig: async (_key: string, value: unknown) => {
            models = value as ModelsConfig;
          },
          executeCommand: vi.fn()
        },
        postAck: async (msg: CommandAckMessage) => {
          acks.push(msg);
          return true;
        },
        correlationId: 'round5-publish-1'
      };

      const phases: PhaseDefinition[] = [];
      const workflows: WorkflowDefinition[] = [];
      for (const row of plan.rows) {
        if (row.outcome === 'import' && row.resourceKind === 'phase') {
          phases.push(row.definition);
        } else if (row.outcome === 'import' && row.resourceKind === 'workflow') {
          workflows.push(row.definition);
        }
      }

      const layers: PublishPackageCommand['payload']['layers'][number][] = [];
      if (phases.length > 0) {
        layers.push({
          kind: 'phase',
          expectedRevision: plan.computedAgainstRevision,
          definitions: phases.map(({ phaseId, ...declared }) => ({
            id: phaseId,
            body: { id: phaseId, ...declared }
          }))
        });
      }
      if (workflows.length > 0) {
        layers.push({
          kind: 'workflow',
          expectedRevision: plan.computedAgainstWorkflowRevision!,
          definitions: workflows.map(({ workflowId, ...declared }) => ({
            id: workflowId,
            body: { id: workflowId, ...declared }
          }))
        });
      }

      await publishDefinitionPackage(ctx as never, {
        type: CMD_PUBLISH_PACKAGE,
        correlationId: 'round5-publish-1',
        payload: { layers }
      });
      return acks;
    }
  };
}

function createInMemoryRunStore(initial: ConnectedWorkflowRun): WorkflowControlStore & {
  current: () => ConnectedWorkflowRun;
  update: (next: ConnectedWorkflowRun) => void;
} {
  let state = initial;
  return {
    get(connectedRunId: string) {
      return state.connectedRunId === connectedRunId ? state : null;
    },
    async compareAndSetConnectedRun(next: ConnectedWorkflowRun, expectedRevision: number) {
      if (state.revision !== expectedRevision) {
        return { outcome: 'stale' as const, current: state };
      }
      state = next;
      return { outcome: 'written' as const, run: state };
    },
    current: () => state,
    update: (next: ConnectedWorkflowRun) => {
      state = next;
    }
  };
}

describe('Round 5 clean-install journey (FR-R5-F07)', () => {
  it('imports example-nested-delivery.workflow.yaml into an empty catalog, executes root and child Workflows, and exercises invocation control', async () => {
    const harness = buildCleanInstallHarness();

    // 1. Clean-install catalog starts empty (FR-R3-014).
    expect(harness.store.rowsOf('phase')).toEqual([]);
    expect(harness.store.rowsOf('workflow')).toEqual([]);

    // 2. Preflight and publish the 3-level nested Workflow package.
    const preflightRes = await harness.preflight(NESTED_DELIVERY_YAML);
    expect(preflightRes.outcome).toBe('planned');
    if (preflightRes.outcome !== 'planned') return;
    expect(preflightRes.plan.counts).toEqual({
      import: 6,
      skip: 0,
      blocked: 0,
      invalid: 0
    });

    const publishAcks = await harness.publishPlannedPackage(preflightRes.plan);
    expect(publishAcks).toHaveLength(1);
    expect(publishAcks[0]!.status).toBe('accepted');

    const phases = resolvePhaseCatalog({
      rows: harness.store.rowsOf('phase'),
      revision: harness.store.revisionOf('phase')
    });
    const workflows = resolveWorkflowCatalog({
      rows: harness.store.rowsOf('workflow'),
      revision: harness.store.revisionOf('workflow'),
      phaseCatalog: { effective: phases.effective, records: phases.records }
    });

    expect(phases.effective.map((p) => p.phaseId)).toEqual([
      'delivery-draft-phase',
      'delivery-plan-phase',
      'delivery-check-phase'
    ]);
    expect(workflows.effective.map((w) => w.workflowId).sort()).toEqual([
      'delivery-plan-and-verify',
      'delivery-root',
      'delivery-verify-leaf'
    ]);

    const rootWorkflow = workflows.effective.find((w) => w.workflowId === 'delivery-root')!;
    const leafWorkflow = workflows.effective.find((w) => w.workflowId === 'delivery-verify-leaf')!;

    // 3. Create and step through the 3-level root Workflow run (`delivery-root`).
    const createdRoot = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-delivery-root-1',
      workflow: rootWorkflow,
      effectiveWorkflows: workflows.effective,
      effectivePhases: phases.effective,
      startedAt: 1_700_000_000_000,
      boundInputs: {
        'feature-brief': {
          portId: 'feature-brief',
          type: 'text',
          value: 'Consolidate onto Phase + Workflow'
        }
      }
    });
    expect(createdRoot.outcome).toBe('created');
    if (createdRoot.outcome !== 'created') return;

    expect(createdRoot.run.frozenClosure?.rootWorkflowId).toBe('delivery-root');
    expect(Object.keys(createdRoot.run.frozenClosure?.workflowsById ?? {}).sort()).toEqual([
      'delivery-plan-and-verify',
      'delivery-root',
      'delivery-verify-leaf'
    ]);
    expect(Object.keys(createdRoot.run.frozenClosure?.phasesById ?? {}).sort()).toEqual([
      'delivery-check-phase',
      'delivery-draft-phase',
      'delivery-plan-phase'
    ]);

    const runStore = createInMemoryRunStore(createdRoot.run);
    const dispatchedAttempts: PhaseAttemptDispatchInput[] = [];
    const childStates = new Map<string, 'in-flight' | 'completed' | 'failed' | 'canceled'>();
    let queueSeq = 0;

    const coordinatorDeps = {
      connectedRuns: runStore,
      dispatchPhase: async (input: PhaseAttemptDispatchInput) => {
        dispatchedAttempts.push(input);
        queueSeq += 1;
        const queueItemId = `q-item-${queueSeq}`;
        childStates.set(queueItemId, 'in-flight');
        return { outcome: 'dispatched' as const, queueItemId };
      }
    };

    // Step 3a: Dispatch root entry node `draft-spec` (Phase `delivery-draft-phase`).
    const step1 = await dispatchComposableNode(coordinatorDeps, {
      run: runStore.current(),
      invocationId: createdRoot.rootInvocationId,
      nodeId: 'draft-spec',
      startedAt: 1_700_000_001_000
    });
    expect(step1.outcome).toBe('phase-dispatched');
    if (step1.outcome !== 'phase-dispatched') return;
    expect(step1.nodeId).toBe('draft-spec');

    // Step 3b: Complete `draft-spec` -> transitions to child workflow node `plan-and-verify`
    // (`delivery-plan-and-verify`), which immediately enters its `startNodeIds[0]` (`author-plan`).
    childStates.set(step1.queueItemId, 'completed');
    const step2 = await completeComposableNodeAttempt(coordinatorDeps, {
      run: runStore.current(),
      invocationId: step1.invocationId,
      nodeId: 'draft-spec',
      status: 'completed',
      completedAt: 1_700_000_002_000,
      declaredOutputs: {
        summary: { portId: 'summary', type: 'text', value: 'specs/266/spec.md' }
      }
    });
    expect(step2.outcome).toBe('phase-dispatched');
    if (step2.outcome !== 'phase-dispatched') return;
    expect(step2.nodeId).toBe('author-plan');
    const midInvocationId = step2.invocationId;
    expect(runStore.current().invocations?.[midInvocationId]?.workflowId).toBe(
      'delivery-plan-and-verify'
    );
    expect(runStore.current().invocations?.[midInvocationId]?.depth).toBe(1);
    expect(runStore.current().invocations?.[midInvocationId]?.nodePath).toBe(
      '/plan-and-verify/author-plan'
    );

    // Step 3c: Complete `author-plan` -> enters grandchild workflow node `pre-verify`
    // (`delivery-verify-leaf` occurrence #1 at depth 2).
    childStates.set(step2.queueItemId, 'completed');
    const step3 = await completeComposableNodeAttempt(coordinatorDeps, {
      run: runStore.current(),
      invocationId: midInvocationId,
      nodeId: 'author-plan',
      status: 'completed',
      completedAt: 1_700_000_003_000,
      declaredOutputs: {
        plan: { portId: 'plan', type: 'text', value: 'specs/266/plan.md' }
      }
    });
    expect(step3.outcome).toBe('phase-dispatched');
    if (step3.outcome !== 'phase-dispatched') return;
    expect(step3.nodeId).toBe('run-check');
    const firstLeafInvocationId = step3.invocationId;
    const firstLeafFrame = runStore.current().invocations?.[firstLeafInvocationId];
    expect(firstLeafFrame?.workflowId).toBe('delivery-verify-leaf');
    expect(firstLeafFrame?.depth).toBe(2);
    expect(firstLeafFrame?.nodePath).toBe('/plan-and-verify/author-plan/pre-verify/run-check');

    // Step 3d: Complete `run-check` in occurrence #1 -> returns from `delivery-verify-leaf`,
    // returns from `delivery-plan-and-verify`, and enters `final-verify` on `delivery-root`
    // (`delivery-verify-leaf` occurrence #2 at depth 1).
    childStates.set(step3.queueItemId, 'completed');
    const step4 = await completeComposableNodeAttempt(coordinatorDeps, {
      run: runStore.current(),
      invocationId: firstLeafInvocationId,
      nodeId: 'run-check',
      status: 'completed',
      completedAt: 1_700_000_004_000,
      declaredOutputs: {
        note: { portId: 'note', type: 'markdown', value: 'plan-verified' }
      }
    });
    expect(step4.outcome).toBe('phase-dispatched');
    if (step4.outcome !== 'phase-dispatched') return;
    expect(step4.nodeId).toBe('run-check');
    const secondLeafInvocationId = step4.invocationId;
    expect(secondLeafInvocationId).not.toBe(firstLeafInvocationId);
    const secondLeafFrame = runStore.current().invocations?.[secondLeafInvocationId];
    expect(secondLeafFrame?.workflowId).toBe('delivery-verify-leaf');
    expect(secondLeafFrame?.depth).toBe(1);
    expect(secondLeafFrame?.nodePath).toBe('/final-verify/run-check');

    // Step 3e: Complete `run-check` in occurrence #2 -> completes `delivery-root`.
    childStates.set(step4.queueItemId, 'completed');
    const step5 = await completeComposableNodeAttempt(coordinatorDeps, {
      run: runStore.current(),
      invocationId: secondLeafInvocationId,
      nodeId: 'run-check',
      status: 'completed',
      completedAt: 1_700_000_005_000,
      declaredOutputs: {
        note: { portId: 'note', type: 'markdown', value: 'delivery-verified' }
      }
    });
    expect(step5.outcome).toBe('workflow-completed');
    if (step5.outcome !== 'workflow-completed') return;
    expect(step5.outputs).toEqual({
      'delivery-report': {
        portId: 'delivery-report',
        type: 'markdown',
        value: 'delivery-verified'
      }
    });

    // Verify hierarchical projection preserves both `delivery-verify-leaf` invocations with distinct paths.
    const completedProjection = projectConnectedRun(
      runStore.current(),
      (queueItemId) => childStates.get(queueItemId) ?? null
    );
    expect(completedProjection.rootInvocationId).toBe(createdRoot.rootInvocationId);
    const leafProjections =
      completedProjection.invocations?.filter((inv) => inv.workflowId === 'delivery-verify-leaf') ??
      [];
    expect(leafProjections).toHaveLength(2);
    expect(new Set(leafProjections.map((inv) => inv.nodePath)).size).toBe(2);
    expect(new Set(leafProjections.map((inv) => inv.invocationId)).size).toBe(2);

    // 4. Launch child Workflow `delivery-verify-leaf` independently as a root invocation.
    const standaloneLeaf = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-delivery-leaf-standalone',
      workflow: leafWorkflow,
      effectiveWorkflows: workflows.effective,
      effectivePhases: phases.effective,
      startedAt: 1_700_000_010_000,
      boundInputs: {
        'artifact-text': { portId: 'artifact-text', type: 'text', value: 'specs/266/tasks.md' }
      }
    });
    expect(standaloneLeaf.outcome).toBe('created');
    if (standaloneLeaf.outcome !== 'created') return;
    expect(standaloneLeaf.run.frozenClosure?.rootWorkflowId).toBe('delivery-verify-leaf');
    expect(standaloneLeaf.run.invocations?.[standaloneLeaf.rootInvocationId]?.depth).toBe(0);

    // 5. Exercise invocation-scoped `pause`, `resume`, and `cancel` via `WorkflowControlService`.
    const controlledRunInit = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-delivery-controlled',
      workflow: leafWorkflow,
      effectiveWorkflows: workflows.effective,
      effectivePhases: phases.effective,
      startedAt: 1_700_000_020_000,
      boundInputs: {
        'artifact-text': { portId: 'artifact-text', type: 'text', value: 'specs/266/spec.md' }
      }
    });
    expect(controlledRunInit.outcome).toBe('created');
    if (controlledRunInit.outcome !== 'created') return;

    const controlledStore = createInMemoryRunStore(controlledRunInit.run);
    const controlService = new WorkflowControlService({
      connectedRuns: controlledStore,
      dispatchPhase: async () => {
        queueSeq += 1;
        const queueItemId = `q-item-${queueSeq}`;
        childStates.set(queueItemId, 'in-flight');
        return { outcome: 'dispatched' as const, queueItemId };
      }
    });

    const dispatchedLeaf = await dispatchComposableNode(
      {
        connectedRuns: controlledStore,
        dispatchPhase: async () => {
          queueSeq += 1;
          const queueItemId = `q-item-${queueSeq}`;
          childStates.set(queueItemId, 'in-flight');
          return { outcome: 'dispatched' as const, queueItemId };
        }
      },
      {
        run: controlledStore.current(),
        invocationId: controlledRunInit.rootInvocationId,
        nodeId: 'run-check',
        startedAt: 1_700_000_021_000
      }
    );
    expect(dispatchedLeaf.outcome).toBe('phase-dispatched');

    const paused = await controlService.executeCommand({
      runId: 'run-delivery-controlled',
      commandId: 'cmd-pause-1',
      expectedRevision: controlledStore.current().revision,
      operation: 'pause',
      targetInvocationId: controlledRunInit.rootInvocationId,
      now: 1_700_000_022_000
    });
    expect(paused.accepted).toBe(true);
    if (!paused.accepted) return;
    expect(paused.projection.status).toBe('paused');

    const resumed = await controlService.executeCommand({
      runId: 'run-delivery-controlled',
      commandId: 'cmd-resume-1',
      expectedRevision: controlledStore.current().revision,
      operation: 'resume',
      targetInvocationId: controlledRunInit.rootInvocationId,
      now: 1_700_000_023_000
    });
    expect(resumed.accepted).toBe(true);
    if (!resumed.accepted) return;
    expect(resumed.projection.status).toBe('in-flight');

    const canceled = await controlService.executeCommand({
      runId: 'run-delivery-controlled',
      commandId: 'cmd-cancel-1',
      expectedRevision: controlledStore.current().revision,
      operation: 'cancel',
      targetInvocationId: controlledRunInit.rootInvocationId,
      now: 1_700_000_024_000
    });
    expect(canceled.accepted).toBe(true);
    if (!canceled.accepted) return;
    expect(canceled.projection.status).toBe('canceled');

    // 5b. Exercise `retry-invocation` on the canceled invocation and `WorkflowRecoveryService`.
    const retriedInvocation = await controlService.executeCommand({
      runId: 'run-delivery-controlled',
      commandId: 'cmd-retry-inv-1',
      expectedRevision: controlledStore.current().revision,
      operation: 'retry-invocation',
      targetInvocationId: controlledRunInit.rootInvocationId,
      now: 1_700_000_025_000
    });
    expect(retriedInvocation.accepted).toBe(true);
    if (!retriedInvocation.accepted) return;
    expect(retriedInvocation.projection.status).toBe('in-flight');

    const recoveryService = new WorkflowRecoveryService({
      connectedRuns: {
        get: (id) => controlledStore.get(id),
        list: () => [controlledStore.current()],
        compareAndSetConnectedRun: (next, rev) =>
          controlledStore.compareAndSetConnectedRun(next, rev)
      },
      dispatchPhase: async () => ({ outcome: 'dispatched', queueItemId: 'q-recovered' }),
      checkDurableAttemptEvidence: () => ({
        completed: true,
        status: 'completed',
        declaredOutputs: {
          note: { portId: 'note', type: 'markdown', value: 'recovered-check-ok' }
        },
        completedAt: 1_700_000_026_000
      })
    });
    const reconciled = await recoveryService.reconcileAllRuns(1_700_000_026_000);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.disposition?.status).toBe('settled-from-evidence');
    expect(reconciled[0]?.projection.status).toBe('completed');

    // 6. Export `delivery-root` with `include-closure` and re-import into a fresh empty store.
    const exported = selectProcessExportDocument(
      {
        logger: {
          warn: () => undefined,
          sanitize: (msg: string) => msg
        },
        readPhaseConfig: () => ({
          rows: harness.store.rowsOf('phase'),
          revision: harness.store.revisionOf('phase')
        }),
        readWorkflowConfig: () => ({
          rows: harness.store.rowsOf('workflow'),
          revision: harness.store.revisionOf('workflow')
        }),
        readModelsConfig: () => ({ claude: [], codex: [], agy: [] })
      },
      {
        resourceKind: 'workflow',
        resourceId: 'delivery-root',
        inclusion: 'include-closure'
      }
    );
    expect(exported.outcome).toBe('resolved');
    if (exported.outcome !== 'resolved') return;

    const roundTripHarness = buildCleanInstallHarness();
    const roundTripPreflight = await roundTripHarness.preflight(exported.text);
    expect(roundTripPreflight.outcome).toBe('planned');
    if (roundTripPreflight.outcome !== 'planned') return;
    expect(roundTripPreflight.plan.counts).toEqual({
      import: 6,
      skip: 0,
      blocked: 0,
      invalid: 0
    });
    const roundTripAcks = await roundTripHarness.publishPlannedPackage(roundTripPreflight.plan);
    expect(roundTripAcks[0]?.status).toBe('accepted');
  });

  it('refuses a legacy kind: Pipeline YAML document at preflight with unsupported-kind and leaves the empty catalog untouched', async () => {
    const harness = buildCleanInstallHarness();
    const legacyPipelineYaml = [
      'apiVersion: schegent/v1',
      'kind: Pipeline',
      'metadata:',
      '  id: legacy-pipeline',
      '  name: Legacy Pipeline',
      '  version: 1',
      'spec:',
      '  phases:',
      '    - some-phase',
      ''
    ].join('\n');

    const result = await harness.preflight(legacyPipelineYaml);
    expect(result).toEqual({
      outcome: 'refused',
      refusal: {
        code: 'unsupported-kind',
        message: expect.stringContaining('Pipeline')
      }
    });
    expect(writesOf(harness.store)).toEqual(NO_WRITES);
    expect(harness.store.rowsOf('phase')).toEqual([]);
    expect(harness.store.rowsOf('workflow')).toEqual([]);
  });
});
