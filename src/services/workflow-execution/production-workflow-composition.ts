/**
 * FR-R6-F01 (FR-001..FR-021, SC-001..SC-009) —
 * Shared production workflow composition.
 *
 * Assembles the existing in-tree control collaborators (`ControlLedgerStore`,
 * `QuotaPermitArbiter`, `ControlAttemptAdmissionService`, `RepeatExecutor`,
 * `ForEachExecutor`, `CandidateBlockExecutor`, `ResultOperator`,
 * `ControlCommandService`, `ControlNotificationService`,
 * `ControlUsageAccountingService`, `BackendAvailabilityService` +
 * `ControlWakeupPlanner`, `DurableArtifactHandoverSeam`, and
 * `CutoverAuthorityGuard`) into a single production composition consumed by
 * activation (`run-safety-wiring.ts`), launch (`workflow-launcher.ts`),
 * continuation (`continuation-service.ts`), and headless (`workflow-run-api.ts`)
 * entry points.
 *
 * Zero `vscode` imports (hard-rules.md rule 13).
 */

import type { BackendAvailabilityAdapter } from '../../contracts/backend-availability';
import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import type {
  ControlAdmissionPort,
  ControlClockPort,
  ExecutionFence,
  PrepareControlAttemptInput
} from '../../contracts/control-ledger';
import type { DecisionFieldValue, ResultContract } from '../../contracts/decision-results';
import type { PhaseDefinition } from '../../contracts/process-definitions';
import type { ResolvedPortValue } from '../../contracts/run-request';
import type { RunOutputRecord } from '../../contracts/run-results';
import type { WorkflowNodeTerminalStatus } from '../../contracts/workflow-definitions';
import {
  resolveBoundQueueId,
  resolveRootInvocationId,
  type ConnectedWorkflowRun
} from '../../state/connected-workflow-run';
import type { Memento } from '../../state/workspace-state';
import {
  BackendAvailabilityService,
  type AvailabilityClockPort
} from '../backend-availability-service';
import {
  ResultOperator,
  type CanonicalBackendDiagnosticInput,
  type HostControlReason
} from '../result-operator';
import { CandidateBlockExecutor } from './candidate-block-executor';
import type {
  ComposableWorkflowCoordinatorDeps,
  PhaseAttemptDispatchInput,
  PhaseAttemptDispatchResult
} from './connected-run-coordinator';
import { ControlAttemptAdmissionService, type ControlAttemptAdmissionDeps } from './control-attempt-admission';
import { ControlCommandService, type ControlCommandServiceDeps } from './control-command-service';
import { ControlLedgerStore, type ControlLedgerBackingStore } from './control-ledger-store';
import { ControlNotificationService } from './control-notification-service';
import { ControlUsageAccountingService } from './control-usage-accounting';
import { ControlWakeupPlanner, type ControlWakeupEvent } from './control-wakeup-planner';
import {
  createCutoverAuthorityGuard,
  createDefaultDurableArtifactHandoverSeam,
  createWorkflowRefusalOutcome,
  defaultCapabilityAssessment,
  evaluateResourceBudgetBoundary,
  getEntryPointWiringCensus,
  isLiveProviderQualified,
  type BackendCapabilityAssessment,
  type BackendCapabilityName,
  type BackendCapabilityStatus,
  type CapabilityAssessmentSource,
  type CollaboratorAvailabilityMap,
  type ControlCollaboratorKind,
  type CutoverAuthorityGuard,
  type DurableArtifactHandoverSeam,
  type EntryPointCensusRecord,
  type PublicEntryPointId,
  type ResourceBudgetCheckInput,
  type WorkflowRefusalOutcome
} from './entry-point-wiring-census';
import { ForEachExecutor } from './foreach-executor';
import { QuotaPermitArbiter } from './quota-permit-arbiter';
import { RepeatExecutor } from './repeat-executor';
import type { PhaseHandoffCoordinator } from '../phase-context/phase-handoff-coordinator';
import {
  WorkflowControlService,
  type WorkflowControlServiceDeps,
  type WorkflowControlStore
} from './workflow-control-service';
import type { ConnectedRunWriter } from './workflow-launcher';
import {
  WorkflowRecoveryService,
  type WorkflowRecoveryServiceDeps
} from './workflow-recovery-service';

export {
  createCutoverAuthorityGuard,
  createDefaultDurableArtifactHandoverSeam,
  createWorkflowRefusalOutcome,
  defaultCapabilityAssessment,
  isLiveProviderQualified,
  type BackendCapabilityAssessment,
  type BackendCapabilityName,
  type BackendCapabilityStatus,
  type CapabilityAssessmentSource,
  type CutoverAuthorityGuard,
  type DurableArtifactHandoverSeam,
  type WorkflowControlStore
};

