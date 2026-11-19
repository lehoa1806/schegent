// FR-R7-05 — All host-mirrored snapshot types and `SCHEMA_VERSION` are
// generated from `scripts/contracts/snapshot-descriptors.mjs` into
// `./generated/snapshot-mirror.ts` (zero `repo/src/` imports) and re-exported
// here so all webview consumers keep importing from `./snapshot-types`.
import {
  SCHEMA_VERSION,
  type BackendPingFailureCause,
  type BackendPingState,
  type CatalogVersionRef,
  type EvidenceHealthProjection,
  type GeneralSettings,
  type GeneralSettingsProjection,
  type HistoryEntry,
  type InFlightRunProjection,
  type PhaseCatalogProjection,
  type PipelineCatalogProjection,
  type QueueItem,
  type QueueProjection,
  type QueueRuntime,
  type RunOriginRef,
  type TransportDropCounts,
  type WorkflowCatalogProjection,
  type WorkflowSnapshot
} from './generated/snapshot-mirror.js';

export { SCHEMA_VERSION };
export type {
  BackendPingFailureCause,
  BackendPingState,
  CatalogVersionRef,
  EvidenceHealthProjection,
  GeneralSettings,
  GeneralSettingsProjection,
  HistoryEntry,
  InFlightRunProjection,
  PhaseCatalogProjection,
  PipelineCatalogProjection,
  QueueItem,
  QueueProjection,
  QueueRuntime,
  RunOriginRef,
  TransportDropCounts,
  WorkflowCatalogProjection,
  WorkflowSnapshot
};

import type {
  DelayedRetryState,
  LiveActivity,
  SessionArtifactsProjection,
  StreamPressureProjection,
  WorkflowCatalogFieldErrorProjection,
  BuilderLifecycle,
  QueueSettingsProjection
} from '../../../src/contracts/snapshot-projections.js';
// FR-R3-145 (T1572) — value imports for `IDLE_QUEUE_SETTINGS`, from the same
// contract leaves the host reads. See that constant for why they are not literals.
import { DEFAULT_GLOBAL_CONCURRENCY_CAP } from '../../../src/contracts/queue-bounds.js';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity.js';
// FR-R3-144 (T007) — value import, same edge and same reason as the two above.
import {
  DEFAULT_BACKEND,
  type BackendRunnerKind
} from '../../../src/contracts/backend-kinds.js';
// FR-R3-144 (T020, D-4) — imported, not mirrored. Everything else in this file
// restates a host type by hand and is kept honest by a drift test; the posture
// types are the one thing that must not be restatable, because a webview-side
// copy of `BackendGrantState` is one edit away from becoming a webview-side
// DERIVATION of it — which is what T024's gate forbids. One declaration, read
// from the same module the composer reads.
import type {
  BackendGrantEntryProblems,
  BackendGrantState,
  BackendPosture,
} from '../../../src/contracts/sidebar-ipc/uncontained-grant.js';
export type { BackendGrantEntryProblems, BackendGrantState, BackendPosture };
import type {
  PhaseEvidencePolicy,
  PhaseHostVerification,
  PhaseSideEffects,
  PhaseSourceStatus,
  RetryCapOutcome,
} from '../../../src/contracts/process-definitions.js';
// FR-R3-157 (T047) — re-exported, unlike its three neighbours above, because the
// builder's own row type names this field and must spell its type. The neighbours
// are only ever read off a `PortablePhaseDefinition`, so nothing downstream needs
// the bare name.
export type { RetryCapOutcome };
import type { PhaseCapability } from '../../../src/contracts/phase-capabilities.js';
import type {
  PipelineInputPortType,
  PipelineOutputPortType,
  PipelineSourceStatus
} from '../../../src/contracts/pipeline-definitions.js';
import type {
  WorkflowSourceStatus,
} from '../../../src/contracts/workflow-definitions.js';

import type { PhaseDefinitionEffort } from '../../../src/contracts/process-definitions.js';

