export const SCHEMA_VERSION = 4 as const;

import type {
  ActiveFeatureSummary,
  ActivePipelineSummary,
  CliMonitorState,
  DelayedRetryState,
  LaunchProjection,
  LiveActivity,
  PhaseTile,
  QueueItemStatus,
  RunLivenessProjection,
  RunProgressProjection,
  SessionArtifactsProjection,
  StreamPressureProjection,
  WorkflowCatalogFieldErrorProjection,
  WorkflowStatus,
  BuilderLifecycle,
  QueueSettingsProjection,
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
import type {
  PhaseName,
} from '../../../src/contracts/phase-identity.js';
import type {
  ConnectedRunProjection,
} from '../../../src/contracts/sidebar-ipc/workflow-run.js';
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
} from '../../../src/contracts/process-definitions.js';
import type { PhaseCapability } from '../../../src/contracts/phase-capabilities.js';
import type {
  PipelineInputPortType,
  PipelineOutputPortType,
  PipelineSourceStatus
} from '../../../src/contracts/pipeline-definitions.js';
import type {
  WorkflowSourceStatus,
} from '../../../src/contracts/workflow-definitions.js';

import type { CatalogKind, CatalogVersionId } from '../../../src/contracts/catalog-store.js';
import type { HistoryTerminalStatus } from '../../../src/contracts/history-identity.js';
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
  AuditTailEntry,
  QueueSummary
} from '../../../src/contracts/snapshot-projections.js';
import type {
  IpcScheduledStartSource as ScheduledStartSource
} from '../../../src/contracts/start-intent-types.js';

import type { RunOutputRecord } from '../../../src/contracts/run-results.js';
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
  CliMonitorState,
  DelayedRetryCauseProjection,
  DelayedRetryState,
  FreshnessState,
  LaunchProjection,
  LaunchSection,
  Launchable,
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
  WorkflowCatalogFieldErrorProjection,
  WorkflowStatus
} from '../../../src/contracts/snapshot-projections.js';
export type {
  BackendRunnerKind
} from '../../../src/contracts/backend-kinds.js';
export type {
  PhaseName
} from '../../../src/contracts/phase-identity.js';
export type {
  ConnectedNodeAction,
  ConnectedNodeProjection,
  ConnectedNodeState,
  ConnectedRunProjection
} from '../../../src/contracts/sidebar-ipc/workflow-run.js';
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
  WorkflowCatalogMutation,
  WorkflowCondition,
  WorkflowConditionLiteral,
  WorkflowConditionOperand,
  WorkflowConditionOperator,
  WorkflowConnection,
  WorkflowNode,
  WorkflowNodeTerminalStatus,
  WorkflowSelectionRule,
  WorkflowSourceStatus
} from '../../../src/contracts/workflow-definitions.js';

export type BackendPingFailureCause =
  | 'not-found'
  | 'not-executable'
  | 'non-zero-exit'
  | 'timed-out'
  | 'already-in-progress'
  | 'unknown';
export type BackendPingState =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly runner: BackendRunnerKind; readonly startedAt: number; readonly timeoutSeconds: number }
  | { readonly status: 'success'; readonly runner: BackendRunnerKind; readonly startedAt: number; readonly completedAt: number; readonly latencyMs: number; readonly timeoutSeconds: number }
  | { readonly status: 'failure'; readonly runner: BackendRunnerKind; readonly startedAt: number; readonly completedAt: number; readonly latencyMs: number; readonly timeoutSeconds: number; readonly cause: BackendPingFailureCause; readonly exitCode?: number };