export interface PreAdmissionCheckInput {
  readonly entryPointId: PublicEntryPointId;
  readonly rootExecutionId?: string | undefined;
  readonly invocationId?: string | undefined;
  readonly requiredCollaborators?: readonly ControlCollaboratorKind[] | undefined;
  readonly requiredCapabilities?:
    | readonly { readonly backendId: string; readonly capability: BackendCapabilityName; readonly requireLiveQualification?: boolean | undefined }[]
    | undefined;
  readonly isWorkspaceTrusted?: boolean | undefined;
  readonly isFenceValid?: boolean | undefined;
  readonly isStateCorruptOrFutureVersion?: { readonly corrupt: boolean; readonly reasonCode?: string | undefined; readonly message?: string | undefined } | undefined;
  readonly isQuotaDeferred?: { readonly deferred: boolean; readonly reasonCode?: string | undefined; readonly message?: string | undefined } | undefined;
  readonly resourceBudget?: ResourceBudgetCheckInput | undefined;
}

export type PreAdmissionCheckResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: WorkflowRefusalOutcome };

export interface SettlementEvaluationInput {
  readonly attemptId: string;
  readonly workspaceRoot: string;
  readonly status: WorkflowNodeTerminalStatus;
  readonly phase?: PhaseDefinition | undefined;
  readonly resultContract?: ResultContract | undefined;
  readonly runOutputs?: readonly RunOutputRecord[] | undefined;
  readonly declaredOutputs?: Readonly<Record<string, ResolvedPortValue>> | undefined;
  readonly backendResultText?: string | undefined;
  readonly diagnosticRecordsText?: string | undefined;
  readonly backendDiagnostic?: CanonicalBackendDiagnosticInput | undefined;
  readonly conflictingBackendDiagnostic?: CanonicalBackendDiagnosticInput | undefined;
  readonly hostControl?: HostControlReason | undefined;
  readonly evaluatedAt?: number | undefined;
}

export interface SettlementEvaluationResult {
  readonly status: WorkflowNodeTerminalStatus;
  readonly declaredOutputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>> | undefined;
  readonly verdict?: 'pass' | 'fail' | null | undefined;
  readonly failureCode?: string | undefined;
  readonly refusal?: WorkflowRefusalOutcome | undefined;
}

export interface ProductionAvailabilityWakeupResult {
  readonly observationRecorded: boolean;
  readonly schedulerNotified: boolean;
  readonly spawnedDirectly: false;
}

export interface ProductionWorkflowCompositionOptions {
  readonly store?: ControlLedgerBackingStore | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly clock?: ControlClockPort | undefined;
  readonly hostEpoch?: string | undefined;
  readonly isWorkspaceTrusted?: (() => boolean) | undefined;
  readonly verifyLiveFence?: ((fence: ExecutionFence, context: { readonly rootRunId: string; readonly queueId: string }) => boolean) | undefined;
  readonly resolveExecutionFence?: ((run: ConnectedWorkflowRun, queueId: string) => ExecutionFence) | undefined;
  readonly collaboratorOverrides?: CollaboratorAvailabilityMap | undefined;
  readonly assessBackendCapability?: ((backendId: string, capability: BackendCapabilityName) => BackendCapabilityAssessment) | undefined;
  readonly allowFixtureCapabilities?: boolean | undefined;
  readonly getAvailabilityAdapter?: ((kind: BackendRunnerKind) => BackendAvailabilityAdapter) | undefined;
  readonly onScheduleQueueWakeup?: ((queueId?: string) => void | Promise<void>) | undefined;
  readonly durableHandoffSeam?: DurableArtifactHandoverSeam | undefined;
  readonly cutoverAuthorityGuard?: CutoverAuthorityGuard | undefined;
  readonly phaseHandoffCoordinator?: PhaseHandoffCoordinator | undefined;
  readonly admissionDeps?: Partial<ControlAttemptAdmissionDeps> | undefined;
  readonly commandServiceDeps?: Partial<ControlCommandServiceDeps> | undefined;
}

export interface ProductionWorkflowComposition {
  readonly compositionId: 'ProductionWorkflowComposition';
  readonly workspaceRoot?: string | undefined;
  readonly clock: ControlClockPort;
  readonly ledgerStore: ControlLedgerStore;
  readonly quotaPermitArbiter: QuotaPermitArbiter;
  readonly controlAdmission: ControlAttemptAdmissionService;
  readonly repeatExecutor: RepeatExecutor;
  readonly forEachExecutor: ForEachExecutor;
  readonly candidateBlockExecutor: CandidateBlockExecutor;
  readonly resultOperator: ResultOperator;
  readonly controlCommandService: ControlCommandService;
  readonly notificationService: ControlNotificationService;
  readonly usageAccounting: ControlUsageAccountingService;
  readonly availabilityService: BackendAvailabilityService;
  readonly wakeupPlanner: ControlWakeupPlanner;
  readonly durableHandoffSeam: DurableArtifactHandoverSeam;
  readonly cutoverAuthorityGuard: CutoverAuthorityGuard;
  readonly phaseHandoffCoordinator?: PhaseHandoffCoordinator | undefined;

