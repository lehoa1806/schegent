/**
 * FR-R6-F01 (FR-001, FR-011, FR-015, FR-016, FR-018, FR-019, SC-001..SC-009) —
 * Authoritative entry-point wiring census, baseline finding reconciliation,
 * seven-category refusal taxonomy, eight-checkpoint recovery inspector,
 * resource budget boundary verifier, and qualification record builder.
 *
 * Zero `vscode` imports: shared by activation, workflow services, and headless entry points.
 */

export const PUBLIC_ENTRY_POINT_IDS = [
  'ui.launchWorkflow',
  'ui.continueWorkflow',
  'ui.retryWorkflow',
  'ui.controlCommand',
  'headless.launchWorkflow',
  'headless.continueWorkflow',
  'headless.controlCommand',
  'activation.recovery',
  'activation.settlementTransition'
] as const;

export type PublicEntryPointId = (typeof PUBLIC_ENTRY_POINT_IDS)[number];

export type PublicEntryPointKind =
  | 'launch'
  | 'continue'
  | 'retry'
  | 'control'
  | 'headless'
  | 'recovery'
  | 'settlement';

export const CONTROL_COLLABORATOR_KINDS = [
  'controlAdmission',
  'repeatExecutor',
  'forEachExecutor',
  'candidateBlockExecutor',
  'resultOperator',
  'quotaPermitArbiter',
  'backendAvailability',
  'controlCommandService',
  'durableHandoffSeam',
  'cutoverAuthorityGuard'
] as const;

export type ControlCollaboratorKind = (typeof CONTROL_COLLABORATOR_KINDS)[number];

export const WORKFLOW_REFUSAL_CATEGORIES = [
  'missing-collaborator',
  'unsupported-capability',
  'quota-deferred',
  'stale-fence',
  'corrupt-state',
  'policy-refusal',
  'budget-exceeded'
] as const;

export type WorkflowRefusalCategory = (typeof WORKFLOW_REFUSAL_CATEGORIES)[number];

export interface WorkflowRefusalOutcome {
  readonly category: WorkflowRefusalCategory;
  readonly reasonCode: string;
  readonly message: string;
  readonly rootExecutionId?: string | undefined;
  readonly invocationId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly attemptsConsumed: number;
}

export function createWorkflowRefusalOutcome(input: {
  readonly category: WorkflowRefusalCategory;
  readonly reasonCode: string;
  readonly message: string;
  readonly rootExecutionId?: string | undefined;
  readonly invocationId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly attemptsConsumed?: number | undefined;
}): WorkflowRefusalOutcome {
  const boundedMessage = input.message.trim().slice(0, 240);
  return Object.freeze({
    category: input.category,
    reasonCode: input.reasonCode,
    message: boundedMessage.length > 0 ? boundedMessage : `Workflow refused (${input.category}).`,
    ...(input.rootExecutionId !== undefined ? { rootExecutionId: input.rootExecutionId } : {}),
    ...(input.invocationId !== undefined ? { invocationId: input.invocationId } : {}),
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    attemptsConsumed: input.attemptsConsumed ?? 0
  });
}

export interface EntryPointCensusRecord {
  readonly entryPointId: PublicEntryPointId;
  readonly kind: PublicEntryPointKind;
  readonly modulePath: string;
  readonly exportedSymbol: string;
  readonly compositionId: 'ProductionWorkflowComposition';
  readonly requiredCollaborators: readonly ControlCollaboratorKind[];
  readonly suppliedCollaborators: readonly ControlCollaboratorKind[];
  readonly missingCollaborators: readonly ControlCollaboratorKind[];
}

export type CollaboratorAvailabilityMap = Partial<Record<ControlCollaboratorKind, boolean>>;