export interface QueueItem {
  readonly id: string;
  readonly label: string;
  readonly enqueuedAt: string;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly status: QueueItemStatus;
  readonly retryCount: number;
  readonly lastErrorSummary: string | null;
  readonly pausedReason: string | null;
  readonly currentPhase: PhaseName | null;
  readonly queueId?: string;
  readonly position: number;
  readonly pauseCause?:
    | 'queue-paused'
    | 'phase-paused'
    | 'manually-paused-task'
    | 'breakpoint'
    | null;
  /** Feature 020 — pipeline id under which the task is/was running. */
  readonly currentPipelineId?: string | null;
  /**
   * BUG-006 (063) — Activity Feed cold-start fallback predicate. `true`
   * when the task has entered the phase machinery at least once and may
   * have audit-log iterations on disk. Optional for back-compat with
   * snapshots emitted before the field landed.
   */
  readonly hasOnDiskLogs?: boolean;
  /**
   * Feature 065 / BUG-006 — paused-row enrichment for the webview. Present
   * only on tasks with `status === 'paused'`. Drives the QueueItem badge
   * (operator-paused vs. system-paused/rate-limit) and the auto-resume
   * countdown. `resetsAtMs` carries the resolved restoration target.
   */
  readonly paused?: {
    readonly pauseSource: 'operator-paused' | 'system-paused';
    readonly pauseCauseCategory?: 'rate-limit' | 'fatal-signature' | 'operator-canceled';
    readonly resetsAtMs?: number;
  };
}

export interface QueueProjection {
  readonly inFlight: QueueItem | null;
  readonly pending: readonly QueueItem[];
  readonly recent: readonly QueueItem[];
  /**
   * Feature 065 / BUG-009 (FR-029) — flattened single-source-of-truth row
   * order for queue-surface rendering. Contains every `FeatureRequest`
   * from `QueueState.requests` regardless of status (pending, in-flight,
   * paused, completed, canceled, failed). The legacy `inFlight`/`pending`/
   * `recent` bucket fields remain populated for backward compatibility,
   * but new code MUST consume `orderedItems` and treat the buckets as
   * derived/legacy.
   */
  readonly orderedItems: readonly QueueItem[];
  readonly queues?: readonly QueueSummary[];
  readonly paused: boolean;
  readonly pausedReason?: string | null;
  // Feature 065 — additive lifecycle / scheduled-start projection.
  readonly lifecycle?: QueueLifecycle;
  readonly scheduledStartAt?: number | null;
  readonly scheduledStartSource?: ScheduledStartSource | null;
  // Feature 065 (T054a / FR-020) — one-time post-migration operator notice.
  readonly migrationNotice?: 'pending' | 'dismissed';
}

/**
 * Feature 103 (FR-009, FR-011) — the published version a run's plan froze,
 * mirroring the host's `contracts/catalog-version.ts`.
 *
 * Mirrored rather than imported, as every other host shape in this file is: the
 * module has no imports, which is what keeps the webview bundle from reaching
 * into host code that was never compiled for it.
 *
 * `kind` is part of the identity because the catalog lets a Pipeline and a
 * Workflow share an id. On a *recorded run* it is always `'pipeline'`, including
 * for a Workflow member — the member executes a frozen Pipeline snapshot. Which
 * makes it useless as an answer to "was this a Workflow run?"; that is `origin`.
 */
export interface CatalogVersionRef {
  /**
   * The host's full `CatalogKind`, `'phase'` included, even though a recorded
   * run's frozen body is never a phase. A mirror that narrowed the union would
   * make the host's own `HistoryEntry` unassignable to this one, which is what
   * `tests/integration/history/in-flight-not-persisted.test.ts` does when it
   * feeds the real projector into the real fold.
   */
  readonly kind: CatalogKind;
  readonly id: string;
  /** Never `''`. Absence of the whole record means "not recorded". */
  readonly versionId: CatalogVersionId;
}

/**
 * Feature 103 (FR-013, FR-014) — how a run was started, mirroring the host's
 * `contracts/run-origin.ts`.
 *
 * A second question from `CatalogVersionRef`, and neither derives the other:
 * a Workflow member reads `origin.kind === 'workflow-member'` and
 * `catalogVersion.kind === 'pipeline'` on the same row, and both are true.
 *
 * Absent is a third state, distinct from `'standalone'`: a run recorded before
 * this field existed has no origin, and no reader may fill one in.
 */
export type RunOriginRef =
  | { readonly kind: 'standalone' }
  | { readonly kind: 'workflow-member'; readonly workflowId: string };