  getEntryPointCensus(): readonly EntryPointCensusRecord[];
  isCollaboratorSupplied(kind: ControlCollaboratorKind): boolean;
  assessCapability(
    backendId: string,
    capability: BackendCapabilityName
  ): BackendCapabilityAssessment;
  verifyPreAdmission(input: PreAdmissionCheckInput): PreAdmissionCheckResult;
  ensureRootControlLink(
    run: ConnectedWorkflowRun,
    queueId?: string
  ): Promise<ConnectedWorkflowRun>;
  evaluateSettlementOutcome(
    input: SettlementEvaluationInput
  ): Promise<SettlementEvaluationResult>;
  recordAvailabilityWakeup(input: {
    readonly quotaId: string;
    readonly backend: BackendRunnerKind;
    readonly ready: boolean;
    readonly capacity?: number | undefined;
    readonly resetAtWallMs?: number | undefined;
    readonly queueId?: string | undefined;
  }): Promise<ProductionAvailabilityWakeupResult>;
  createCoordinatorDeps(options: {
    readonly connectedRuns: ConnectedRunWriter;
    readonly dispatchPhase: (
      input: PhaseAttemptDispatchInput
    ) => Promise<PhaseAttemptDispatchResult>;
    readonly workspaceRoot?: string | undefined;
    readonly cancelOrphanedQueueItem?:
      | ((queueItemId: string, queueId: string) => Promise<void> | void)
      | undefined;
  }): ComposableWorkflowCoordinatorDeps;
  createControlService(
    options: Omit<
      WorkflowControlServiceDeps,
      | 'controlAdmission'
      | 'repeatExecutor'
      | 'forEachExecutor'
      | 'workspaceRoot'
      | 'resolveExecutionFence'
      | 'controlCommandService'
    > & {
      readonly workspaceRoot?: string | undefined;
    }
  ): WorkflowControlService;
  createRecoveryService(
    options: Omit<
      WorkflowRecoveryServiceDeps,
      | 'controlAdmission'
      | 'repeatExecutor'
      | 'forEachExecutor'
      | 'workspaceRoot'
      | 'quotaPermitArbiter'
      | 'notificationService'
      | 'usageAccounting'
      | 'resolveRecoveryFence'
    > & {
      readonly workspaceRoot?: string | undefined;
    }
  ): WorkflowRecoveryService;
  dispose(): void;
}