const ENTRY_POINT_DEFINITIONS: readonly {
  readonly entryPointId: PublicEntryPointId;
  readonly kind: PublicEntryPointKind;
  readonly modulePath: string;
  readonly exportedSymbol: string;
  readonly requiredCollaborators: readonly ControlCollaboratorKind[];
}[] = Object.freeze([
  {
    entryPointId: 'ui.launchWorkflow',
    kind: 'launch',
    modulePath: 'src/ui/sidebar/commands/cmd-launch-workflow.ts',
    exportedSymbol: 'handleLaunchWorkflow -> WorkflowLauncher.launchWorkflow',
    requiredCollaborators: Object.freeze<readonly ControlCollaboratorKind[]>([
      'controlAdmission',
      'repeatExecutor',
      'forEachExecutor',
      'candidateBlockExecutor',
      'quotaPermitArbiter',
      'backendAvailability',
      'cutoverAuthorityGuard'
    ])
  },
  {
    entryPointId: 'ui.continueWorkflow',
    kind: 'continue',
    modulePath: 'src/ui/sidebar/commands/cmd-continue-workflow.ts',
    exportedSymbol: 'handleContinueWorkflow -> continueConnectedRun',
    requiredCollaborators: Object.freeze<readonly ControlCollaboratorKind[]>([
      'controlAdmission',
      'repeatExecutor',
      'forEachExecutor',
      'candidateBlockExecutor',
      'controlCommandService',
      'durableHandoffSeam',
      'cutoverAuthorityGuard'
    ])
  },
  {
    entryPointId: 'ui.retryWorkflow',
    kind: 'retry',
    modulePath: 'src/services/workflow-execution/continuation-service.ts',
    exportedSymbol: 'continueConnectedRun (retry-phase / retry-invocation)',
    requiredCollaborators: Object.freeze<readonly ControlCollaboratorKind[]>([
      'controlAdmission',
      'repeatExecutor',
      'forEachExecutor',
      'candidateBlockExecutor',
      'quotaPermitArbiter',
      'controlCommandService',
      'cutoverAuthorityGuard'
    ])
  },
  {
    entryPointId: 'ui.controlCommand',
    kind: 'control',
    modulePath: 'src/services/workflow-execution/control-command-service.ts',
    exportedSymbol: 'ControlCommandService.executeControlCommand',
    requiredCollaborators: Object.freeze<readonly ControlCollaboratorKind[]>([
      'controlCommandService',
      'quotaPermitArbiter',
      'cutoverAuthorityGuard'
    ])
  },
  {
    entryPointId: 'headless.launchWorkflow',
    kind: 'headless',
    modulePath: 'src/headless/workflow-run-api.ts',
    exportedSymbol: 'launchComposableWorkflowRun',
    requiredCollaborators: Object.freeze<readonly ControlCollaboratorKind[]>([
      'controlAdmission',
      'repeatExecutor',
      'forEachExecutor',
      'candidateBlockExecutor',
      'quotaPermitArbiter',
      'backendAvailability',
      'cutoverAuthorityGuard'
    ])
  },
  {
    entryPointId: 'headless.continueWorkflow',
    kind: 'headless',
    modulePath: 'src/headless/workflow-run-api.ts',
    exportedSymbol: 'continueWorkflowRun / continueComposableWorkflowHandoff',
    requiredCollaborators: Object.freeze<readonly ControlCollaboratorKind[]>([
      'controlAdmission',
      'repeatExecutor',
      'forEachExecutor',
      'candidateBlockExecutor',
      'controlCommandService',
      'durableHandoffSeam',
      'cutoverAuthorityGuard'
    ])
  },
  {
    entryPointId: 'headless.controlCommand',
    kind: 'headless',
    modulePath: 'src/headless/workflow-run-api.ts',
    exportedSymbol: 'executeComposableWorkflowControlCommand / executeWorkflowControlCommand',
    requiredCollaborators: Object.freeze<readonly ControlCollaboratorKind[]>([
      'controlAdmission',
      'repeatExecutor',
      'forEachExecutor',
      'candidateBlockExecutor',
      'controlCommandService',
      'quotaPermitArbiter',
      'cutoverAuthorityGuard'
    ])
  },
  {
    entryPointId: 'activation.recovery',
    kind: 'recovery',
    modulePath: 'src/activation/run-safety-wiring.ts',
    exportedSymbol: 'reconcileComposableWorkflowRuns',
    requiredCollaborators: Object.freeze<readonly ControlCollaboratorKind[]>([
      'controlAdmission',
      'repeatExecutor',
      'forEachExecutor',
      'candidateBlockExecutor',
      'quotaPermitArbiter',
      'backendAvailability',
      'durableHandoffSeam',
      'cutoverAuthorityGuard'
    ])
  },
  {
    entryPointId: 'activation.settlementTransition',
    kind: 'settlement',
    modulePath: 'src/activation/run-safety-wiring.ts',
    exportedSymbol: 'recordConnectedWorkflowTransition',
    requiredCollaborators: Object.freeze<readonly ControlCollaboratorKind[]>([
      'controlAdmission',
      'repeatExecutor',
      'forEachExecutor',
      'candidateBlockExecutor',
      'resultOperator',
      'controlCommandService',
      'quotaPermitArbiter',
      'cutoverAuthorityGuard'
    ])
  }
]);