// FR-R3-132 (T1502, FR-001) — WHAT IS STILL HAND-WRITTEN HERE, AND WHY.
//
// The measurement that opened this file's cleanup found 97 declarations in three
// classes. 51 were byte-identical to a host declaration and are gone. What is left
// is deliberate, and each class says so:
//
//   OPTIONALITY WIDENED AT THE RECEIVER (F3). `QueueItem.queueId`,
//   `QueueProjection.queues`, `.pausedReason`, `.lifecycle`, `.scheduledStartAt`
//   and `.scheduledStartSource` are required on the host and optional here. That
//   is a real decision: a webview may be asked to render a snapshot published by a
//   host one version behind, and a required field it has never seen is a crash
//   rather than a degraded panel. It was previously undocumented, which made it
//   indistinguishable from drift.
//
//   THE `Portable*` EDITOR SHAPES (F4). `PortablePhaseDefinition`,
//   `PortablePipelineDefinition` and their neighbours describe what the BUILDER
//   edits and what the YAML boundary exchanges — `id`/`phases`, not
//   `pipelineId`/`phaseIds`, and an interface rather than the host's discriminated
//   union. Four of them used to carry the runtime shapes' names, which made two
//   different concepts look like one drifting concept: the most expensive kind of
//   duplication, because every reader has to rediscover that it is not one.
//
//   THE 26 WEBVIEW-LOCAL DECLARATIONS. View state. Nothing to import.
//
// `tests/lint/snapshot-mirror-census.test.ts` holds the first class at zero and
// checks every union in the second as a superset of the host's, so a deliberate
// difference cannot quietly become a missing member.

import type {
  PipelineDefinition as PortablePipelineDefinition
} from '../../../src/contracts/pipeline-definitions.js';
import type {
  WorkflowDefinition as PortableWorkflowDefinition
} from '../../../src/contracts/workflow-definitions.js';

// FR-R3-132 (T1502, FR-001) — THE SECOND WAVE, which the first gate could not see.
//
// The name-keyed census found 51 copies. Fixing the two drifted declarations then
// made five MORE identical — a copy whose only difference was the defect. And a
// name-independent comparison found three the first pass structurally could not:
// the webview's word for a host shape is not the host's word, so
// `PortablePipelineDefinition` and host `PipelineDefinition` were the same
// declaration under two names, invisible to a lookup keyed on the name.
//
// Aliased at the re-export rather than renamed at the call sites. `Portable*` is
// the right word HERE — it distinguishes the definition the builder edits and the
// YAML boundary exchanges from the snapshot's selection-list projection, which is a
// genuinely different shape that keeps the plain name in this file. Renaming 60-odd
// component references to make one import shorter would have traded a real
// distinction for a shorter line.
export type {
  AuditTailEntry,
  BuilderLifecycle,
  BuilderVersionEntry,
  QueueSettingsProjection,
  QueueSummary
} from '../../../src/contracts/snapshot-projections.js';
export type { RunOutputRecord } from '../../../src/contracts/run-results.js';
export type {
  PipelineDefinition as PortablePipelineDefinition
} from '../../../src/contracts/pipeline-definitions.js';
export type {
  WorkflowDefinition as PortableWorkflowDefinition
} from '../../../src/contracts/workflow-definitions.js';
export type {
  IpcScheduledStartSource as ScheduledStartSource
} from '../../../src/contracts/start-intent-types.js';

// FR-R3-132 (T1502) — two more the STRUCTURAL half of the census found: the same
// declarations under different names, which a name-keyed lookup cannot see. The
// webview's words are kept at the alias, because they are the better words HERE —
// `PipelineDefinition` is what the snapshot's selection list holds, and
// `EvidenceSinkHealthProjection` says it is a projection.
import type {
  EvidenceSinkHealth as EvidenceSinkHealthProjection,
  PipelineDef as PipelineDefinition
} from '../../../src/contracts/snapshot-vocabulary.js';

export type {
  EvidenceSinkHealthProjection,
  PipelineDefinition
};

// FR-R3-132 (T1502) — the THIRD wave, and the one that says most about gates.
// A first census walked three host directories and reported zero copies. A review
// pointed at four byte-identical declarations in `src/services/`; widening the
// walk to `src/` turned zero into thirteen. All thirteen moved to
// `src/contracts/snapshot-vocabulary.ts` and are imported here.
import type {
  ChangedCollectionField,
  ChangedField,
  ChangedFieldSummary,
  ChangedScalarField,
  DebugLogEntry,
  EvidenceContinuationPolicy,
  EvidenceOverallStatus,
  EvidenceSinkStatus,
  QueueLifecycle,
  RuntimeLogLevel,
  SettingScope,
  TelemetrySnapshot,
  TelemetryStatus
} from '../../../src/contracts/snapshot-vocabulary.js';