export interface HistoryEntry {
  readonly runId: string;
  readonly featureId: string;
  readonly descriptionPreview: string;
  readonly terminalStatus: HistoryTerminalStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly lastErrorSummary: string | null;
  readonly auditLogPointer: string;
  // Feature 103 (FR-002) — the queue partition this entry was filed under.
  // `HISTORY_UNATTRIBUTED_QUEUE_ID` ('__unattributed__') is a real value here,
  // not a tombstone: a row whose queue can no longer be attributed is listed
  // under that partition rather than omitted (FR-006).
  readonly queueId: string;
  /**
   * Feature 103 (FR-009, FR-012) — the published version this run's plan froze.
   *
   * Absent means "not recorded", and the surface says so (FR-012). No reader
   * fills it from the catalog: the catalog answers about now, this row is about
   * this run, and a filled-in gap would claim the run froze something it did not.
   */
  readonly catalogVersion?: CatalogVersionRef;
  /**
   * Feature 103 (FR-013) — whether this run was started on its own or as a
   * member of a Workflow, stamped when the run was recorded.
   *
   * Not `catalogVersion.kind`, which reads `'pipeline'` on a Workflow member.
   */
  readonly origin?: RunOriginRef;
  /**
   * Feature 103 (FR-053) — the length of the operator's original description.
   *
   * The number, not the text: `descriptionPreview` is bounded and is the only
   * description content on the wire, so the detail needs this to say how much
   * of the original it is showing. Absent for a row recorded before the store
   * kept it, which is why no reader may treat it as zero.
   */
  readonly descriptionLength?: number;
}

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

export interface PhaseCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly PhaseCatalogSourceRecord[];
  readonly effective: readonly PortablePhaseDefinition[];
  /** The store's revision for this kind, echoed back on save (FR-044, FR-044a). */
  readonly revision: string;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly error?: { readonly code: string; readonly message: string };
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

export interface PipelineCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly PipelineCatalogSourceRecord[];
  readonly effective: readonly PortablePipelineDefinition[];
  /** The store's revision for this kind, echoed back on save (FR-043, FR-044a). */
  readonly revision: string;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly error?: { readonly code: string; readonly message: string };
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

export interface WorkflowCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly WorkflowCatalogSourceProjection[];
  readonly effective: readonly PortableWorkflowDefinition[];
  /** The store's revision for this kind, echoed back on save (FR-043, FR-044a). */
  readonly revision: string;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly error?: { readonly code: string; readonly message: string };
}

export const IDLE_DELAYED_RETRY: DelayedRetryState = Object.freeze({
  pendingRetryAt: null,
  pendingRetryCause: null,
  delayedRetryCount: 0
});