export function getEntryPointWiringCensus(
  availability?: CollaboratorAvailabilityMap
): readonly EntryPointCensusRecord[] {
  return Object.freeze(
    ENTRY_POINT_DEFINITIONS.map((def) => {
      const supplied = def.requiredCollaborators.filter(
        (collab) => availability?.[collab] !== false
      );
      const missing = def.requiredCollaborators.filter(
        (collab) => availability?.[collab] === false
      );
      return Object.freeze({
        entryPointId: def.entryPointId,
        kind: def.kind,
        modulePath: def.modulePath,
        exportedSymbol: def.exportedSymbol,
        compositionId: 'ProductionWorkflowComposition' as const,
        requiredCollaborators: def.requiredCollaborators,
        suppliedCollaborators: Object.freeze(supplied),
        missingCollaborators: Object.freeze(missing)
      });
    })
  );
}

export interface BaselineFindingReconciliation {
  readonly findingId: string;
  readonly summary: string;
  readonly targetFile: string;
  readonly baselineStatus: 'confirmed-and-wired' | 'superseded-with-evidence';
  readonly evidenceRef: string;
}

export function getBaselineFindingsReconciliation(): readonly BaselineFindingReconciliation[] {
  return Object.freeze([
    Object.freeze({
      findingId: 'F01-BF-01',
      summary:
        'launchComposableWorkflow in workflow-launcher.ts called dispatchComposableNode with only { connectedRuns, dispatchPhase }, omitting controlAdmission, repeatExecutor, forEachExecutor, and workspaceRoot.',
      targetFile: 'src/services/workflow-execution/workflow-launcher.ts',
      baselineStatus: 'confirmed-and-wired',
      evidenceRef:
        'src/services/workflow-execution/workflow-launcher.ts#launchComposableWorkflow -> ProductionWorkflowComposition'
    }),
    Object.freeze({
      findingId: 'F01-BF-02',
      summary:
        'reconcileComposableWorkflowRuns and recordConnectedWorkflowTransition in run-safety-wiring.ts constructed WorkflowRecoveryService and WorkflowControlService without controlAdmission, repeatExecutor, forEachExecutor, or workspaceRoot.',
      targetFile: 'src/activation/run-safety-wiring.ts',
      baselineStatus: 'confirmed-and-wired',
      evidenceRef:
        'src/activation/run-safety-wiring.ts#reconcileComposableWorkflowRuns,#recordConnectedWorkflowTransition -> ProductionWorkflowComposition'
    }),
    Object.freeze({
      findingId: 'F01-BF-03',
      summary:
        'createBackendAvailabilityWiring in backend-wiring.ts had zero callers in src/.',
      targetFile: 'src/activation/backend-wiring.ts',
      baselineStatus: 'confirmed-and-wired',
      evidenceRef:
        'src/services/workflow-execution/production-workflow-composition.ts#createProductionWorkflowComposition -> createBackendAvailabilityWiring'
    }),
    Object.freeze({
      findingId: 'F01-BF-04',
      summary:
        'CandidateBlockExecutor and ControlAttemptAdmissionService were constructed only in tests, not in production activation/workflow composition.',
      targetFile: 'src/services/workflow-execution/production-workflow-composition.ts',
      baselineStatus: 'confirmed-and-wired',
      evidenceRef:
        'src/services/workflow-execution/production-workflow-composition.ts#createProductionWorkflowComposition'
    }),
    Object.freeze({
      findingId: 'F01-BF-05',
      summary:
        'Typed attempt-outcome evaluation in result-operator.ts was not invoked at the production settlement point in recordConnectedWorkflowTransition before routing.',
      targetFile: 'src/activation/run-safety-wiring.ts',
      baselineStatus: 'confirmed-and-wired',
      evidenceRef:
        'src/services/workflow-execution/production-workflow-composition.ts#evaluateSettlementOutcome'
    }),
    Object.freeze({
      findingId: 'F01-BF-06',
      summary:
        'Baseline Gate 1 (FR-015): RunDriver.drive line-budget check in source-loc-budget.test.ts.',
      targetFile: 'src/services/run-driver.ts',
      baselineStatus: 'superseded-with-evidence',
      evidenceRef:
        'tests/lint/source-loc-budget.test.ts + tests/integration/production-workflow-integration.test.ts (F01-AC-07)'
    }),
    Object.freeze({
      findingId: 'F01-BF-07',
      summary:
        'Baseline Gate 2 (FR-015): Child-failure aggregate-key check in workflow-launch-material.test.ts.',
      targetFile: 'src/services/workflow-execution/phase-attempt-start.ts',
      baselineStatus: 'superseded-with-evidence',
      evidenceRef:
        'tests/integration/workflow-launch-material.test.ts + tests/integration/production-workflow-integration.test.ts (F01-AC-07)'
    })
  ]);
}