export type {
  ChangedCollectionField,
  ChangedField,
  ChangedFieldSummary,
  ChangedScalarField,
  DebugLogEntry,
  EvidenceContinuationPolicy,
  EvidenceOverallStatus,
  EvidenceSinkStatus,
  QueueLifecycle,
  RuntimeLogLevel,
  SettingScope,
  TelemetrySnapshot,
  TelemetryStatus
};

// FR-R3-132 (T1502, FR-001) — RE-EXPORTED, NOT RETYPED.
//
// 51 declarations in this file were byte-identical to a host declaration: 315
// lines of copy kept in step by hand, deciding nothing. They are gone, and the
// types below come from the host contracts they always described.
//
// A TYPE IMPORT IS ERASED at compile time, so none of this reaches the webview
// bundle — the distinction `webview-host-import-direction.test.ts` draws between
// types (from anywhere) and values (from `contracts/` only). Everything here is a
// type and everything here is in `src/contracts/`.
//
// THE COST OF THE COPY WAS MEASURED, not assumed: the mirror's
// `QueueSummary.pauseSource` had lost `'retry-cap'`, a value the host can send
// and the webview's type said could not exist. No parity test covered it.
// `tests/lint/snapshot-mirror-census.test.ts` now holds the identical count at
// zero and checks every remaining hand-written union as a superset of the host's.
export type {
  ActiveFeatureSummary,
  ActivePipelineSummary,
  AuditCategory,
  CapabilityNotice,
  CliMonitorState,
  CreditPollingProjection,
  DegradedPhaseEntry,
  DelayedRetryCauseProjection,
  DelayedRetryState,
  EffectiveLimit,
  EffectiveLimitsProjection,
  LimitOrigin,
  FreshnessState,
  LaunchProjection,
  LaunchSection,
  Launchable,
  LaunchableNodeSummary,
  LaunchableOutputPort,
  LaunchablePort,
  LiveActivity,
  MonitorStatus,
  PhaseResultState,
  PhaseState,
  PhaseTile,
  QueueItemStatus,
  RunLivenessProjection,
  RunProgressProjection,
  SessionArtifactsProjection,
  StreamPressureProjection,
  SubProgress,
  TaskPhaseProgressProjection,
  WorkflowCatalogFieldErrorProjection,
  WorkflowStatus
} from '../../../src/contracts/snapshot-projections.js';
// Bug "there is no way to start a pending task" (2026-09-02) — a VALUE re-export,
// from the contract leaf rather than restated here. The webview has to tell a
// queue that owns a Run from a queue that is working one, and the list of
// statuses that ends a Run is the host's to define; a mirror copy could drift
// into disagreeing with the projector that writes the field.
export {
  TERMINAL_WORKFLOW_STATUSES,
  isTerminalWorkflowStatus
} from '../../../src/contracts/snapshot-projections.js';
export type {
  BackendRunnerKind
} from '../../../src/contracts/backend-kinds.js';
export type {
  PhaseName
} from '../../../src/contracts/phase-identity.js';
export {
  CONTROL_ACTION_KINDS,
  CONTROL_COMMAND_REFUSAL_REASONS,
  CONTROL_COMMAND_VERSION,
  type ConnectedForEachNodeProjection,
  type ConnectedForEachSlotProjection,
  type ConnectedInvocationAttemptProjection,
  type ConnectedInvocationProjection,
  type ConnectedNodeAction,
  type ConnectedNodeProjection,
  type ConnectedNodeState,
  type ConnectedRepeatCompletedPassProjection,
  type ConnectedRepeatNodeProjection,
  type ConnectedRunProjection,
  type ControlAction,
  type ControlActionKind,
  type ControlCandidateProjection,
  type ControlCommandAcknowledgement,
  type ControlCommandEnvelope,
  type ControlCommandRefusalReason,
  type ControlLegalActionEntry,
  type ControlProjection,
  type WorkflowControlAction
} from '../../../src/contracts/sidebar-ipc/workflow-run.js';
export {
  TYPED_CONDITION_OPERATORS,
  TYPED_CONDITION_VERSION,
  type DecisionFieldType,
  type DecisionFieldValue,
  type TypedCondition,
  type TypedConditionTest,
  type TypedLeaf,
  type TypedOperand,
  type TypedOperator
} from '../../../src/contracts/decision-results.js';
export {
  CANDIDATE_AVAILABILITY_POLICIES,
  DEFAULT_CANDIDATE_ATTEMPTS,
  DEFAULT_CANDIDATE_AVAILABILITY_POLICY,
  DEFAULT_CANDIDATE_BLOCK_DISPATCHES,
  DEFAULT_FOR_EACH_MAX_ITEMS,
  DEFAULT_FOR_EACH_ON_ITEM_ERROR,
  DEFAULT_MONITORING_WINDOW_MS,
  DEFAULT_REPEAT_ON_EXHAUSTED,
  FOR_EACH_COLLECTION_SOURCES,
  FOR_EACH_ON_ITEM_ERROR_POLICIES,
  MAX_CANDIDATE_ATTEMPTS,
  MAX_CANDIDATE_BLOCK_DISPATCHES,
  MAX_CANDIDATES_PER_BLOCK,
  MAX_FOR_EACH_MAX_ITEMS,
  MAX_MONITORING_WINDOW_MS,
  MAX_REPEAT_CARRY_MAPPINGS,
  MAX_REPEAT_ITERATIONS,
  MIN_CANDIDATE_ATTEMPTS,
  MIN_CANDIDATE_BLOCK_DISPATCHES,
  MIN_CANDIDATES_PER_BLOCK,
  MIN_FOR_EACH_MAX_ITEMS,
  MIN_MONITORING_WINDOW_MS,
  MIN_REPEAT_ITERATIONS,
  REPEAT_ON_EXHAUSTED_POLICIES,
  type CandidateAvailabilityPolicy,
  type CandidateBlockControl,
  type CandidateBudgetControl,
  type CandidateSpec,
  type CandidateRetryPolicy,
  type ForEachCollectionSource,
  type ForEachControl,
  type ForEachItemErrorPolicy,
  type RepeatCarryMapping,
  type RepeatControl,
  type RepeatExhaustedPolicy,
  type WorkflowDecisionResults,
  type WorkflowNodeControl
} from '../../../src/contracts/workflow-controls.js';
export {
  describeBranchDisposition,
  describeExitReason,
  EXECUTION_BRANCH_DISPOSITIONS,
  EXECUTION_DECISION_CAP_OUTCOMES,
  EXECUTION_DECISION_EXIT_REASONS,
  EXECUTION_DECISION_OBSERVATION_VERSION,
  formatConditionSummary,
  formatPhaseRetrySummary,
  type ExecutionBranchDisposition,
  type ExecutionDecisionBranchRecord,
  type ExecutionDecisionCapOutcome,
  type ExecutionDecisionExitReason,
  type ExecutionDecisionObservation,
  type ExecutionDecisionSettingSources
} from '../../../src/contracts/execution-decision-observation.js';
export type {
  PhaseSourceStatus
} from '../../../src/contracts/process-definitions.js';
export type {
  DefinitionState
} from '../../../src/contracts/catalog-lifecycle.js';
export type {
  PhaseBinding,
  PhaseInputBinding,
  PhaseOutputBinding,
  PipelineCatalogMutation,
  PipelineInputPort,
  PipelineInputPortType,
  PipelineOutputPort,
  PipelineOutputPortType,
  PipelineSourceStatus
} from '../../../src/contracts/pipeline-definitions.js';
export type {
  WorkflowBinding,
  WorkflowCatalogMutation,
  WorkflowCondition,
  WorkflowConditionLiteral,
  WorkflowConditionOperand,
  WorkflowConditionOperator,
  WorkflowConnection,
  WorkflowHandoffMode,
  WorkflowInputBinding,
  WorkflowInputBindingSource,
  WorkflowInputPort,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowNodeTerminalStatus,
  WorkflowOutputBinding,
  WorkflowOutputPort,
  WorkflowSelectionRule,
  WorkflowSourceStatus
} from '../../../src/contracts/workflow-definitions.js';