export interface GeneralSettings {
  readonly cliPath: string;
  readonly loggingVerbose: boolean;
  readonly loopMaxIterations: number;
  readonly invocationIdleTimeoutSeconds: number;
  readonly invocationMaxDurationSeconds: number;
  readonly watchdogPollIntervalMinutes: number;
  readonly auditRotationSizeMB: number;
  readonly auditRotationMaxAgeDays: number;
  readonly defaultPipelineId: string;
  readonly fatalSignatures: readonly string[];
  readonly claudeAutoCompactPctOverride: number | undefined;
  readonly runtimeLogLevel: RuntimeLogLevel;
  readonly runtimeLogFilePath: string;
  readonly retryMaxAttempts: number;
  readonly codexPath: string;
  readonly agyPath: string;
  readonly runtimeLogMaxBytes: number;
  readonly runtimeLogMaxGenerations: number;
  readonly sessionRetentionMaxAgeDays: number;
  readonly sessionRetentionMaxBytes: number;
  readonly rawTranscriptMode: 'always' | 'errors-only' | 'off';
  /**
   * FR-R3-051 (M-06) — the webview had no notion of this setting at all: absent
   * from this type, from the idle snapshot and from `scopes`, while the manifest,
   * the host fallback table and the host idle snapshot all carried it. Found by
   * `settings-defaults-parity.test.ts`, which compares key SETS and not only
   * values -- a missing key is how a default silently becomes whatever the code
   * says.
   */
  readonly retryForceContinueOnCap: boolean;
  // FR-R3-143 (T021) — six manifest settings the host now projects. Mirrored
  // here for the same reason `retryForceContinueOnCap` above is: a key missing
  // from this type is a default that silently becomes whatever the code says.
  readonly cliInheritEnvironment: boolean;
  readonly cliEnvironmentMode: string;
  readonly cliEnvironmentAllowlist: readonly string[];
  readonly backendProbeTimeoutSeconds: number;
  readonly uiConfirmationsEnable: boolean;
  readonly multiRootSuppressWarning: boolean;
  // FR-R3-144 (T007) — the backend the tab now names, and the two bounds it can
  // set. `null` on either bound is the manifest's own default and means NO
  // bound; it is not a zero bound, and the surface must not render it as one.
  readonly backendRunner: BackendRunnerKind;
  readonly spendMaxUsdPerRun: number | null;
  readonly spendMaxTokensPerRun: number | null;
  readonly scopes: {
    readonly cliPath: SettingScope;
    readonly loggingVerbose: SettingScope;
    readonly loopMaxIterations: SettingScope;
    readonly invocationIdleTimeoutSeconds: SettingScope;
    readonly invocationMaxDurationSeconds: SettingScope;
    readonly watchdogPollIntervalMinutes: SettingScope;
    readonly auditRotationSizeMB: SettingScope;
    readonly auditRotationMaxAgeDays: SettingScope;
    readonly defaultPipelineId: SettingScope;
    readonly fatalSignatures: SettingScope;
    readonly claudeAutoCompactPctOverride: SettingScope;
    readonly runtimeLogLevel: SettingScope;
    readonly runtimeLogFilePath: SettingScope;
    readonly retryMaxAttempts: SettingScope;
    readonly codexPath: SettingScope;
    readonly agyPath: SettingScope;
    readonly runtimeLogMaxBytes: SettingScope;
    readonly runtimeLogMaxGenerations: SettingScope;
    readonly sessionRetentionMaxAgeDays: SettingScope;
    readonly sessionRetentionMaxBytes: SettingScope;
    readonly rawTranscriptMode: SettingScope;
    readonly retryForceContinueOnCap: SettingScope;
    readonly cliInheritEnvironment: SettingScope;
    readonly cliEnvironmentMode: SettingScope;
    readonly cliEnvironmentAllowlist: SettingScope;
    readonly backendProbeTimeoutSeconds: SettingScope;
    readonly uiConfirmationsEnable: SettingScope;
    readonly multiRootSuppressWarning: SettingScope;
    readonly backendRunner: SettingScope;
    readonly spendMaxUsdPerRun: SettingScope;
    readonly spendMaxTokensPerRun: SettingScope;
  };
}

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
  defaultPipelineId: '',
  fatalSignatures: Object.freeze([]) as readonly string[],
  claudeAutoCompactPctOverride: undefined,
  runtimeLogLevel: 'INFO',
  runtimeLogFilePath: '',
  retryMaxAttempts: 5,
  runtimeLogMaxBytes: 5 * 1024 * 1024,
  runtimeLogMaxGenerations: 3,
  sessionRetentionMaxAgeDays: 30,
  rawTranscriptMode: 'errors-only',
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
  scopes: Object.freeze({
    cliPath: 'default',
    loggingVerbose: 'default',
    loopMaxIterations: 'default',
    invocationIdleTimeoutSeconds: 'default',
    invocationMaxDurationSeconds: 'default',
    watchdogPollIntervalMinutes: 'default',
    auditRotationSizeMB: 'default',
    auditRotationMaxAgeDays: 'default',
    defaultPipelineId: 'default',
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
    retryForceContinueOnCap: 'default',
    cliInheritEnvironment: 'default',
    cliEnvironmentMode: 'default',
    cliEnvironmentAllowlist: 'default',
    backendProbeTimeoutSeconds: 'default',
    uiConfirmationsEnable: 'default',
    multiRootSuppressWarning: 'default',
    backendRunner: 'default',
    spendMaxUsdPerRun: 'default',
    spendMaxTokensPerRun: 'default'
  })
});

/**
 * Feature 092 (FR-048, FR-049) — the Run one queue owns, folded under that
 * queue. Every field here was a top-level singular in v3; the fold is what
 * makes "whose Run is this" unambiguous once more than one can be in flight.
 */