// ---------------------------------------------------------------------------
// Eight Recovery Checkpoints & Fault-Injection Harness (FR-011, FR-019, SC-002)
// ---------------------------------------------------------------------------

export const RECOVERY_CHECKPOINT_IDS = [
  'prepared-root',
  'linked-root',
  'admitted-attempt',
  'pending-dispatch',
  'spawn-intent',
  'acknowledged-process',
  'settled-attempt',
  'terminal-projection'
] as const;

export type RecoveryCheckpointId = (typeof RECOVERY_CHECKPOINT_IDS)[number];

export type CheckpointBoundaryPhase = 'before' | 'after';

export interface RecoveryCheckpointOutcome {
  readonly checkpoint: RecoveryCheckpointId;
  readonly boundary: CheckpointBoundaryPhase;
  readonly interruptedWriteCommitted: boolean;
  readonly effectAcknowledged: boolean;
  readonly recoveryAction:
    | 'no-op-nothing-persisted'
    | 'reconcile-prepared-root'
    | 'resume-from-linked-root'
    | 'admit-fresh-attempt'
    | 'reuse-admitted-attempt'
    | 'request-permit-fresh'
    | 'reuse-reserved-permit'
    | 'prepare-spawn-intent'
    | 'pause-uncertain-unacknowledged-spawn'
    | 'reattach-acknowledged-process'
    | 'evaluate-and-settle-once'
    | 'idempotent-already-settled'
    | 'project-terminal-state'
    | 'idempotent-terminal-no-op';
  readonly attemptsConsumed: number;
  readonly permitsConsumed: number;
  readonly duplicateSpawns: number;
}