// FR-R3-132 (T1502) — `EFFORT_LEVELS` was declared identically here and in
// `src/contracts/process-definitions.ts` as `PHASE_EFFORT_LEVELS`. This is a VALUE,
// not a type, and `webview-host-import-direction.test.ts` permits values from
// `contracts/` — which is where it already was.
export { PHASE_EFFORT_LEVELS as EFFORT_LEVELS } from '../../../src/contracts/process-definitions.js';
export type Effort = PhaseDefinitionEffort;

export interface PhaseDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version?: number;
  readonly instruction?: string;
  readonly skill?: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly timeoutSeconds?: number;
  readonly loopable?: boolean;
  readonly retryCondition?: string;
  readonly isRequired?: boolean;
  readonly runner?: BackendRunnerKind;
}

/**
 * A projected catalog record's definition — what the Builder fills its editor
 * from, and therefore what it can serialise back.
 *
 * THE DECLARED FIELDS ARE NOT DECORATION HERE. This shape named thirteen of the
 * twenty-one names in `AUTHORED_PHASE_FIELDS`, and the Builder's save body could
 * only forward what the row received — so `capabilities`, the sole array-valued
 * authored field and the one `display` cannot carry, never arrived and was
 * dropped on every save. Omission means every capability, so a narrowed phase
 * silently regained full authority on an unrelated edit.
 */