function createInMemoryMemento(): Memento {
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

function isControlLedgerBackingStore(candidate: unknown): candidate is ControlLedgerBackingStore {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const obj = candidate as Record<string, unknown>;
  return (
    (typeof obj.getRawControlLedger === 'function' &&
      typeof obj.transactControlLedger === 'function') ||
    (typeof obj.get === 'function' && typeof obj.update === 'function')
  );
}

function buildDeclaredOutputsFromRunOutputs(
  outputs: readonly RunOutputRecord[] | undefined
): Readonly<Record<string, ResolvedPortValue>> {
  if (outputs === undefined || outputs.length === 0) return Object.freeze({});
  const byPort: Record<string, ResolvedPortValue> = {};
  for (const entry of outputs) {
    if (entry.status !== 'resolved' || entry.reference === undefined) continue;
    byPort[entry.name] = Object.freeze({
      portId: entry.name,
      type: 'local-file',
      value: entry.reference
    });
  }
  return Object.freeze(byPort);
}

export function createProductionWorkflowComposition(
  options: ProductionWorkflowCompositionOptions = {}
): ProductionWorkflowComposition {
  const backingStore: ControlLedgerBackingStore = isControlLedgerBackingStore(options.store)
    ? options.store
    : createInMemoryMemento();
  const ledgerStore = new ControlLedgerStore(backingStore);
  const hostEpoch = options.hostEpoch ?? options.clock?.hostEpoch ?? 'production-epoch';
  const clock: ControlClockPort & AvailabilityClockPort = {
    hostEpoch,
    nowWallMs: options.clock?.nowWallMs ?? (() => Date.now()),
    nowMonotonicMs: options.clock?.nowMonotonicMs ?? (() => Math.trunc(performance.now()))
  };

  const resolveFence =
    options.resolveExecutionFence ??
    ((run: ConnectedWorkflowRun, queueId: string): ExecutionFence => ({
      primacyClaim: `primacy:${run.connectedRunId}`,
      queueClaim: `queue:${queueId}`,
      rootGeneration: 1
    }));

  const quotaPermitArbiter = new QuotaPermitArbiter({
    ledgerStore,
    clock,
    ...(options.isWorkspaceTrusted !== undefined
      ? { isWorkspaceTrusted: options.isWorkspaceTrusted }
      : {}),
    ...(options.verifyLiveFence !== undefined
      ? { verifyLiveFence: options.verifyLiveFence }
      : {}),
    ...(options.onScheduleQueueWakeup !== undefined
      ? {
          onCapacityOrWaiterChanged: (queueId?: string) => {
            void options.onScheduleQueueWakeup?.(queueId);
          }
        }
      : {})
  });

  const controlAdmission = new ControlAttemptAdmissionService({
    ledgerStore,
    clock,
    ...(options.verifyLiveFence !== undefined
      ? {
          verifyLiveFence: (fence, ctx) =>
            options.verifyLiveFence!(fence, {
              rootRunId: ctx.ledgerRunId,
              queueId: ctx.queueId
            })
        }
      : {}),
    ...options.admissionDeps
  });

  const ensureRootAndFrameActiveForAttempt = async (
    input: PrepareControlAttemptInput
  ): Promise<void> => {
    const existingRoot = ledgerStore.getRoot(input.ledgerRunId);
    if (existingRoot === null) {
      const prep = await controlAdmission.prepareRootLink({
        ledgerRunId: input.ledgerRunId,
        connectedRunId: input.connectedRunId,
        rootWorkflowId: input.workflowId,
        queueId: input.queueId,
        fence: input.fence,
        rootFrameKey: input.frameKey,
        rootInvocationId: input.invocationId
      });
      if (prep.ok) {
        await controlAdmission.activateRootLink({
          ledgerRunId: input.ledgerRunId,
          connectedRunId: input.connectedRunId,
          fence: input.fence
        });
      }
      return;
    }

    const hasExistingFrame = Object.prototype.hasOwnProperty.call(
      existingRoot.framesByKey,
      input.frameKey
    );
    const existingFrame = hasExistingFrame ? existingRoot.framesByKey[input.frameKey] : null;
    const targetAttemptId =
      input.attemptId ??
      `${input.invocationId}:${input.nodeId}:attempt-${input.attemptIndex ?? 1}`;
    const hasStaleAttemptCollision = Object.prototype.hasOwnProperty.call(
      existingRoot.attemptsById,
      targetAttemptId
    );
    const needsRootReactivation =
      existingRoot.linkState !== 'active' || existingRoot.status !== 'in-flight';
    const needsFrameReactivation =
      existingFrame !== null && existingFrame.status !== 'executing';

    if (needsRootReactivation || needsFrameReactivation || hasStaleAttemptCollision) {
      await ledgerStore.mutate({ targetRootId: input.ledgerRunId }, ({ ledger }) => {
        if (!Object.prototype.hasOwnProperty.call(ledger.roots, input.ledgerRunId)) {
          return { commit: false, code: 'control-root-not-found', message: 'Root missing' };
        }
        const root = ledger.roots[input.ledgerRunId];
        const nextFrames = { ...root.framesByKey };
        if (existingFrame !== null && existingFrame.status !== 'executing') {
          nextFrames[input.frameKey] = Object.freeze({
            ...existingFrame,
            status: 'executing',
            updatedAt: clock.nowWallMs()
          });
        }
        const nextAttempts = { ...root.attemptsById };
        let nextDispatched = root.dispatchedAttempts;
        if (hasStaleAttemptCollision) {
          delete nextAttempts[targetAttemptId];
          nextDispatched = Math.max(0, nextDispatched - 1);
        }
        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                [input.ledgerRunId]: Object.freeze({
                  ...root,
                  linkState: 'active',
                  status: 'in-flight',
                  dispatchedAttempts: nextDispatched,
                  framesByKey: Object.freeze(nextFrames),
                  attemptsById: Object.freeze(nextAttempts),
                  updatedAt: clock.nowWallMs()
                })
              }
            },
            targetRootId: input.ledgerRunId,
            result: true
          }
        };
      });
    }
  };

  const coordinatorControlAdmissionPort: ControlAdmissionPort &
    Pick<ControlAttemptAdmissionService, 'reconcileControlRoot'> = {
    prepareAttempt: async (input) => {
      await ensureRootAndFrameActiveForAttempt(input);
      return controlAdmission.prepareAttempt(input);
    },
    commitAttempt: (token) => controlAdmission.commitAttempt(token),
    settleAttempt: (input) => controlAdmission.settleAttempt(input),
    reconcileControlRoot: (input) => controlAdmission.reconcileControlRoot(input)
  };

  const repeatExecutor = new RepeatExecutor({ ledgerStore, clock });
  const forEachExecutor = new ForEachExecutor({ ledgerStore, clock });
  const notificationService = new ControlNotificationService({ ledgerStore, clock });
  const usageAccounting = new ControlUsageAccountingService({ ledgerStore, clock });

  const availabilityService = new BackendAvailabilityService({
    ledgerStore,
    clock,
    getAdapter:
      options.getAvailabilityAdapter ??
      ((kind: BackendRunnerKind): BackendAvailabilityAdapter => ({
        adapterId: `${kind}-cli`,
        adapterVersion: 1,
        backend: kind,
        statusCheck: 'unsupported',
        resolveQuotaContext: () => ({
          version: 1,
          adapterId: `${kind}-cli`,
          adapterVersion: 1,
          quotaIds: [`${kind}/default`],
          identity: 'qualified',
          statusCheck: 'unsupported'
        })
      }))
  });

  const wakeupPlanner = new ControlWakeupPlanner({
    ledgerStore,
    availabilityService,
    clock,
    onWakeupDue: async (_event: ControlWakeupEvent) => {
      await options.onScheduleQueueWakeup?.();
    }
  });

  const candidateBlockExecutor = new CandidateBlockExecutor({
    ledgerStore,
    admissionService: controlAdmission,
    availabilityService,
    permitArbiter: quotaPermitArbiter,
    usageAccounting,
    notificationService,
    clock
  });

  const resultOperator = new ResultOperator();

  const controlCommandService = new ControlCommandService({
    ledgerStore,
    clock,
    ...(options.isWorkspaceTrusted !== undefined
      ? { isWorkspaceTrusted: options.isWorkspaceTrusted }
      : {}),
    ...options.commandServiceDeps
  });

  const durableHandoffSeam =
    options.durableHandoffSeam ?? createDefaultDurableArtifactHandoverSeam();
  const cutoverAuthorityGuard =
    options.cutoverAuthorityGuard ?? createCutoverAuthorityGuard();
  const collaboratorOverrides = options.collaboratorOverrides ?? {};
  const allowFixtureCapabilities = options.allowFixtureCapabilities ?? false;

  const isCollaboratorSupplied = (kind: ControlCollaboratorKind): boolean =>
    collaboratorOverrides[kind] !== false;

  const assessCapability = (
    backendId: string,
    capability: BackendCapabilityName
  ): BackendCapabilityAssessment => {
    if (capability === 'durable-handoff') {
      return Object.freeze({
        backendId,
        capability,
        status: durableHandoffSeam.status === 'qualified' ? 'verified' : 'unavailable',
        source: 'live-provider',
        reasonCode:
          durableHandoffSeam.status === 'qualified'
            ? 'durable-handoff-qualified'
            : 'durable-handoff-not-qualified'
      });
    }
    if (options.assessBackendCapability !== undefined) {
      return options.assessBackendCapability(backendId, capability);
    }
    return defaultCapabilityAssessment(backendId, capability);
  };

  const verifyPreAdmission = (input: PreAdmissionCheckInput): PreAdmissionCheckResult => {
    const cutoverCheck = cutoverAuthorityGuard.verifyAuthority({
      entryPointId: input.entryPointId,
      rootExecutionId: input.rootExecutionId,
      invocationId: input.invocationId
    });
    if (!cutoverCheck.allowed && cutoverCheck.refusal !== undefined) {
      return { allowed: false, refusal: cutoverCheck.refusal };
    }

    if (input.isStateCorruptOrFutureVersion?.corrupt === true) {
      return {
        allowed: false,
        refusal: createWorkflowRefusalOutcome({
          category: 'corrupt-state',
          reasonCode:
            input.isStateCorruptOrFutureVersion.reasonCode ?? 'corrupt-or-future-state-record',
          message:
            input.isStateCorruptOrFutureVersion.message ??
            'Workflow state or control ledger record is corrupt or uses an unsupported future schema version.',
          rootExecutionId: input.rootExecutionId,
          invocationId: input.invocationId,
          attemptsConsumed: 0
        })
      };
    }

    const ledgerRead = ledgerStore.read();
    if (!ledgerRead.ok) {
      return {
        allowed: false,
        refusal: createWorkflowRefusalOutcome({
          category: 'corrupt-state',
          reasonCode: ledgerRead.code,
          message: ledgerRead.message,
          rootExecutionId: input.rootExecutionId,
          invocationId: input.invocationId,
          attemptsConsumed: 0
        })
      };
    }

    const trusted =
      input.isWorkspaceTrusted ??
      (options.isWorkspaceTrusted !== undefined ? options.isWorkspaceTrusted() : true);
    if (!trusted) {
      return {
        allowed: false,
        refusal: createWorkflowRefusalOutcome({
          category: 'policy-refusal',
          reasonCode: 'policy-denied:untrusted-workspace',
          message: 'Workspace trust is required before admitting workflow execution.',
          rootExecutionId: input.rootExecutionId,
          invocationId: input.invocationId,
          attemptsConsumed: 0
        })
      };
    }

    if (input.isFenceValid === false) {
      return {
        allowed: false,
        refusal: createWorkflowRefusalOutcome({
          category: 'stale-fence',
          reasonCode: 'stale-primacy-fence',
          message: 'Window primacy or queue execution lease fence is stale at the effect boundary.',
          rootExecutionId: input.rootExecutionId,
          invocationId: input.invocationId,
          attemptsConsumed: 0
        })
      };
    }

    if (input.resourceBudget !== undefined) {
      const budgetResult = evaluateResourceBudgetBoundary({
        ...input.resourceBudget,
        rootExecutionId: input.rootExecutionId ?? input.resourceBudget.rootExecutionId,
        invocationId: input.invocationId ?? input.resourceBudget.invocationId
      });
      if (!budgetResult.allowed) return budgetResult;
    }

    for (const collab of input.requiredCollaborators ?? []) {
      if (!isCollaboratorSupplied(collab)) {
        return {
          allowed: false,
          refusal: createWorkflowRefusalOutcome({
            category: 'missing-collaborator',
            reasonCode: `collaborator-absent:${collab}`,
            message: `Required workflow control collaborator '${collab}' is absent in the active composition.`,
            rootExecutionId: input.rootExecutionId,
            invocationId: input.invocationId,
            attemptsConsumed: 0
          })
        };
      }
    }

    for (const reqCap of input.requiredCapabilities ?? []) {
      const assessment = assessCapability(reqCap.backendId, reqCap.capability);
      const fixtureDisallowed =
        assessment.source === 'fixture-adapter' &&
        (reqCap.requireLiveQualification === true || !allowFixtureCapabilities);
      if (assessment.status !== 'verified' || fixtureDisallowed) {
        return {
          allowed: false,
          refusal: createWorkflowRefusalOutcome({
            category: 'unsupported-capability',
            reasonCode: fixtureDisallowed
              ? `fixture-capability-not-live-qualified:${reqCap.backendId}:${reqCap.capability}`
              : assessment.reasonCode,
            message: `Backend '${reqCap.backendId}' capability '${reqCap.capability}' is ${
              fixtureDisallowed ? 'fixture-only and not live-qualified' : assessment.status
            }.`,
            rootExecutionId: input.rootExecutionId,
            invocationId: input.invocationId,
            attemptsConsumed: 0
          })
        };
      }
    }

    if (input.isQuotaDeferred?.deferred === true) {
      return {
        allowed: false,
        refusal: createWorkflowRefusalOutcome({
          category: 'quota-deferred',
          reasonCode: input.isQuotaDeferred.reasonCode ?? 'quota-permit-deferred',
          message:
            input.isQuotaDeferred.message ??
            'Shared quota permit is currently unavailable; execution is deferred until availability wakeup.',
          rootExecutionId: input.rootExecutionId,
          invocationId: input.invocationId,
          attemptsConsumed: 0
        })
      };
    }

    return { allowed: true };
  };

  const ensureRootControlLink = async (
    run: ConnectedWorkflowRun,
    queueId?: string
  ): Promise<ConnectedWorkflowRun> => {
    const boundQueueId = queueId ?? resolveBoundQueueId(run);
    const ledgerRunId = run.controlState?.ledgerRunId ?? run.connectedRunId;
    const fence = resolveFence(run, boundQueueId);
    const existingRoot = ledgerStore.getRoot(ledgerRunId);
    const rootInvId = resolveRootInvocationId(run);
    if (existingRoot === null) {
      const prepared = await controlAdmission.prepareRootLink({
        ledgerRunId,
        connectedRunId: run.connectedRunId,
        rootWorkflowId: run.workflowId,
        queueId: boundQueueId,
        fence,
        rootFrameKey: rootInvId,
        rootInvocationId: rootInvId
      });
      if (prepared.ok) {
        await controlAdmission.activateRootLink({
          ledgerRunId,
          connectedRunId: run.connectedRunId,
          fence
        });
        if (run.controlState === undefined) {
          return Object.freeze({ ...run, controlState: prepared.controlState });
        }
      }
    } else if (existingRoot.linkState === 'prepared') {
      await controlAdmission.activateRootLink({
        ledgerRunId,
        connectedRunId: run.connectedRunId,
        fence
      });
    }
    return run;
  };

  const evaluateSettlementOutcome = async (
    input: SettlementEvaluationInput
  ): Promise<SettlementEvaluationResult> => {
    const declaredOutputs =
      input.declaredOutputs ?? buildDeclaredOutputsFromRunOutputs(input.runOutputs);
    const contract = input.resultContract ?? input.phase?.resultContract;

    if (!isCollaboratorSupplied('resultOperator') && contract !== undefined) {
      const refusal = createWorkflowRefusalOutcome({
        category: 'missing-collaborator',
        reasonCode: 'collaborator-absent:resultOperator',
        message: 'Required collaborator resultOperator is absent at settlement.',
        attemptId: input.attemptId,
        attemptsConsumed: 1
      });
      return Object.freeze({
        status: 'failed',
        declaredOutputs: Object.freeze({}),
        verdict: 'fail',
        failureCode: refusal.reasonCode,
        refusal
      });
    }

    if (contract === undefined) {
      return Object.freeze({
        status: input.status,
        declaredOutputs,
        verdict: input.status === 'completed' ? 'pass' : 'fail'
      });
    }

    const declaredOutputsByKey: Record<string, string> = {};
    for (const [key, portVal] of Object.entries(declaredOutputs)) {
      if (typeof portVal.value === 'string') declaredOutputsByKey[key] = portVal.value;
    }

    const evaluated = await resultOperator.evaluateWithPrecedence({
      attemptId: input.attemptId,
      workspaceRoot: input.workspaceRoot,
      resultContract: contract,
      declaredOutputsByKey,
      ...(input.backendResultText !== undefined
        ? { backendResultText: input.backendResultText }
        : {}),
      ...(input.diagnosticRecordsText !== undefined
        ? { diagnosticRecordsText: input.diagnosticRecordsText }
        : {}),
      ...(input.backendDiagnostic !== undefined
        ? { backendDiagnostic: input.backendDiagnostic }
        : {}),
      ...(input.conflictingBackendDiagnostic !== undefined
        ? { conflictingBackendDiagnostic: input.conflictingBackendDiagnostic }
        : {}),
      ...(input.hostControl !== undefined ? { hostControl: input.hostControl } : {}),
      ...(input.evaluatedAt !== undefined ? { evaluatedAt: input.evaluatedAt } : {})
    });

    if (evaluated.kind === 'host-control') {
      const isCanceled = evaluated.hostControl === 'cancelled';
      return Object.freeze({
        status: isCanceled ? 'canceled' : 'failed',
        declaredOutputs: Object.freeze({}),
        verdict: 'fail',
        failureCode: `host-control:${evaluated.hostControl}`
      });
    }

    const { outcome } = evaluated;
    if (outcome.status === 'done') {
      const rawVerdict = outcome.values.verdict;
      const verdict: 'pass' | 'fail' =
        rawVerdict === 'fail' || rawVerdict === false ? 'fail' : 'pass';
      return Object.freeze({
        status: input.status === 'completed' ? 'completed' : input.status,
        declaredOutputs,
        decisionResults: Object.freeze({ ...outcome.values }),
        verdict
      });
    }

    return Object.freeze({
      status: 'failed',
      declaredOutputs: Object.freeze({}),
      ...(Object.keys(outcome.values).length > 0
        ? { decisionResults: Object.freeze({ ...outcome.values }) }
        : {}),
      verdict: 'fail',
      failureCode: `typed-result-${outcome.status}:${outcome.reason}`
    });
  };

  const recordAvailabilityWakeup = async (input: {
    readonly quotaId: string;
    readonly backend: BackendRunnerKind;
    readonly ready: boolean;
    readonly capacity?: number | undefined;
    readonly resetAtWallMs?: number | undefined;
    readonly queueId?: string | undefined;
  }): Promise<ProductionAvailabilityWakeupResult> => {
    const nowWallMs = clock.nowWallMs();
    const nowMonotonicMs = clock.nowMonotonicMs();
    const mutated = await ledgerStore.mutate({}, ({ ledger }) => ({
      commit: true,
      plan: {
        nextLedger: {
          ...ledger,
          quotaObservations: {
            ...ledger.quotaObservations,
            [input.quotaId]: {
              quotaKey: input.quotaId,
              observationId: input.quotaId,
              quotaId: input.quotaId,
              generation: 1,
              backend: input.backend,
              status: input.ready ? 'ready' : 'cooldown-unknown',
              source: 'qualified-status',
              observedAt: nowWallMs,
              observedMonotonicAt: nowMonotonicMs,
              hostEpoch,
              pollIndex: 0,
              capacity: input.capacity ?? 1,
              checkAttempts: 1,
              ...(input.resetAtWallMs !== undefined ? { resetAt: input.resetAtWallMs } : {})
            }
          }
        },
        result: true
      }
    }));

    let schedulerNotified = false;
    if (mutated.ok && input.ready) {
      await options.onScheduleQueueWakeup?.(input.queueId);
      schedulerNotified = true;
    }

    return Object.freeze({
      observationRecorded: mutated.ok,
      schedulerNotified,
      spawnedDirectly: false as const
    });
  };

  const createCoordinatorDeps = (coordOptions: {
    readonly connectedRuns: ConnectedRunWriter;
    readonly dispatchPhase: (input: PhaseAttemptDispatchInput) => Promise<PhaseAttemptDispatchResult>;
    readonly workspaceRoot?: string | undefined;
    readonly cancelOrphanedQueueItem?: ((queueItemId: string, queueId: string) => Promise<void> | void) | undefined;
  }): ComposableWorkflowCoordinatorDeps => {
    const effectiveRoot = coordOptions.workspaceRoot ?? options.workspaceRoot;
    return {
      connectedRuns: coordOptions.connectedRuns,
      dispatchPhase: coordOptions.dispatchPhase,
      ...(isCollaboratorSupplied('controlAdmission') ? { controlAdmission: coordinatorControlAdmissionPort } : {}),
      ...(isCollaboratorSupplied('repeatExecutor') ? { repeatExecutor } : {}),
      ...(isCollaboratorSupplied('forEachExecutor') ? { forEachExecutor } : {}),
      ...(options.phaseHandoffCoordinator !== undefined ? { phaseHandoffCoordinator: options.phaseHandoffCoordinator } : {}),
      ...(effectiveRoot !== undefined ? { workspaceRoot: effectiveRoot } : {}),
      resolveExecutionFence: resolveFence,
      ...(coordOptions.cancelOrphanedQueueItem !== undefined ? { cancelOrphanedQueueItem: coordOptions.cancelOrphanedQueueItem } : {})
    };
  };

  const createControlService = (
    svcOptions: Omit<WorkflowControlServiceDeps, 'controlAdmission' | 'repeatExecutor' | 'forEachExecutor' | 'workspaceRoot' | 'resolveExecutionFence' | 'controlCommandService'> & { readonly workspaceRoot?: string | undefined }
  ): WorkflowControlService => {
    const effectiveRoot = svcOptions.workspaceRoot ?? options.workspaceRoot;
    return new WorkflowControlService({
      ...svcOptions,
      ...(isCollaboratorSupplied('controlAdmission') ? { controlAdmission: coordinatorControlAdmissionPort } : {}),
      ...(isCollaboratorSupplied('repeatExecutor') ? { repeatExecutor } : {}),
      ...(isCollaboratorSupplied('forEachExecutor') ? { forEachExecutor } : {}),
      ...(options.phaseHandoffCoordinator !== undefined ? { phaseHandoffCoordinator: options.phaseHandoffCoordinator } : {}),
      ...(effectiveRoot !== undefined ? { workspaceRoot: effectiveRoot } : {}),
      resolveExecutionFence: resolveFence,
      ...(isCollaboratorSupplied('controlCommandService') ? { controlCommandService } : {})
    });
  };

  const createRecoveryService = (
    recOptions: Omit<WorkflowRecoveryServiceDeps, 'controlAdmission' | 'repeatExecutor' | 'forEachExecutor' | 'workspaceRoot' | 'quotaPermitArbiter' | 'notificationService' | 'usageAccounting' | 'resolveRecoveryFence'> & { readonly workspaceRoot?: string | undefined }
  ): WorkflowRecoveryService => {
    const effectiveRoot = recOptions.workspaceRoot ?? options.workspaceRoot;
    return new WorkflowRecoveryService({
      ...recOptions,
      ...(isCollaboratorSupplied('controlAdmission')
        ? { controlAdmission: coordinatorControlAdmissionPort }
        : {}),
      ...(isCollaboratorSupplied('repeatExecutor') ? { repeatExecutor } : {}),
      ...(isCollaboratorSupplied('forEachExecutor') ? { forEachExecutor } : {}),
      ...(options.phaseHandoffCoordinator !== undefined ? { phaseHandoffCoordinator: options.phaseHandoffCoordinator } : {}),
      ...(effectiveRoot !== undefined ? { workspaceRoot: effectiveRoot } : {}),
      ...(isCollaboratorSupplied('quotaPermitArbiter') ? { quotaPermitArbiter } : {}),
      notificationService,
      usageAccounting,
      resolveRecoveryFence: resolveFence
    });
  };

  return Object.freeze({
    compositionId: 'ProductionWorkflowComposition' as const,
    workspaceRoot: options.workspaceRoot,
    clock,
    ledgerStore,
    quotaPermitArbiter,
    controlAdmission,
    repeatExecutor,
    forEachExecutor,
    candidateBlockExecutor,
    resultOperator,
    controlCommandService,
    notificationService,
    usageAccounting,
    availabilityService,
    wakeupPlanner,
    durableHandoffSeam,
    cutoverAuthorityGuard,
    ...(options.phaseHandoffCoordinator !== undefined ? { phaseHandoffCoordinator: options.phaseHandoffCoordinator } : {}),
    getEntryPointCensus: () => getEntryPointWiringCensus(collaboratorOverrides),
    isCollaboratorSupplied,
    assessCapability,
    verifyPreAdmission,
    ensureRootControlLink,
    evaluateSettlementOutcome,
    recordAvailabilityWakeup,
    createCoordinatorDeps,
    createControlService,
    createRecoveryService,
    dispose: () => wakeupPlanner.dispose()
  });
}

const compositionCacheByStore = new WeakMap<object, ProductionWorkflowComposition>();

export function registerProductionWorkflowComposition(
  storeKey: object,
  composition: ProductionWorkflowComposition
): void {
  compositionCacheByStore.set(storeKey, composition);
}

export function getOrCreateProductionWorkflowComposition(
  storeKey: object,
  options?: ProductionWorkflowCompositionOptions
): ProductionWorkflowComposition {
  if (
    options?.collaboratorOverrides !== undefined ||
    options?.cutoverAuthorityGuard !== undefined ||
    options?.durableHandoffSeam !== undefined ||
    options?.assessBackendCapability !== undefined ||
    options?.resolveExecutionFence !== undefined ||
    options?.verifyLiveFence !== undefined
  ) {
    return createProductionWorkflowComposition({
      ...(isControlLedgerBackingStore(storeKey) ? { store: storeKey } : {}),
      ...options
    });
  }
  const existing = compositionCacheByStore.get(storeKey);
  if (existing !== undefined) return existing;
  const created = createProductionWorkflowComposition({
    ...(isControlLedgerBackingStore(storeKey) ? { store: storeKey } : {}),
    ...options
  });
  compositionCacheByStore.set(storeKey, created);
  return created;
}