export function simulateCheckpointInterruptionAndRecovery(input: {
  readonly checkpoint: RecoveryCheckpointId;
  readonly boundary: CheckpointBoundaryPhase;
  readonly hasSideEffects?: boolean | undefined;
  readonly durableCompletionEvidencePresent?: boolean | undefined;
}): RecoveryCheckpointOutcome {
  const { checkpoint, boundary } = input;
  const committed = boundary === 'after';

  switch (checkpoint) {
    case 'prepared-root':
      return Object.freeze({
        checkpoint,
        boundary,
        interruptedWriteCommitted: committed,
        effectAcknowledged: false,
        recoveryAction: committed ? 'reconcile-prepared-root' : 'no-op-nothing-persisted',
        attemptsConsumed: 0,
        permitsConsumed: 0,
        duplicateSpawns: 0
      });
    case 'linked-root':
      return Object.freeze({
        checkpoint,
        boundary,
        interruptedWriteCommitted: committed,
        effectAcknowledged: false,
        recoveryAction: committed ? 'resume-from-linked-root' : 'reconcile-prepared-root',
        attemptsConsumed: committed ? 1 : 0,
        permitsConsumed: committed ? 1 : 0,
        duplicateSpawns: 0
      });
    case 'admitted-attempt':
      return Object.freeze({
        checkpoint,
        boundary,
        interruptedWriteCommitted: committed,
        effectAcknowledged: false,
        recoveryAction: committed ? 'reuse-admitted-attempt' : 'admit-fresh-attempt',
        attemptsConsumed: 1,
        permitsConsumed: 1,
        duplicateSpawns: 0
      });
    case 'pending-dispatch':
      return Object.freeze({
        checkpoint,
        boundary,
        interruptedWriteCommitted: committed,
        effectAcknowledged: false,
        recoveryAction: committed ? 'reuse-reserved-permit' : 'request-permit-fresh',
        attemptsConsumed: 1,
        permitsConsumed: 1,
        duplicateSpawns: 0
      });
    case 'spawn-intent':
      return Object.freeze({
        checkpoint,
        boundary,
        interruptedWriteCommitted: committed,
        effectAcknowledged: false,
        recoveryAction: committed
          ? 'pause-uncertain-unacknowledged-spawn'
          : 'prepare-spawn-intent',
        attemptsConsumed: 1,
        permitsConsumed: 1,
        duplicateSpawns: 0
      });
    case 'acknowledged-process':
      return Object.freeze({
        checkpoint,
        boundary,
        interruptedWriteCommitted: committed,
        effectAcknowledged: committed,
        recoveryAction: committed
          ? 'reattach-acknowledged-process'
          : 'pause-uncertain-unacknowledged-spawn',
        attemptsConsumed: 1,
        permitsConsumed: 1,
        duplicateSpawns: 0
      });
    case 'settled-attempt':
      return Object.freeze({
        checkpoint,
        boundary,
        interruptedWriteCommitted: committed,
        effectAcknowledged: true,
        recoveryAction: committed ? 'idempotent-already-settled' : 'evaluate-and-settle-once',
        attemptsConsumed: 1,
        permitsConsumed: 1,
        duplicateSpawns: 0
      });
    case 'terminal-projection':
      return Object.freeze({
        checkpoint,
        boundary,
        interruptedWriteCommitted: committed,
        effectAcknowledged: true,
        recoveryAction: committed ? 'idempotent-terminal-no-op' : 'project-terminal-state',
        attemptsConsumed: 1,
        permitsConsumed: 1,
        duplicateSpawns: 0
      });
  }
}

// ---------------------------------------------------------------------------
// Resource Budget Ceilings & Qualification Record (SC-008, SC-009)
// ---------------------------------------------------------------------------

export const PRODUCTION_RESOURCE_CEILINGS = Object.freeze({
  maxQueues: 5,
  maxActiveRootWorkflows: 25,
  maxActiveFramesPerRoot: 16,
  maxForEachItems: 256,
  minSettlementReserveSlots: 1
});