export interface PortablePhaseDefinition {
  readonly phaseId: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly instruction?: string;
  readonly skill?: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly timeoutSeconds?: number;
  readonly loopable?: boolean;
  readonly retryCondition?: string;
  readonly isRequired?: boolean;
  readonly runner?: BackendRunnerKind;
  readonly sideEffects?: PhaseSideEffects;
  readonly evidencePolicy?: PhaseEvidencePolicy;
  readonly hostVerification?: PhaseHostVerification;
  readonly capabilities?: readonly PhaseCapability[];
  readonly spendBoundUsd?: number;
  readonly spendBoundTokens?: number;
  readonly forceContinueOnRetryCap?: boolean;
  // FR-R3-157 (T046) — the second carrier, and a different declaration from the
  // `QueueItem` mirror further down this file. The host projection already copies
  // this field onto the record (`phase-catalog-projection.ts`); a shape that did
  // not declare it would drop it on the way into the editor, which is the exact
  // failure the note above records for `capabilities`.
  readonly onRetryCap?: RetryCapOutcome;
}

export interface PhaseCatalogSourceRecord {
  readonly key: string;
  readonly phaseId: string;
  readonly status: PhaseSourceStatus;
  readonly definition: PortablePhaseDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly {
    readonly field: string;
    readonly code: string;
    readonly message: string;
  }[];
  readonly modelAvailable?: boolean;
  /** Feature 101 (FR-005, FR-007) — absent on a host with no catalog store wired. */
  readonly lifecycle?: BuilderLifecycle;
}

/**
 * Session-input port types (FR-012). `pipeline-output` is the declared type an
 * input port uses when an earlier Phase's output feeds it rather than the
 * operator at session start.
 */
export const PIPELINE_INPUT_PORT_TYPES = [
  'text',
  'source',
  'source-list',
  'local-file',
  'local-folder',
  'web-url',
  'pipeline-output',
  'repository-context'
] as const;

/** Declared artifact types a Pipeline produces (FR-013). */
export const PIPELINE_OUTPUT_PORT_TYPES = [
  'markdown',
  'file',
  'file-set',
  'structured-data',
  'run-request',
  'external-reference'
] as const;

/** Advisory Run-creation defaults; host-owned runtime policy is not authorable. */
export interface PipelineExecutionDefaults {
  readonly runner?: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly timeoutSeconds?: number;
}

export interface PipelineCatalogSourceRecord {
  readonly key: string;
  readonly pipelineId: string;
  readonly status: PipelineSourceStatus;
  readonly definition: PortablePipelineDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly {
    readonly field: string;
    readonly code: string;
    readonly message: string;
  }[];
  readonly modelAvailable?: boolean;
  /**
   * FR-002 — Workflows that still resolve this `pipelineId` from the catalog.
   * Absent on a host that exposes no Workflow references; the editor renders an
   * empty list rather than asserting there are none.
   */
  readonly consumingWorkflowIds?: readonly string[];
  /** Feature 101 (FR-005, FR-007) — absent on a host with no catalog store wired. */
  readonly lifecycle?: BuilderLifecycle;
}

/** Collection selection rules; `exactlyOne` fails at run time on any size but one. */
export const WORKFLOW_SELECTION_RULES = ['first', 'last', 'exactlyOne'] as const;

/**
 * Closed comparison operator set. Adding a member is a contract change, not a
 * configuration change — there is no operator registry and no way for an
 * authored definition to introduce one.
 */