export interface InFlightRunProjection {
  readonly runId: string;
  readonly status: WorkflowStatus;
  readonly feature: ActiveFeatureSummary | null;
  /** Null on the built-in `standard` pipeline, matching the v3 `activePipeline` omission. */
  readonly pipeline: ActivePipelineSummary | null;
  readonly elapsedMs: number | null;
  readonly liveActivity: LiveActivity;
  /**
   * FR-R3-008 (T379) — the reload-durable half of the question `liveActivity`
   * answers from memory. Optional as well as nullable: a host running an older
   * bundle omits the key entirely, and both absence and `null` must render as
   * unknown, so no consumer may treat one as different from the other.
   */
  readonly liveness?: RunLivenessProjection | null;
  /** FR-R3-008 (T379) — progress against the Run's frozen total; absent or `null` is unknown. */
  readonly progress?: RunProgressProjection | null;
  readonly delayedRetry: DelayedRetryState;
  readonly resumeTargetPhaseId: string | null;
  readonly outputs: readonly RunOutputRecord[];
  /**
   * Feature 103 (FR-003) — the same two provenance readings the recorded rows
   * carry, so a run reads identically in flight and once recorded.
   *
   * Read live off the Run here because there is no record yet. `catalogVersion`
   * comes off the frozen plan, which is immutable for the Run's life; `origin`
   * comes from the host's connected-run map. Absent on a host that cannot answer
   * either question, which is not the same as `'standalone'`.
   */
  readonly catalogVersion?: CatalogVersionRef;
  readonly origin?: RunOriginRef;
}

/**
 * Feature 092 (FR-048, FR-053) — one entry per registered queue, in position
 * order. A queue that owns no Run publishes `inFlightRun: null` with every
 * run-derived list empty; it never borrows another queue's Run.
 */
export interface QueueRuntime {
  readonly queueId: string;
  readonly name: string;
  readonly position: number;
  readonly lifecycle: QueueLifecycle;
  readonly inFlightRun: InFlightRunProjection | null;
  readonly phases: readonly PhaseTile[];
  readonly phaseOverrides: readonly {
    readonly phaseId: string;
    readonly action: 'skipped' | 'disabled' | 'removed';
  }[];
  readonly manualPause: {
    readonly at: string;
    readonly cause:
      | 'operator-paused'
      | 'queue-paused-mid-run'
      | 'breakpoint-paused'
      // BUG-003 and FR-R3-112 — both were already reaching this field verbatim from
      // the host's `ManualPauseCause`; the mirror simply had not been widened, so the
      // two newest causes arrived as values this declaration said were impossible.
      | 'verify-paused'
      | 'spend-bound-reached';
  } | null;
  readonly phaseBreakpoints: readonly {
    readonly phaseId: string;
    readonly setAt: string;
    readonly actor: 'operator' | 'system';
  }[];
  /** Pending Tasks on this queue, derived from its own rows — never a total. */
  readonly pendingCount: number;
  /**
   * Feature 092 (T108, FR-057) — this queue's own Task rows in position order,
   * active and historical alike; the Queue Detail tier lists them. Distinct from
   * `QueueProjection.orderedItems`, which is the default queue's rows and whose
   * indices are the global address space the reorder handler translates.
   */
  readonly tasks: readonly QueueItem[];
}