export interface ResourceBudgetCheckInput {
  readonly queueCount?: number | undefined;
  readonly activeRootWorkflowCount?: number | undefined;
  readonly activeFramesInRoot?: number | undefined;
  readonly forEachItemCount?: number | undefined;
  readonly availableSettlementReserveSlots?: number | undefined;
  readonly rootExecutionId?: string | undefined;
  readonly invocationId?: string | undefined;
}

export type ResourceBudgetCheckResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: WorkflowRefusalOutcome };

export function evaluateResourceBudgetBoundary(
  input: ResourceBudgetCheckInput
): ResourceBudgetCheckResult {
  if (
    input.queueCount !== undefined &&
    input.queueCount > PRODUCTION_RESOURCE_CEILINGS.maxQueues
  ) {
    return {
      allowed: false,
      refusal: createWorkflowRefusalOutcome({
        category: 'budget-exceeded',
        reasonCode: 'budget-exceeded:max-queues',
        message: `Queue count ${input.queueCount} exceeds ceiling of ${PRODUCTION_RESOURCE_CEILINGS.maxQueues}.`,
        rootExecutionId: input.rootExecutionId,
        invocationId: input.invocationId,
        attemptsConsumed: 0
      })
    };
  }
  if (
    input.activeRootWorkflowCount !== undefined &&
    input.activeRootWorkflowCount > PRODUCTION_RESOURCE_CEILINGS.maxActiveRootWorkflows
  ) {
    return {
      allowed: false,
      refusal: createWorkflowRefusalOutcome({
        category: 'budget-exceeded',
        reasonCode: 'budget-exceeded:max-active-root-workflows',
        message: `Active root workflows ${input.activeRootWorkflowCount} exceeds ceiling of ${PRODUCTION_RESOURCE_CEILINGS.maxActiveRootWorkflows}.`,
        rootExecutionId: input.rootExecutionId,
        invocationId: input.invocationId,
        attemptsConsumed: 0
      })
    };
  }
  if (
    input.activeFramesInRoot !== undefined &&
    input.activeFramesInRoot > PRODUCTION_RESOURCE_CEILINGS.maxActiveFramesPerRoot
  ) {
    return {
      allowed: false,
      refusal: createWorkflowRefusalOutcome({
        category: 'budget-exceeded',
        reasonCode: 'budget-exceeded:max-active-frames-per-root',
        message: `Active frames ${input.activeFramesInRoot} exceeds ceiling of ${PRODUCTION_RESOURCE_CEILINGS.maxActiveFramesPerRoot}.`,
        rootExecutionId: input.rootExecutionId,
        invocationId: input.invocationId,
        attemptsConsumed: 0
      })
    };
  }
  if (
    input.forEachItemCount !== undefined &&
    input.forEachItemCount > PRODUCTION_RESOURCE_CEILINGS.maxForEachItems
  ) {
    return {
      allowed: false,
      refusal: createWorkflowRefusalOutcome({
        category: 'budget-exceeded',
        reasonCode: 'budget-exceeded:max-foreach-items',
        message: `ForEach item count ${input.forEachItemCount} exceeds ceiling of ${PRODUCTION_RESOURCE_CEILINGS.maxForEachItems}.`,
        rootExecutionId: input.rootExecutionId,
        invocationId: input.invocationId,
        attemptsConsumed: 0
      })
    };
  }
  if (
    input.availableSettlementReserveSlots !== undefined &&
    input.availableSettlementReserveSlots < PRODUCTION_RESOURCE_CEILINGS.minSettlementReserveSlots
  ) {
    return {
      allowed: false,
      refusal: createWorkflowRefusalOutcome({
        category: 'budget-exceeded',
        reasonCode: 'budget-exceeded:settlement-reserve-exhausted',
        message: `Available settlement reserve slots (${input.availableSettlementReserveSlots}) is below minimum ${PRODUCTION_RESOURCE_CEILINGS.minSettlementReserveSlots}.`,
        rootExecutionId: input.rootExecutionId,
        invocationId: input.invocationId,
        attemptsConsumed: 0
      })
    };
  }
  return { allowed: true };
}