export const WORKFLOW_CONDITION_OPERATORS = [
  'equals',
  'notEquals',
  'in',
  'exists',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual'
] as const;

/** Terminal run statuses a `node-status` operand may be compared against. */
export const WORKFLOW_NODE_TERMINAL_STATUSES = ['completed', 'failed', 'canceled'] as const;

/**
 * Derived at projection time and absent from the persisted row: a Workflow's
 * inputs are the node input ports no connection binds, and its outputs are the
 * node output ports no connection consumes.
 */
export interface WorkflowCatalogPortProjection {
  readonly nodeId: string;
  readonly portId: string;
  readonly label: string;
  readonly type: PipelineInputPortType | PipelineOutputPortType;
}

export interface WorkflowCatalogSourceProjection {
  readonly key: string;
  readonly workflowId: string;
  readonly status: WorkflowSourceStatus;
  readonly definition: PortableWorkflowDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly WorkflowCatalogFieldErrorProjection[];
  readonly derivedInputs: readonly WorkflowCatalogPortProjection[];
  readonly derivedOutputs: readonly WorkflowCatalogPortProjection[];
  /** Feature 101 (FR-005, FR-007) — absent on a host with no catalog store wired. */
  readonly lifecycle?: BuilderLifecycle;
}

export const IDLE_DELAYED_RETRY: DelayedRetryState = Object.freeze({
  pendingRetryAt: null,
  pendingRetryCause: null,
  delayedRetryCount: 0
});

/**
 * FR-R3-145 (T1572) — what the webview shows before the host sends a snapshot,
 * and what it falls back to when an older host bundle omits `queueSettings`.
 *
 * Derived from the same two contract constants the host derives from, imported
 * rather than restated. `history-rerun.ts:27` already value-imports
 * `DEFAULT_QUEUE_ID` from the same leaf, so this is the established edge and not
 * a new one. The alternative — two literals here — is how
 * `IDLE_GENERAL_SETTINGS.invocationIdleTimeoutSeconds` came to say 1800 for the
 * width of a release while every other surface said 5400.
 */
export const IDLE_QUEUE_SETTINGS: QueueSettingsProjection = Object.freeze({
  globalConcurrencyCap: DEFAULT_GLOBAL_CONCURRENCY_CAP,
  defaultQueueId: DEFAULT_QUEUE_ID
});

export const IDLE_GENERAL_SETTINGS: GeneralSettings = Object.freeze({
  cliPath: 'claude',
  codexPath: 'codex',
  agyPath: 'agy',
  loggingVerbose: false,
  loopMaxIterations: 10,
  // FR-R3-051 (M-06) — 5400, matching the manifest, the host fallback and the
  // host idle snapshot. This surface alone said 1800, so the sidebar showed a
  // timeout no install has until the host sent real settings.
  invocationIdleTimeoutSeconds: 5400,
  invocationMaxDurationSeconds: 21600,
  watchdogPollIntervalMinutes: 30,
  auditRotationSizeMB: 5,
  auditRotationMaxAgeDays: 30,
  // Feature 056 Track 3 (FR-013) — host default, package contribution
  // default and this idle snapshot must agree, so a fresh workspace shows
  // a consistent value before the first projection lands.
  // Feature 098 (T048, FR-033/FR-033a) — and the value they agree on is
  // unset. It named the built-in `speckit-new-feature` Pipeline, which no
  // installation has any more. The type stays `string`: the empty string is
  // how "no default" is spelled across the boundary, not a missing field.
  defaultWorkflowId: '',
  fatalSignatures: Object.freeze([]) as readonly string[],
  claudeAutoCompactPctOverride: undefined,
  runtimeLogLevel: 'INFO',
  runtimeLogFilePath: '',
  retryMaxAttempts: 5,
  runtimeLogMaxBytes: 5 * 1024 * 1024,
  runtimeLogMaxGenerations: 3,
  sessionRetentionMaxAgeDays: 30,
  rawTranscriptMode: 'errors-only',
  transportCaptureMode: 'inherit',
  retryForceContinueOnCap: false,
  sessionRetentionMaxBytes: 512 * 1024 * 1024,
  // FR-R3-143 (T021) — manifest defaults, matching the host idle snapshot.
  cliInheritEnvironment: true,
  cliEnvironmentMode: 'allowlist',
  cliEnvironmentAllowlist: Object.freeze([]) as readonly string[],
  backendProbeTimeoutSeconds: 5,
  uiConfirmationsEnable: true,
  multiRootSuppressWarning: false,
  // FR-R3-144 (T007) — manifest defaults again. `DEFAULT_BACKEND` is imported
  // for the same reason `DEFAULT_QUEUE_ID` above is: a literal `'claude'` here
  // is the copy that keeps saying claude after the default moves.
  backendRunner: DEFAULT_BACKEND,
  spendMaxUsdPerRun: null,
  spendMaxTokensPerRun: null,
  // Feature 195 (T008) — manifest default, matching the host idle snapshot.
  queueHaltOnTaskFailure: 'halt-on-failure',
  scopes: Object.freeze({
    cliPath: 'default',
    loggingVerbose: 'default',
    loopMaxIterations: 'default',
    invocationIdleTimeoutSeconds: 'default',
    invocationMaxDurationSeconds: 'default',
    watchdogPollIntervalMinutes: 'default',
    auditRotationSizeMB: 'default',
    auditRotationMaxAgeDays: 'default',
    defaultWorkflowId: 'default',
    fatalSignatures: 'default',
    claudeAutoCompactPctOverride: 'default',
    runtimeLogLevel: 'default',
    runtimeLogFilePath: 'default',
    retryMaxAttempts: 'default',
    codexPath: 'default',
    agyPath: 'default',
    runtimeLogMaxBytes: 'default',
    runtimeLogMaxGenerations: 'default',
    sessionRetentionMaxAgeDays: 'default',
    sessionRetentionMaxBytes: 'default',
    rawTranscriptMode: 'default',
    transportCaptureMode: 'default',
    retryForceContinueOnCap: 'default',
    cliInheritEnvironment: 'default',
    cliEnvironmentMode: 'default',
    cliEnvironmentAllowlist: 'default',
    backendProbeTimeoutSeconds: 'default',
    uiConfirmationsEnable: 'default',
    multiRootSuppressWarning: 'default',
    backendRunner: 'default',
    spendMaxUsdPerRun: 'default',
    spendMaxTokensPerRun: 'default',
    queueHaltOnTaskFailure: 'default'
  })
});

