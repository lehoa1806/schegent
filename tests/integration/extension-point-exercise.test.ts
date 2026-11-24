/**
 * FR-R8-04 (`04-05`) — Extension-point exercise proving:
 * 1. Adding a new multi-phase authored Workflow over existing Phases via
 *    `schegent/v1` YAML -> `parseDocumentBytes` -> `parseWorkflowPackage` ->
 *    normal `ProductionWorkflowComposition` (`launchWorkflow` +
 *    `recordConnectedWorkflowTransition`) requires zero host code changes.
 * 2. Exercising a test-only backend profile (`test-echo-backend`) strictly
 *    inside `tests/` across production descriptor validation, permission
 *    posture, `ResultOperator` contract parsing, `evaluateSpend` units and
 *    missing-usage handling (no synthetic zero), `AbortSignal` cancellation,
 *    bounded `ZippedStreamBuffer` output caps, and actionable refusal on
 *    missing declarations (`ProductionWorkflowComposition.verifyPreAdmission`).
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordConnectedWorkflowTransition } from '../../src/activation/run-safety-wiring';
import {
  BACKEND_DESCRIPTORS,
  type AuditPermissionMode,
  type BackendContainmentMechanism,
  type SpendDenomination
} from '../../src/contracts/backend-descriptors';
import type { BackendRunner } from '../../src/contracts/backend-runner';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import type { PipelineCatalog } from '../../src/config/pipeline-config';
import { SanitizedLogger } from '../../src/lib/logger';
import { extractInvocationUsageMetrics } from '../../src/parser/invocation-usage';
import { QueueManager } from '../../src/queue/queue-manager';
import { SpawnGatedRunner } from '../../src/runner/spawn-gated-runner';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import { resolveUncontainedGrant } from '../../src/services/backend-containment-policy';
import { ContainmentAdmissionRefusedError } from '../../src/services/containment-qualification/admission-refusal';
import { createSpawnAdmissionGate } from '../../src/services/containment-qualification/spawn-admission-gate';
import { GuardedRunService } from '../../src/services/guarded-run-service';
import { preflightProcessDocument } from '../../src/services/process-yaml/preflight-service';
import { parseDocumentBytes } from '../../src/services/process-yaml/yaml-parser';
import { parseWorkflowPackage } from '../../src/services/process-yaml/workflow-document';
import { ResultOperator } from '../../src/services/result-operator';
import { evaluateSpend } from '../../src/services/spend-bound';
import {
  createProductionWorkflowComposition,
  registerProductionWorkflowComposition,
  unregisterProductionWorkflowComposition
} from '../../src/services/workflow-execution/production-workflow-composition';
import { launchWorkflow } from '../../src/services/workflow-execution/workflow-launcher';
import { resolveRootInvocationId } from '../../src/state/connected-workflow-run';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { WorkspaceLockManager, type Scheduler } from '../../src/state/lock';
import { createDiskOwnershipFs } from '../../src/state/ownership-fs';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { removeTempRoot } from '../temp-root-cleanup';

const noopScheduler: Scheduler = {
  setInterval() {
    return { clear() {} };
  }
};

function createMemoryMemento(): Memento {
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

function makeEmptyCatalog(): PipelineCatalog {
  return {
    phases: [],
    pipelines: [],
    models: { claude: [], codex: [], agy: [] },
    defaultPipelineId: 'default',
    phasesById: new Map(),
    pipelinesById: new Map()
  };
}

interface TestBackendProfile {
  readonly kind: string;
  readonly displayLabel: string;
  readonly containmentMechanism: BackendContainmentMechanism | null;
  readonly defaultAuditPermissionMode: AuditPermissionMode | null;
  readonly unboundedFlags: readonly string[] | null;
  readonly spendDenomination: SpendDenomination | null;
  readonly qualifiedCliVersion: string | null;
  readonly maxOutputBytes: number;
}

function validateTestBackendProfile(
  profile: Partial<TestBackendProfile>
):
  | { readonly ok: true; readonly profile: TestBackendProfile }
  | { readonly ok: false; readonly missingFields: readonly string[]; readonly message: string } {
  const missing: string[] = [];
  if (typeof profile.kind !== 'string' || profile.kind.trim().length === 0) missing.push('kind');
  if (profile.containmentMechanism === undefined || profile.containmentMechanism === null) {
    missing.push('containmentMechanism');
  }
  if (profile.defaultAuditPermissionMode === undefined || profile.defaultAuditPermissionMode === null) {
    missing.push('defaultAuditPermissionMode');
  }
  if (!Array.isArray(profile.unboundedFlags)) missing.push('unboundedFlags');
  if (profile.spendDenomination === undefined || profile.spendDenomination === null) {
    missing.push('spendDenomination');
  }
  if (typeof profile.qualifiedCliVersion !== 'string' || profile.qualifiedCliVersion.trim().length === 0) {
    missing.push('qualifiedCliVersion');
  }
  if (missing.length > 0) {
    return {
      ok: false,
      missingFields: Object.freeze(missing),
      message: `Backend profile "${profile.kind ?? '<unnamed>'}" refused: missing required declaration(s): ${missing.join(', ')}.`
    };
  }
  return { ok: true, profile: profile as TestBackendProfile };
}

function createTestEchoRunner(profile: TestBackendProfile): BackendRunner {
  let active = false;
  return {
    get hasActiveProcess(): boolean {
      return active;
    },
    async invoke(request) {
      const stdoutBuffer = new ZippedStreamBuffer(
        Math.max(1, Math.floor(profile.maxOutputBytes / 2)),
        profile.maxOutputBytes
      );
      const stderrBuffer = new ZippedStreamBuffer(
        Math.max(1, Math.floor(profile.maxOutputBytes / 2)),
        profile.maxOutputBytes
      );
      const cancelSignal = request.cancellationSignal;
      active = true;

      try {
        if (cancelSignal?.aborted) {
          stdoutBuffer.finalize();
          stderrBuffer.finalize();
          return {
            stdoutBuffer,
            stderrBuffer,
            exitCode: null,
            killed: true,
            timedOut: false,
            durationMs: 0
          };
        }

        if (request.prompt.includes('WAIT_FOR_ABORT') && cancelSignal !== undefined) {
          await new Promise<void>((resolve) => {
            const onAbort = (): void => {
              cancelSignal.removeEventListener?.('abort', onAbort);
              resolve();
            };
            cancelSignal.addEventListener('abort', onAbort);
          });
          stdoutBuffer.finalize();
          stderrBuffer.finalize();
          return {
            stdoutBuffer,
            stderrBuffer,
            exitCode: null,
            killed: true,
            timedOut: false,
            durationMs: 1
          };
        }

        const payload = request.prompt.includes('LARGE_OUTPUT')
          ? 'X'.repeat(profile.maxOutputBytes * 3)
          : JSON.stringify({ attemptId: request.attemptId ?? 'att-1', verdict: 'pass' });
        stdoutBuffer.append(payload);
        stdoutBuffer.finalize();
        stderrBuffer.finalize();

        return {
          stdoutBuffer,
          stderrBuffer,
          exitCode: 0,
          killed: false,
          timedOut: false,
          durationMs: 1
        };
      } finally {
        active = false;
      }
    },
    cancelActive(): boolean {
      return false;
    },
    close(): void {},
    async settleTeardowns() {
      return [];
    }
  };
}

describe('FR-R8-04 (04-05) — workflow and test-backend extension-point exercise', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root !== undefined) await removeTempRoot(root);
    }
  });

  it('authors, preflights against existing catalog Phases, refuses missing Phase declarations, and executes a new multi-phase Workflow via ProductionWorkflowComposition without host edits', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-r8-0405-wf-'));
    tempRoots.push(tmpRoot);
    const workspaceRoot = path.join(tmpRoot, 'ws');
    await fs.mkdir(workspaceRoot, { recursive: true });

    const existingCatalogPhases: readonly PhaseDefinition[] = [
      { phaseId: 'ext-draft', version: 1, name: 'Extension Draft', runner: 'claude', instruction: 'Draft artifact' },
      { phaseId: 'ext-verify', version: 1, name: 'Extension Verify', runner: 'claude', instruction: 'Verify artifact' }
    ];

    const exampleYaml = [
      'apiVersion: schegent/v1',
      'kind: Workflow',
      'metadata:',
      '  id: ext-two-phase-review',
      '  name: Extension Exercise Workflow',
      '  version: 1',
      'spec:',
      '  startNodeIds:',
      '    - draft',
      '  nodes:',
      '    - nodeId: draft',
      '      kind: phase',
      '      phaseId: ext-draft',
      '      label: Draft Node',
      '    - nodeId: verify',
      '      kind: phase',
      '      phaseId: ext-verify',
      '      label: Verify Node',
      '  connections:',
      '    - from:',
      '        nodeId: draft',
      '      to:',
      '        kind: node',
      '        nodeId: verify',
      '      handoff: auto',
      '      priority: 0',
      '    - from:',
      '        nodeId: verify',
      '      to:',
      '        kind: return',
      '      handoff: auto',
      '      priority: 0'
    ].join('\n');

    const logger = new SanitizedLogger();
    const preflightDeps = {
      logger,
      readPhaseConfig: () => ({
        rows: [...existingCatalogPhases],
        revision: 'rev-phases-1'
      }),
      readWorkflowConfig: () => ({ rows: [], revision: 'rev-wf-0' })
    };

    // Real production preflight over pre-existing catalog Phases succeeds with 1 workflow import
    const planned = await preflightProcessDocument(preflightDeps, {
      bytes: Buffer.from(exampleYaml, 'utf8')
    });
    expect(planned.outcome).toBe('planned');
    if (planned.outcome !== 'planned') return;
    expect(planned.plan.counts.import).toBe(1);
    expect(planned.plan.counts.blocked).toBe(0);
    expect(planned.plan.counts.invalid).toBe(0);

    // Negative preflight: referencing an undeclared Phase yields an actionable blocked row
    const missingPhaseYaml = exampleYaml.replace('phaseId: ext-verify', 'phaseId: ext-undeclared-phase');
    const missingPlanned = await preflightProcessDocument(preflightDeps, {
      bytes: Buffer.from(missingPhaseYaml, 'utf8')
    });
    expect(missingPlanned.outcome).toBe('planned');
    if (missingPlanned.outcome === 'planned') {
      expect(missingPlanned.plan.counts.import).toBe(0);
      expect(missingPlanned.plan.counts.blocked).toBe(1);
    }

    const tree = parseDocumentBytes(Buffer.from(exampleYaml, 'utf8'));
    expect(tree.ok).toBe(true);
    if (!tree.ok) return;

    const pkg = parseWorkflowPackage(tree.node);
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;

    const workflows: WorkflowDefinition[] = [];
    for (const res of pkg.resources) {
      if (res.ok && res.resourceKind === 'workflow') workflows.push(res.definition);
    }
    expect(workflows).toHaveLength(1);
    const phases = [...existingCatalogPhases];

    const ownershipDir = path.join(workspaceRoot, '.schegent', 'ownership');
    const store = new WorkspaceStateStore(createMemoryMemento());
    store.useOwnershipStorage(createDiskOwnershipFs({ workspaceRoot, ownershipDir }), ownershipDir);
    await store.initialize();
    const lock = new WorkspaceLockManager(store, 'win-primary', { now: () => Date.now() }, noopScheduler);
    const acquired = await lock.tryAcquire();
    expect(acquired.acquired).toBe(true);
    store.bindPrimacyClaimSource(lock);
    const lease = new ExecutionLeaseManager(store, 'win-primary', { now: () => Date.now() }, noopScheduler);
    store.bindRunClaimSource(lease);
    expect((await lease.tryAcquire('default')).acquired).toBe(true);
    const queue = new QueueManager(store);
    const guardedRun = new GuardedRunService({
      isWorkspaceTrusted: () => true,
      lock,
      queue,
      controller: { getCatalog: makeEmptyCatalog },
      logger,
      store,
      catalogProvider: makeEmptyCatalog
    });
    const composition = createProductionWorkflowComposition({ store, workspaceRoot });
    registerProductionWorkflowComposition(store, composition);

    try {
      const launched = await launchWorkflow(
        {
          connectedRuns: store,
          isChildSettled: () => true,
          productionComposition: composition,
          logger,
          guardedRun
        },
        {
          connectedRunId: 'conn-ext-wf-1',
          workflow: workflows.at(0)!,
          catalog: makeEmptyCatalog(),
          effectiveWorkflows: workflows,
          effectivePhases: phases,
          startNodeId: 'draft',
          request: { pipelineId: 'ext-draft', inputs: [], supplemental: [], outputs: [] },
          workspaceRoot,
          startedAt: 1_000
        }
      );
      expect(launched.outcome).toBe('started');
      if (launched.outcome !== 'started') return;

      const draftTerminal: WorkflowRun = {
        id: `run-${launched.queueItemId}`,
        featureId: launched.queueItemId,
        featureDir: `specs/${launched.queueItemId}`,
        status: 'completed',
        currentPhase: 'ext-draft',
        currentIteration: 1,
        startedAt: 1_000,
        lastTransitionAt: 1_500,
        phasesCompleted: [
          {
            phase: 'ext-draft',
            iteration: 1,
            startedAt: 1_000,
            endedAt: 1_500,
            result: 'clean',
            terminationReason: 'token',
            exitCode: 0,
            stdoutSummary: '',
            stderrSummary: '',
            auditEntryId: null
          }
        ],
        lastError: null,
        pendingRetryAt: null,
        pendingRetryCause: null,
        creditPause: null,
        delayedRetryCount: 0,
        manualPauseAt: null,
        manualPauseCause: null,
        phaseOverrides: [],
        phaseBreakpoints: [],
        resumeTargetPhaseId: null
      };
      await store.setRun('default', draftTerminal, store.runClaimFor('default')!);

      await recordConnectedWorkflowTransition(
        {
          store,
          getGuardedRun: () => guardedRun,
          logger,
          workspaceRoot,
          productionComposition: composition
        },
        draftTerminal
      );

      const afterDraft = store.getConnectedRun('conn-ext-wf-1')!;
      const rootFrame = afterDraft.invocations?.[resolveRootInvocationId(afterDraft)];
      expect(rootFrame?.attemptsByNodeId['verify']?.length).toBe(1);
    } finally {
      unregisterProductionWorkflowComposition(store, composition);
      composition.dispose();
      await lease.releaseAll();
      await lock.release();
    }
  });

  it('exercises a test-only backend profile through descriptor, permission, result parser, missing usage, cancellation, output bounds, and actionable qualification refusal seams', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-r8-0405-backend-'));
    tempRoots.push(tmpRoot);

    expect(Object.keys(BACKEND_DESCRIPTORS).sort()).toEqual(['agy', 'claude', 'codex']);

    const incomplete = validateTestBackendProfile({ kind: 'test-incomplete-backend', displayLabel: 'Incomplete' });
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) {
      expect(incomplete.missingFields).toEqual([
        'containmentMechanism',
        'defaultAuditPermissionMode',
        'unboundedFlags',
        'spendDenomination',
        'qualifiedCliVersion'
      ]);
      expect(incomplete.message).toContain('missing required declaration(s)');
    }

    const validated = validateTestBackendProfile({
      kind: 'test-echo-backend',
      displayLabel: 'Test Echo',
      containmentMechanism: 'none',
      defaultAuditPermissionMode: 'unrestricted',
      unboundedFlags: ['--allow-all'],
      spendDenomination: 'tokens',
      qualifiedCliVersion: '0.1.0-test',
      maxOutputBytes: 256
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const runner = createTestEchoRunner(validated.profile);

    // Production identity/policy check: unregistered test backend id is refused with actionable problem message
    const grantEval = resolveUncontainedGrant([validated.profile.kind]);
    expect(grantEval.granted.size).toBe(0);
    expect(grantEval.problems).toHaveLength(1);
    expect(grantEval.problems.at(0)?.problem).toBe('unsupported');
    expect(grantEval.problems.at(0)?.message).toContain('claude, codex, agy');

    // Real production SpawnGatedRunner + createSpawnAdmissionGate exercising trust, permission/containment grant, and AbortSignal cancellation
    let trusted = false;
    let grantedUncontained = false;
    let innerInvokeCount = 0;
    const countedRunner: BackendRunner = {
      get hasActiveProcess() {
        return runner.hasActiveProcess;
      },
      async invoke(req, sink) {
        innerInvokeCount += 1;
        return runner.invoke(req, sink);
      },
      cancelActive: () => runner.cancelActive(),
      close: () => runner.close(),
      settleTeardowns: (deadline) => runner.settleTeardowns(deadline)
    };
    const spawnGate = createSpawnAdmissionGate({
      isTrusted: () => trusted,
      hasPrimacy: () => true,
      resolveExecutable: async () => 'resolved',
      observeVersion: async () => '0.1.0-test',
      granted: () => (grantedUncontained ? new Set(['agy' as const]) : new Set()),
      bindings: {
        read: () => null,
        bind: async () => undefined
      },
      platform: { os: process.platform, arch: process.arch },
      environmentPolicyDigest: () => 'digest-test-0405',
      logger: { warn: () => undefined }
    });
    const gatedRunner = new SpawnGatedRunner('agy', countedRunner, spawnGate);

    await expect(
      gatedRunner.invoke({
        prompt: 'NORMAL_RESULT',
        cliPath: 'test-echo',
        cwd: tmpRoot,
        phase: 'implement',
        iteration: 1,
        timeoutMs: 5_000,
        attemptId: 'att-ext-untrusted'
      })
    ).rejects.toBeInstanceOf(ContainmentAdmissionRefusedError);
    expect(innerInvokeCount).toBe(0);

    trusted = true;
    await expect(
      gatedRunner.invoke({
        prompt: 'NORMAL_RESULT',
        cliPath: 'test-echo',
        cwd: tmpRoot,
        phase: 'implement',
        iteration: 1,
        timeoutMs: 5_000,
        attemptId: 'att-ext-ungranted'
      })
    ).rejects.toBeInstanceOf(ContainmentAdmissionRefusedError);
    expect(innerInvokeCount).toBe(0);

    grantedUncontained = true;
    const resultPath = 'ext-result.json';
    const invokeOk = await gatedRunner.invoke({
      prompt: 'NORMAL_RESULT',
      cliPath: 'test-echo',
      cwd: tmpRoot,
      phase: 'implement',
      iteration: 1,
      timeoutMs: 5_000,
      attemptId: 'att-ext-1'
    });
    expect(innerInvokeCount).toBe(1);
    expect(invokeOk.exitCode).toBe(0);
    const stdoutText = Array.from(invokeOk.stdoutBuffer.decompressStream()).join('');
    await fs.writeFile(path.join(tmpRoot, resultPath), stdoutText, 'utf8');

    const operator = new ResultOperator();
    const parsed = await operator.evaluateWithPrecedence({
      attemptId: 'att-ext-1',
      workspaceRoot: tmpRoot,
      resultContract: {
        version: 1,
        operator: 'structured-result',
        operatorVersion: 1,
        source: { kind: 'declared-output', outputKey: 'out' },
        fields: [
          {
            fieldId: 'verdict',
            type: 'string',
            required: true,
            selector: ['verdict']
          }
        ],
        completion: {
          version: 1,
          kind: 'typed',
          test: {
            left: { source: 'result-field', fieldId: 'verdict' },
            operator: 'equals',
            right: 'pass'
          }
        }
      },
      declaredOutputsByKey: { out: resultPath }
    });
    expect(parsed.kind).toBe('outcome');
    if (parsed.kind === 'outcome') {
      expect(parsed.outcome.status).toBe('done');
      expect(parsed.outcome.values.verdict).toBe('pass');
    }

    // Real production usage parser -> spend evaluator seam: missing usage never becomes synthetic 0
    const parsedMissingUsage = extractInvocationUsageMetrics(invokeOk.stdoutBuffer, 'codex');
    expect(parsedMissingUsage).toBeNull();
    const missingSpend = evaluateSpend(
      {
        costUsd: parsedMissingUsage?.totalCostUsd,
        totalTokens:
          parsedMissingUsage !== null &&
          (parsedMissingUsage.inputTokens !== undefined || parsedMissingUsage.outputTokens !== undefined)
            ? (parsedMissingUsage.inputTokens ?? 0) + (parsedMissingUsage.outputTokens ?? 0)
            : undefined,
        completeness: { kind: 'complete' },
        countedRowIds: new Set()
      },
      { limitUsd: null, limitTokens: 10_000 },
      validated.profile.spendDenomination!
    );
    expect(missingSpend).toEqual({
      kind: 'unmeasurable',
      denomination: 'tokens',
      reason: 'value-absent'
    });

    const usageBuffer = new ZippedStreamBuffer(1024, 4096);
    usageBuffer.append(
      `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 8_000, output_tokens: 4_500 } })}\n`
    );
    usageBuffer.finalize();
    const parsedUsage = extractInvocationUsageMetrics(usageBuffer, 'codex');
    expect(parsedUsage).toMatchObject({ inputTokens: 8_000, outputTokens: 4_500 });
    const crossedSpend = evaluateSpend(
      {
        costUsd: undefined,
        totalTokens: (parsedUsage?.inputTokens ?? 0) + (parsedUsage?.outputTokens ?? 0),
        completeness: { kind: 'complete' },
        countedRowIds: new Set()
      },
      { limitUsd: null, limitTokens: 10_000 },
      validated.profile.spendDenomination!
    );
    expect(crossedSpend.kind).toBe('exceeded');

    // AbortSignal cancellation verified through real SpawnGatedRunner
    const abortCtrl = new AbortController();
    const cancelPromise = gatedRunner.invoke({
      prompt: 'WAIT_FOR_ABORT',
      cliPath: 'test-echo',
      cwd: tmpRoot,
      phase: 'implement',
      iteration: 1,
      timeoutMs: 5_000,
      cancellationSignal: abortCtrl.signal
    });
    abortCtrl.abort();
    const canceled = await cancelPromise;
    expect(canceled.killed).toBe(true);

    const large = await gatedRunner.invoke({
      prompt: 'LARGE_OUTPUT',
      cliPath: 'test-echo',
      cwd: tmpRoot,
      phase: 'implement',
      iteration: 1,
      timeoutMs: 5_000
    });
    expect(large.stdoutBuffer.truncated).toBe(true);
    expect(large.stdoutBuffer.highWaterRetainedBytes).toBeLessThanOrEqual(512);

    const composition = createProductionWorkflowComposition({ workspaceRoot: tmpRoot });
    const refusalCheck = composition.verifyPreAdmission({
      entryPointId: 'ui.launchWorkflow',
      rootExecutionId: 'conn-ext-qual',
      requiredCapabilities: [
        {
          backendId: validated.profile.kind,
          capability: 'strict-cost',
          requireLiveQualification: true
        }
      ],
      isWorkspaceTrusted: true,
      isFenceValid: true
    });
    expect(refusalCheck.allowed).toBe(false);
    if (!refusalCheck.allowed) {
      expect(refusalCheck.refusal.category).toBe('unsupported-capability');
      expect(refusalCheck.refusal.attemptsConsumed).toBe(0);
      expect(refusalCheck.refusal.message.length).toBeGreaterThan(10);
    }
    composition.dispose();
  });
});