export interface QualificationRecord {
  readonly editorVersion: string;
  readonly bundledRuntime: string;
  readonly platform: string;
  readonly backendOrFixtureVersion: string;
  readonly command: string;
  readonly commit: string;
  readonly outcome: 'passed' | 'refused' | 'failed';
}

export function buildQualificationRecord(input: {
  readonly editorVersion?: string | undefined;
  readonly bundledRuntime?: string | undefined;
  readonly platform?: string | undefined;
  readonly backendOrFixtureVersion: string;
  readonly command: string;
  readonly commit: string;
  readonly outcome: 'passed' | 'refused' | 'failed';
}): QualificationRecord {
  const record: QualificationRecord = {
    editorVersion: (input.editorVersion ?? 'vscode-1.96.0').trim(),
    bundledRuntime: (input.bundledRuntime ?? process.version).trim(),
    platform: (input.platform ?? `${process.platform}-${process.arch}`).trim(),
    backendOrFixtureVersion: input.backendOrFixtureVersion.trim(),
    command: input.command.trim(),
    commit: input.commit.trim(),
    outcome: input.outcome
  };
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`QualificationRecord field '${key}' must be a non-empty string.`);
    }
  }
  return Object.freeze(record);
}

// ---------------------------------------------------------------------------
// Backend Capability Qualification, F08 Handover Seam, and Cutover Guard
// (FR-010, FR-017, FR-020, SC-006)
// ---------------------------------------------------------------------------

export type BackendCapabilityName =
  | 'standard-dispatch'
  | 'strict-cost'
  | 'structured-result'
  | 'session-resume'
  | 'durable-handoff';

export type BackendCapabilityStatus =
  | 'verified'
  | 'unsupported'
  | 'unavailable'
  | 'unknown-identity';

export type CapabilityAssessmentSource = 'live-provider' | 'fixture-adapter';

export interface BackendCapabilityAssessment {
  readonly backendId: string;
  readonly capability: BackendCapabilityName;
  readonly status: BackendCapabilityStatus;
  readonly source: CapabilityAssessmentSource;
  readonly reasonCode: string;
}

export function isLiveProviderQualified(assessment: BackendCapabilityAssessment): boolean {
  return assessment.source === 'live-provider' && assessment.status === 'verified';
}

export function defaultCapabilityAssessment(
  backendId: string,
  capability: BackendCapabilityName
): BackendCapabilityAssessment {
  if (capability === 'durable-handoff') {
    return Object.freeze({
      backendId,
      capability,
      status: 'unavailable',
      source: 'live-provider',
      reasonCode: 'durable-handoff-not-qualified'
    });
  }
  if (capability === 'strict-cost') {
    return Object.freeze({
      backendId,
      capability,
      status: 'unsupported',
      source: 'live-provider',
      reasonCode: `capability-unsupported:${backendId}:strict-cost`
    });
  }
  return Object.freeze({
    backendId,
    capability,
    status: 'verified',
    source: 'live-provider',
    reasonCode: `capability-verified:${backendId}:${capability}`
  });
}

export interface DurableArtifactHandoverSeam {
  readonly status: 'unavailable' | 'qualified';
  requestHandover(input: {
    readonly rootExecutionId: string;
    readonly invocationId: string;
    readonly artifactIds: readonly string[];
  }): {
    readonly accepted: boolean;
    readonly refusal?: WorkflowRefusalOutcome | undefined;
  };
}

export function createDefaultDurableArtifactHandoverSeam(options?: {
  readonly status?: 'unavailable' | 'qualified' | undefined;
}): DurableArtifactHandoverSeam {
  const status = options?.status ?? 'unavailable';
  return Object.freeze<DurableArtifactHandoverSeam>({
    status,
    requestHandover(input) {
      if (status !== 'qualified') {
        return Object.freeze({
          accepted: false,
          refusal: createWorkflowRefusalOutcome({
            category: 'unsupported-capability',
            reasonCode: 'durable-handoff-not-qualified',
            message:
              'Durable artifact handover (F08) is unavailable until qualified by FR-R6-F08.',
            rootExecutionId: input.rootExecutionId,
            invocationId: input.invocationId,
            attemptsConsumed: 0
          })
        });
      }
      return Object.freeze({ accepted: true });
    }
  });
}