export interface WorkflowSnapshot {
  readonly schemaVersion: 4;
  readonly isPrimary: boolean;
  /**
   * Feature 092 (FR-048) — one runtime per registered queue. Replaces every
   * per-run singular the root carried in v3; those were deleted rather than
   * deprecated so a stale read fails to compile instead of silently reading
   * one queue's Run as the workspace's.
   */
  readonly queues: readonly QueueRuntime[];
  readonly queue: QueueProjection;
  /** Effective host default; absent only when paired with a legacy host. */
  readonly defaultRunnerKind?: BackendRunnerKind;
  readonly auditTail: readonly AuditTailEntry[];
  readonly debugLogTail?: readonly DebugLogEntry[];
  readonly monitor: CliMonitorState | null;
  readonly history: readonly HistoryEntry[];
  readonly producedAt: string;
  readonly availablePipelines: readonly PipelineDefinition[];
  readonly availablePhases: readonly PhaseDefinition[];
  /**
   * Model ids each backend was DISCOVERED to offer — an advisory, live
   * backend fact, not the operator's catalog and never a value to save back.
   * Empty for `claude` and `codex`, whose CLIs cannot enumerate models; only
   * `agy` reports a real list.
   */
  readonly availableModels: Record<BackendRunnerKind, readonly string[]>;
  /**
   * The operator's Model Catalog (`schegent.models`) — what the Models editor
   * loads, edits, saves, and exports, and what an import writes. Optional for
   * legacy-tolerance: an older host bundle may not send it.
   */
  readonly configuredModels?: Record<BackendRunnerKind, readonly string[]>;
  readonly availableBackends: readonly BackendRunnerKind[];
  /**
   * FR-R3-144 (T020, D-4) — every supported backend's containment posture, as the
   * host derived it. The Settings tab RENDERS these discriminants and computes
   * none of them; `tests/lint/webview-posture-derivation.test.ts` is what keeps
   * that true.
   *
   * Optional for legacy-tolerance, like `generalSettings` above: an older host
   * bundle may not send it, and the surface must show "not reported" rather than
   * inventing a posture — an invented one would be a webview-side answer to the
   * question this projection exists to keep on the host.
   */
  readonly backendPostures?: readonly BackendPosture[];
  /** FR-R3-144 (T020, FR-004) — grant-setting entries that name no backend. */
  readonly backendGrantProblems?: BackendGrantEntryProblems;
  readonly backendPingState?: BackendPingState;
  /**
   * Feature 011 — typed read of the scalar `schegent.*` settings `KEY_SPECS`
   * admits, with the effective scope for each field. FR-R3-145 (T1569): that
   * is a subset of what the manifest declares, not every scalar key, which is
   * what this said until keys were contributed without being added to
   * `KEY_SPECS`. Optional for legacy-tolerance: an older host bundle may not
   * include it; the webview must default to `IDLE_GENERAL_SETTINGS` in that case.
   */
  readonly generalSettings?: GeneralSettings;
  /**
   * FR-R3-145 (T1572) — the two queue settings, projected from the workspace
   * memento the drain enforces against rather than from the configuration
   * `generalSettings` reads. Imported, not restated: the shape is one both sides
   * must agree on, which is the census gate's own rule for what gets imported.
   * Optional for legacy-tolerance, as its neighbour is; the webview must default
   * to `IDLE_QUEUE_SETTINGS` when an older host bundle omits it.
   */
  readonly queueSettings?: QueueSettingsProjection;
  readonly sessionArtifacts?: SessionArtifactsProjection;
  /** FR-R3-130 (T1496) — live aggregate stream pressure. Optional, as its neighbour is. */
  readonly streamPressure?: StreamPressureProjection;
  readonly evidenceHealth?: EvidenceHealthProjection;
  /** Feature 081 — absent means the authoritative catalog is still loading. */
  readonly phaseCatalog?: PhaseCatalogProjection;
  /**
   * Feature 082 — resolved Pipeline catalog for the Library and Builder.
   * Additive and optional: absent means the authoritative catalog is still
   * loading, and every mutating control stays disabled until it arrives
   * (FR-028). `availablePipelines` keeps its runtime-selection meaning.
   */
  readonly pipelineCatalog?: PipelineCatalogProjection;
  /**
   * Feature 083 — resolved Workflow catalog for the Workflow Library and Graph
   * Builder. Additive and optional on the same terms as `pipelineCatalog`:
   * absent means the authoritative catalog is still loading, and every mutating
   * control stays disabled until it arrives (FR-036).
   */
  readonly workflowCatalog?: WorkflowCatalogProjection;
  /**
   * Feature 102 — what Runs may start: Active only, at the active version,
   * filtered and ordered host-side (FR-001, FR-002, FR-003).
   *
   * Additive and optional on the same terms as the catalog projections above:
   * absent means the host has not resolved a catalog yet, so each section renders
   * a loading state (FR-006). That is why `LaunchSection` has no `loading` arm.
   */
  readonly launchables?: LaunchProjection;
  /**
   * Feature 088 — the connected runs the operator can act on, already folded to
   * per-node state, legal actions, and `hydrating` host-side. Additive and
   * optional: a host with no connected-run wiring omits it, so the view treats
   * absence as "none" rather than as an error.
   */
  readonly connectedRuns?: readonly ConnectedRunProjection[];
  /**
   * Feature 059 — per-capability trust projection. Optional for legacy-
   * tolerance: an older host bundle may not include either field, in
   * which case the webview must fail closed (treat as `false`) per the
   * trust-projection contract's failure-mode rules.
   *
   * Contract:
   * `specs/059-fine-grained-trust-scopes/contracts/trust-projection-contract.md`.
   */
  readonly workspaceTrust?: boolean;
  /**
   * Feature 099 (T494a, FR-046) — `pipelineOverrides` and `workflowOverrides` are
   * gone with the layer tier. Both asked which layer was permitted to redefine
   * another's row, and one layer has no such question; the Pipelines and Workflows
   * tabs are governed by Workspace Trust alone, which `workspaceTrust` carries.
   * The two survivors gate document CONTENT, not layering.
   */
  readonly resolvedTrust?: {
    readonly phases: boolean;
    readonly retryConditions: boolean;
  };
  /**
   * FR-R3-143 (T037) — which step of the trust ladder decided each capability:
   * `'user'`, `'workspace'`, or `'workspace-trust'` (the ceiling).
   *
   * Optional on the same legacy-tolerance terms as `resolvedTrust` above: an older
   * host bundle omits it. A view that reads it must treat absence as "unknown" and
   * say nothing, NOT as any particular step — naming the wrong step is the defect
   * this field exists to fix (`TrustBanner` called every denial a workspace policy).
   */
  readonly resolvedScope?: {
    readonly phases: 'user' | 'workspace' | 'workspace-trust';
    readonly retryConditions: 'user' | 'workspace' | 'workspace-trust';
  };
  /**
   * Feature 033 — ephemeral per-subprocess telemetry sample. Never
   * persisted to WorkflowRun, never written to the audit log. The host
   * projection clears this to `null` one publish after the runner's
   * `exited` event. Optional for legacy-tolerance: an older host bundle
   * may not include it, and the webview must treat `undefined` the same
   * as `null` (no telemetry line rendered).
   */
  readonly telemetry?: TelemetrySnapshot | null;
  /**
   * Feature 063 (FR-021) — projected suppression set so the webview can
   * skip the modal when the operator opted out for a given action key.
   * Optional for legacy-tolerance: an older host bundle may not include
   * it, and the webview must treat `undefined` the same as "no
   * suppressions" (modal shown).
   */
  readonly confirmSuppression?: {
    readonly version: 1;
    readonly suppressedActionKeys: readonly string[];
  };