const HEALTHY_REQUIRED_EVIDENCE: EvidenceSinkHealthProjection = Object.freeze({
  status: 'healthy',
  continuationPolicy: 'fail-closed',
  failureCount: 0,
  lastFailureAt: null,
  cause: null
});

const HEALTHY_OPTIONAL_EVIDENCE: EvidenceSinkHealthProjection = Object.freeze({
  ...HEALTHY_REQUIRED_EVIDENCE,
  continuationPolicy: 'continue-degraded'
});

export const IDLE_EVIDENCE_HEALTH: EvidenceHealthProjection = Object.freeze({
  overall: 'healthy',
  audit: HEALTHY_REQUIRED_EVIDENCE,
  rawTranscript: HEALTHY_OPTIONAL_EVIDENCE,
  runtimeLog: HEALTHY_OPTIONAL_EVIDENCE,
  metricsRollup: HEALTHY_OPTIONAL_EVIDENCE,
  historyPointer: HEALTHY_OPTIONAL_EVIDENCE,
  auditCheckpoint: HEALTHY_OPTIONAL_EVIDENCE,
  transport: HEALTHY_OPTIONAL_EVIDENCE,
  verboseDiagnostics: HEALTHY_OPTIONAL_EVIDENCE
});

export const IDLE_STREAM_PRESSURE: StreamPressureProjection = Object.freeze({
  liveBuffers: 0,
  retainedBytes: 0,
  ceilingBytes: 0,
  machineMemoryBytes: 0
});

export const IDLE_SESSION_ARTIFACTS: SessionArtifactsProjection = Object.freeze({
  artifactCount: 0,
  totalBytes: 0,
  lastSweepAt: null,
  lastSweepFailures: 0
});

export const IDLE_LIVE_ACTIVITY: LiveActivity = Object.freeze({
  summary: null,
  category: null,
  lastEventAt: null,
  freshness: 'idle',
  staleSeconds: null
});

// Feature 098 (FR-008) — the mirror of the host's `isRecursivePhase` stood here
// and no webview module ever called it: the sub-progress bar arrives already
// projected on the snapshot, so this side never had to decide whether a Phase
// loops. It is gone on both sides — the host's copy because a Phase loops by its
// `retryCondition` rather than by its id, and this one because it was dead.