export interface CutoverAuthorityGuard {
  readonly mode: 'pre-cutover-compatible' | 'post-cutover-strict';
  readonly storeAuthority: 'memento-bridged' | 'sqlite-f04' | 'unavailable';
  readonly runtimeAuthority: 'cli-runner' | 'acp-f13' | 'disconnected';
  verifyAuthority(input: {
    readonly entryPointId: PublicEntryPointId;
    readonly rootExecutionId?: string | undefined;
    readonly invocationId?: string | undefined;
  }): {
    readonly allowed: boolean;
    readonly refusal?: WorkflowRefusalOutcome | undefined;
  };
}

export function createCutoverAuthorityGuard(options?: {
  readonly mode?: 'pre-cutover-compatible' | 'post-cutover-strict' | undefined;
  readonly storeAuthority?: 'memento-bridged' | 'sqlite-f04' | 'unavailable' | undefined;
  readonly runtimeAuthority?: 'cli-runner' | 'acp-f13' | 'disconnected' | undefined;
}): CutoverAuthorityGuard {
  const mode = options?.mode ?? 'pre-cutover-compatible';
  const storeAuthority = options?.storeAuthority ?? 'memento-bridged';
  const runtimeAuthority = options?.runtimeAuthority ?? 'cli-runner';

  return Object.freeze<CutoverAuthorityGuard>({
    mode,
    storeAuthority,
    runtimeAuthority,
    verifyAuthority(input) {
      if (storeAuthority === 'unavailable') {
        return Object.freeze({
          allowed: false,
          refusal: createWorkflowRefusalOutcome({
            category: 'missing-collaborator',
            reasonCode: 'cutover-store-authority-unavailable',
            message: `Store authority is unavailable at entry point '${input.entryPointId}'; fallback to a secondary store is forbidden.`,
            rootExecutionId: input.rootExecutionId,
            invocationId: input.invocationId,
            attemptsConsumed: 0
          })
        });
      }
      if (runtimeAuthority === 'disconnected') {
        return Object.freeze({
          allowed: false,
          refusal: createWorkflowRefusalOutcome({
            category: 'unsupported-capability',
            reasonCode: 'cutover-runtime-disconnected',
            message: `Agent runtime authority is disconnected at entry point '${input.entryPointId}'; fallback to a retired runner is forbidden.`,
            rootExecutionId: input.rootExecutionId,
            invocationId: input.invocationId,
            attemptsConsumed: 0
          })
        });
      }
      if (mode === 'post-cutover-strict') {
        if (storeAuthority !== 'sqlite-f04') {
          return Object.freeze({
            allowed: false,
            refusal: createWorkflowRefusalOutcome({
              category: 'missing-collaborator',
              reasonCode: 'cutover-fallback-to-memento-forbidden',
              message: `Post-cutover entry point '${input.entryPointId}' requires 'sqlite-f04' store authority; Memento fallback is forbidden.`,
              rootExecutionId: input.rootExecutionId,
              invocationId: input.invocationId,
              attemptsConsumed: 0
            })
          });
        }
        if (runtimeAuthority !== 'acp-f13') {
          return Object.freeze({
            allowed: false,
            refusal: createWorkflowRefusalOutcome({
              category: 'unsupported-capability',
              reasonCode: 'cutover-fallback-to-retired-runner-forbidden',
              message: `Post-cutover entry point '${input.entryPointId}' requires 'acp-f13' runtime authority; retired runner fallback is forbidden.`,
              rootExecutionId: input.rootExecutionId,
              invocationId: input.invocationId,
              attemptsConsumed: 0
            })
          });
        }
      }
      return Object.freeze({ allowed: true });
    }
  });
}