  /**
   * Feature 063 (FR-019, T030) — projected value of the
   * `schegent.ui.confirmations.enable` config flag. When `false`,
   * `useConfirm` short-circuits and destructive actions run without
   * opening the modal. Optional for legacy-tolerance: an older host
   * bundle may not include it, and the webview must treat `undefined`
   * the same as `true` (prompts on).
   */
  readonly confirmationsEnabled?: boolean;
}

export interface EvidenceHealthProjection {
  readonly overall: EvidenceOverallStatus;
  readonly audit: EvidenceSinkHealthProjection;
  readonly rawTranscript: EvidenceSinkHealthProjection;
  readonly runtimeLog: EvidenceSinkHealthProjection;
  // FR-R3-009 — the durable metrics rollup is a fourth continue-degraded sink.
  // A run whose rollup append failed still executes, but its contribution to
  // cumulative totals lasts only as long as its audit evidence, so a degraded
  // rollup is the operator's warning that totals may regress after rotation.
  readonly metricsRollup: EvidenceSinkHealthProjection;
  // FR-R3-010 — the fifth continue-degraded sink: whether a completed Run's
  // recorded evidence can still be located. Degraded only on an unreadable
  // corpus; an expired or legacy pointer is a fact about one record, not a
  // condition of the sink.
  readonly historyPointer: EvidenceSinkHealthProjection;
}

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
  historyPointer: HEALTHY_OPTIONAL_EVIDENCE
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

