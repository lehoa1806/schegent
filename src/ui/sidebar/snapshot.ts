import type { DebugLogEntry } from '../../lib/webview-log-sink';
import type { BackendPingState } from '../../services/backend-ping-service';
import type {
  PhaseDefinition,
  PhaseDefinitionScope,
  PhaseSourceStatus
} from '../../contracts/process-definitions';
import type {
  PipelineDefinition,
  PipelineDefinitionScope,
  PipelineSourceStatus
} from '../../contracts/pipeline-definitions';
import type {
  WorkflowDefinition,
  WorkflowDefinitionScope,
  WorkflowDerivedPort,
  WorkflowSourceStatus
} from '../../contracts/workflow-definitions';
import type { RunOutputRecord } from '../../contracts/run-results';
import type { ConnectedRunProjection } from '../../contracts/sidebar-ipc';
export type { BackendPingState };
import {
  IDLE_EVIDENCE_HEALTH,
  type EvidenceHealthSnapshot
} from '../../services/evidence-health/evidence-health-monitor';
export type { DebugLogEntry };
export type { EvidenceHealthSnapshot };
export { IDLE_EVIDENCE_HEALTH };

export const SCHEMA_VERSION = 3 as const;

export const BUILT_IN_PHASE_NAMES = [
  'speckit-specify',
  'speckit-clarify',
  'speckit-plan',
  'speckit-tasks',
  'speckit-analyze',
  'speckit-implement',
  'finalize'
] as const;

export const PHASE_NAMES = BUILT_IN_PHASE_NAMES;

export type BuiltInPhaseName = (typeof BUILT_IN_PHASE_NAMES)[number];

export type PhaseName = string;

export interface PhaseCatalogFieldErrorProjection {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface PhaseCatalogSourceProjection {
  readonly key: string;
  readonly phaseId: string;
  readonly scope: PhaseDefinitionScope;
  readonly status: PhaseSourceStatus;
  readonly definition: PhaseDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly PhaseCatalogFieldErrorProjection[];
  readonly modelAvailable?: boolean;
}

export interface PhaseCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly PhaseCatalogSourceProjection[];
  readonly effective: readonly PhaseDefinition[];
  readonly revisions: {
    readonly user: string;
    readonly workspace: string;
  };
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * Feature 082 — Pipeline catalog projection. Contract:
 * `specs/082-pipeline-contracts-builder/contracts/pipeline-catalog-snapshot.md`.
 * Structurally parallel to the Phase catalog projection above so both authoring
 * surfaces consume one shape.
 */
export interface PipelineCatalogFieldErrorProjection {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface PipelineCatalogSourceProjection {
  /** `${scope}:${pipelineId}`, suffixed positionally only when a scope repeats an id. */
  readonly key: string;
  readonly pipelineId: string;
  readonly scope: PipelineDefinitionScope;
  readonly status: PipelineSourceStatus;
  readonly definition: PipelineDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly PipelineCatalogFieldErrorProjection[];
  readonly modelAvailable?: boolean;
  /**
   * FR-002 — the Workflows that still resolve this `pipelineId` from the
   * catalog, so the Library can show what a change would affect. Sorted and
   * deduplicated; identical for every record sharing a `pipelineId`, since a
   * reference names the id, not the layer it resolves from. Absent when the
   * host exposes no Workflow references at all (see `collectWorkflowPipelineRefs`).
   */
  readonly consumingWorkflowIds?: readonly string[];
}

export interface PipelineCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly PipelineCatalogSourceProjection[];
  readonly effective: readonly PipelineDefinition[];
  readonly revisions: {
    readonly user: string;
    readonly workspace: string;
  };
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * Feature 083 — Workflow catalog projection. Contract:
 * `specs/083-workflow-graph-builder/contracts/workflow-catalog-snapshot.md`.
 * The third instance of this shape, deliberately field-for-field with the two
 * above. `workflowCatalog` names the *definition* sense of "Workflow"; the
 * run-side `WorkflowSnapshot` / `WorkflowRun` family below keeps every surface
 * it already owns, with no rename anywhere (FR-046).
 */
export interface WorkflowCatalogFieldErrorProjection {
  /** Positional, e.g. `connections[12].to` — hence the wider cap than a Pipeline field. */
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface WorkflowCatalogSourceProjection {
  /** `${scope}:${workflowId}`, suffixed positionally only when a scope repeats an id. */
  readonly key: string;
  readonly workflowId: string;
  readonly scope: WorkflowDefinitionScope;
  readonly status: WorkflowSourceStatus;
  readonly definition: WorkflowDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly WorkflowCatalogFieldErrorProjection[];
  /**
   * FR-048 — computed at projection time from the definition, never stored on
   * the row and never accepted in a save payload. Empty for a record with no
   * resolved definition.
   */
  readonly derivedInputs: readonly WorkflowDerivedPort[];
  readonly derivedOutputs: readonly WorkflowDerivedPort[];
}

export interface WorkflowCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly WorkflowCatalogSourceProjection[];
  readonly effective: readonly WorkflowDefinition[];
  readonly revisions: {
    readonly user: string;
    readonly workspace: string;
  };
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly error?: { readonly code: string; readonly message: string };
}

export type PhaseState = 'not-started' | 'active' | 'completed' | 'skipped' | 'disabled';

export type PhaseResultState =
  | 'clean'
  | 'ambiguities-remain'
  | 'issues-remain'
  | 'failed'
  | 'timed-out';

export type WorkflowStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

export type QueueItemStatus =
  | 'pending'
  | 'in-flight'
  | 'paused'
  | 'completed'
  | 'canceled'
  | 'failed';

export type AuditCategory =
  | 'phase-transition'
  | 'file-write'
  | 'cli-invocation'
  | 'error'
  | 'warning'
  | 'system';

export type FreshnessState = 'live' | 'slowing' | 'stalled' | 'paused' | 'idle';

export type MonitorStatus =
  | 'starting'
  | 'running'
  | 'stalled'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'canceled'
  | 'paused';

export interface SubProgress {
  readonly current: number;
  readonly total: number;
  readonly label: 'task' | 'iteration';
}

export interface PhaseTile {
  readonly name: PhaseName;
  readonly order: number;
  readonly state: PhaseState;
  readonly iteration: number;
  readonly lastResult: PhaseResultState | null;
  readonly elapsedMs: number;
  readonly subProgress: SubProgress | null;
  /**
   * Feature 061 — operator-configured display name from `PhaseDef.name`.
   * Purely cosmetic; MUST NOT be used as a lookup key. When undefined or
   * empty, consumers fall back to `formatPhaseLabel(tile.name)`.
   */
  readonly displayName?: string;
  /** Feature 076 — absent means required for legacy snapshots. */
  readonly isRequired?: boolean;
  readonly phaseMessage?: {
    readonly fromPhaseId: string;
    readonly entryCount: number;
    readonly byteSize: number;
    readonly truncated: boolean;
    readonly invalidReason: string | null;
  } | null;
  /**
   * Feature 010 (FR-028) — operator-visible projection of the most recent
   * retryCondition evaluation's missing keys.
   */
  readonly lastRetryDecision?: {
    readonly missingKeys: readonly string[];
  };
}

export interface ActiveFeatureSummary {
  readonly id: string;
  readonly label: string;
  readonly startedAt: string;
}

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
  readonly queueId: string;
  readonly position: number;
  readonly pauseCause: 'queue-paused' | 'phase-paused' | 'manually-paused-task' | 'breakpoint' | null;
  /**
   * Feature 020 — pipeline id under which this task is currently
   * executing (or last executed). Surfaced to the webview so the
   * Activity Feed can map a task selection to its diagnostics
   * directory tuple `(pipelineId, phaseId, iterationN)` without a
   * round-trip to the host. Null when the task has never started a
   * pipeline.
   */
  readonly currentPipelineId: string | null;
  /**
   * BUG-006 (063) — heuristic flag the Activity Feed cold-start fallback
   * uses to skip tasks that never reached a phase (crashed pre-pipeline).
   * `true` when the task has entered the phase machinery at least once;
   * the audit-log iteration directory may exist on disk. The cold-start
   * fallback in `resolveColdStartFallback` handles empty reads
   * gracefully, so a conservative `true` is preferred over a precise
   * filesystem check (which would require fs IO per snapshot emission).
   */
  readonly hasOnDiskLogs: boolean;
  /**
   * Feature 065 / BUG-006 — paused-row enrichment. Present only on tasks
   * with `status === 'paused'`. Allows the webview to render a "Paused
   * (rate-limit)" badge with an auto-resume countdown without re-querying
   * the queue lifecycle. `resetsAtMs` carries the resolved restoration
   * target (= `QueueState.scheduledStartAt`) when the pause is system-
   * armed; absent or undefined for operator-paused tasks.
   */
  readonly paused?: {
    readonly pauseSource: 'operator-paused' | 'system-paused';
    readonly pauseCauseCategory?: 'rate-limit' | 'fatal-signature' | 'operator-canceled';
    readonly resetsAtMs?: number;
  };
}

export interface QueueSummary {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly state: 'active' | 'manually-paused';
  /**
   * Feature 028 — `'cascade'` when the pause was a side effect of a phase
   * pause; `'operator'` when an operator paused the queue directly;
   * `'retry-cap'` (Feature 030 BUG-001) when the retry-handler paused
   * the queue after exhausting the delayed-retry cap; `null` when the
   * queue is active. Drives the cascade badge in QueueGlobalActions.svelte.
   */
  readonly pauseSource: 'operator' | 'cascade' | 'retry-cap' | null;
  readonly schedule: {
    readonly expression: string;
    readonly kind: 'relative' | 'absolute';
    readonly targetAt: string;
  } | null;
  readonly taskCount: number;
}

export interface QueueProjection {
  readonly inFlight: QueueItem | null;
  readonly pending: readonly QueueItem[];
  readonly recent: readonly QueueItem[];
  readonly orderedItems: readonly QueueItem[];
  readonly queues: readonly QueueSummary[];
  readonly paused: boolean;
  readonly pausedReason: string | null;
  // Feature 065 — additive lifecycle / scheduled-start projection.
  readonly lifecycle: QueueLifecycle;
  readonly scheduledStartAt: number | null;
  readonly scheduledStartSource: ScheduledStartSource | null;
  /**
   * Feature 065 (T054a / FR-020) — one-time operator notice surfaced on the
   * first workspace open after the v6 → v7 migration when at least one
   * queue migrated into `idle-pending` (i.e. the migrator wrote
   * `scheduledStartSource: 'migration-default'`). `'pending'` causes the
   * webview to render the non-modal notice; `'dismissed'` (or undefined)
   * suppresses it. The dismiss is routed through the existing
   * `WebviewMessage` channel and translates to a single persisted-state
   * write that flips this field to `'dismissed'`. The dismiss MUST NOT
   * touch `scheduledStartSource` (those clear only on the operator's next
   * explicit start).
   */
  readonly migrationNotice?: 'pending' | 'dismissed';
}

import type { QueueLifecycle, ScheduledStartSource } from '../../queue/feature-request';

import type { AuditScope } from '../../contracts/audit-events';

export interface AuditTailEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly phase: PhaseName | null;
  readonly category: AuditCategory;
  readonly summary: string;
  // --- Feature 064 additive fields ---
  readonly runId: string;
  readonly scope: AuditScope;
  // --- Feature 068 additive fields ---
  readonly taskId?: string;
  readonly phaseId?: string;
  readonly outcome?: 'success' | 'error' | 'pending';
  readonly runner?: string;
}

export interface LiveActivity {
  readonly summary: string | null;
  readonly category: AuditCategory | null;
  readonly lastEventAt: string | null;
  readonly freshness: FreshnessState;
  readonly staleSeconds: number | null;
}

export interface CliMonitorState {
  readonly runId: string;
  readonly phase: PhaseName;
  readonly status: MonitorStatus;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly lastStdoutAt: string | null;
  readonly lastStderrAt: string | null;
  readonly lastProgressAt: string | null;
  readonly stdoutLines: number;
  readonly stderrLines: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly detectedIssues: ReadonlyArray<'rate_limited' | 'stall'>;
  readonly msSinceLastStdout: number | null;
  readonly msSinceLastStderr: number | null;
}

export interface HistoryEntry {
  readonly runId: string;
  readonly featureId: string;
  readonly descriptionPreview: string;
  readonly terminalStatus: 'completed' | 'failed' | 'canceled';
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly lastErrorSummary: string | null;
  readonly auditLogPointer: string;
}

export interface ActivePipelineSummary {
  readonly id: string;
  readonly name: string;
}

import type { PhaseDef, PipelineDef } from '../../config/pipeline-config';
import type { BackendRunnerKind } from '../../runner/backend-runner-factory';
import type { GeneralSettings } from '../../config/general-settings';
import type { WakeUpLogProjection } from '../../wakeup/invocation-log';
import type { WakeUpSettings, WakeUpModelSelection } from '../../wakeup/settings';
import type { PhasePrecedenceProjection } from '../../config/phase-precedence';
import type { TelemetrySnapshot } from '../../telemetry/telemetry-snapshot';
export type { GeneralSettings } from '../../config/general-settings';
export type { WakeUpLogProjection, WakeUpLogProjectionEntry } from '../../wakeup/invocation-log';
export type {
  WakeUpSettings,
  WakeUpModelSelection,
  WakeUpModelId,
  RunnerDefaultModel
} from '../../wakeup/settings';
export type {
  PhasePrecedenceLayer,
  PhasePrecedenceProjection
} from '../../config/phase-precedence';
export type { TelemetrySnapshot, TelemetryStatus } from '../../telemetry/telemetry-snapshot';

/**
 * Feature 011 — delayed-retry projection on the active run.
 *
 * - `pendingRetryAt`: ISO timestamp when the retry will fire, or null
 *   when no retry is pending (FR-008 hidden-when-not-pending).
 * - `pendingRetryCause`: 'transient_error' | 'rate_limit' | null. Matches
 *   the disjoint classifier in src/parser/transient-error.ts.
 * - `delayedRetryCount`: 0..5. The 5th failure trips the cap (FR-006);
 *   webview surfaces the count to inform the operator how close they
 *   are to cap exhaustion.
 */
export type DelayedRetryCauseProjection = 'transient_error' | 'rate_limit' | null;

export interface DelayedRetryState {
  readonly pendingRetryAt: string | null;
  readonly pendingRetryCause: DelayedRetryCauseProjection;
  readonly delayedRetryCount: number;
}

export interface WorkflowSnapshot {
  readonly schemaVersion: 3;
  readonly isPrimary: boolean;
  readonly status: WorkflowStatus;
  readonly activeFeature: ActiveFeatureSummary | null;
  readonly phases: readonly PhaseTile[];
  readonly queue: QueueProjection;
  readonly phaseOverrides: readonly {
    readonly phaseId: string;
    readonly action: 'skipped' | 'disabled' | 'removed';
  }[];
  readonly manualPauseAt: string | null;
  // Feature 028 — extends with `'breakpoint-paused'` for future-phase
  // breakpoint fires. UI uses this to distinguish active-pause from
  // breakpoint-paused styling on the active phase tile.
  readonly manualPauseCause: 'operator-paused' | 'queue-paused-mid-run' | 'breakpoint-paused' | null;
  /**
   * Feature 028 — per-run future-phase breakpoints projected for the UI.
   * Sorted by `setAt` ascending for deterministic ordering. Empty when
   * the active run has no breakpoints; the field is always present so
   * the webview can read it without an existence guard.
   */
  readonly phaseBreakpoints: readonly {
    readonly phaseId: string;
    readonly setAt: string;
    readonly actor: 'operator' | 'system';
  }[];
  /**
   * Feature 028 — id of the phase that fired the breakpoint, non-null
   * iff `manualPauseCause === 'breakpoint-paused'`.
   */
  readonly resumeTargetPhaseId: string | null;
  /**
   * Feature 028 — id of the active `WorkflowRun` (distinct from
   * `activeFeature.id`, which is the queue/task id). Non-null when a
   * run is in flight; the webview needs this to target the two
   * breakpoint IPC commands `CMD_SET_PHASE_BREAKPOINT` and
   * `CMD_CLEAR_PHASE_BREAKPOINT` at the controller.
   */
  readonly activeRunId: string | null;
  /**
   * Feature 087 (T064, FR-043) — the named outputs the Run recorded at
   * completion, each a **location, never content** (FR-040a). Absent on every
   * Run that recorded none, which is every Run started outside the composer and
   * every composed Run before it completes. An entry whose status is
   * `unresolved` carries no reference and is shown alongside the rest (FR-042).
   */
  readonly runOutputs?: readonly RunOutputRecord[];
  /** Backend inherited by phases whose run snapshot predates runner pinning. */
  readonly defaultRunnerKind: BackendRunnerKind;
  readonly auditTail: readonly AuditTailEntry[];
  /**
   * Debug log tail — recent SanitizedLogger output projected for the
   * System tab. Populated from the WebviewLogSink ring buffer. Always
   * present; empty array when no logs have been captured.
   */
  readonly debugLogTail: readonly DebugLogEntry[];
  readonly liveActivity: LiveActivity;
  readonly workflowElapsedMs: number | null;
  readonly monitor: CliMonitorState | null;
  readonly history: readonly HistoryEntry[];
  readonly producedAt: string;
  readonly activePipeline?: ActivePipelineSummary;
  readonly availablePipelines: readonly PipelineDef[];
  readonly availablePhases: readonly PhaseDef[];
  readonly availableModels: Record<BackendRunnerKind, readonly string[]>;
  readonly availableBackends: readonly BackendRunnerKind[];
  readonly backendPingState: BackendPingState;
  /**
   * Feature 011 — delayed-retry state on the active run. Always present
   * (even when there is no active run); fields are null/0 when no retry
   * is pending. Webview reads `pendingRetryAt !== null` to gate the
   * "Retry Phase Now" affordance.
   */
  readonly delayedRetry: DelayedRetryState;
  /**
   * Feature 011 — scalar `schegent.*` settings projected for the
   * Settings surface. Always present (defaults populated when the
   * workspace/user override is absent).
   */
  readonly generalSettings: GeneralSettings;
  readonly sessionArtifacts: SessionArtifactsProjection;
  readonly evidenceHealth: EvidenceHealthSnapshot;
  /**
   * Feature 014 (BUG-001 / BUG-002) — Wake up settings projected for
   * the Settings surface. Always present (defaults populated when the
   * user-scope override is absent). The webview's WakeUpTab hydrates
   * its draft from this field on mount and resyncs via a `$effect`
   * when the projection changes (FR-025, SC-010).
   */
  readonly wakeUpSettings: WakeUpSettings;
  /**
   * Feature 024 — latest Wake up attempts projected from the
   * user-data wakeup invocation log. Strings are sanitized and capped
   * before they enter the snapshot.
   */
  readonly wakeUpLog: WakeUpLogProjection;
  /**
   * Feature 031 / data-model §7 — DISPLAY-ONLY wake-up surface. Always
   * present so the webview can render the model dropdown and the
   * "View session log" affordance without an existence guard.
   *
   * - `model`: the operator's current `WakeUpModelSelection` (closed
   *   union; defaults to `'runner-default'`).
   * - `sessionLogPath`: absolute path to the host-composed
   *   `<globalStorageUri>/wakeup/session.log` (composed host-side from
   *   the existing `globalStorageUri` resolver — never from operator
   *   input). The webview NEVER routes this path back to the host; the
   *   `CMD_READ_WAKEUP_SESSION_LOG` payload carries `correlationId`
   *   only.
   */
  readonly wakeUp: {
    readonly model: WakeUpModelSelection;
    readonly sessionLogPath: string;
  };
  /**
   * Feature 026 — per-phase precedence projection. Flat map keyed by
   * `"<phaseId>::<fieldKey>"` whose value is the layer that provided
   * the effective value (`'workspace' | 'user' | 'built-in' | 'unset'`).
   * UI-only — never persisted, never written to the audit log or
   * runtime log sink. Optional and present only when the merged
   * catalog has been computed; absent when no catalog read has
   * occurred yet (e.g. very first idle snapshot).
   */
  readonly phasePrecedence?: PhasePrecedenceProjection;
  /** Feature 081 — authoritative source-aware Phase catalog; absence means loading. */
  readonly phaseCatalog?: PhaseCatalogProjection;
  /**
   * Feature 082 — authoritative source-aware Pipeline catalog for the Library
   * and Builder. Additive and optional: `availablePipelines` keeps its runtime
   * selection meaning, and absence means the host has not resolved a catalog
   * yet, so the editor renders a loading state (FR-028). Derived state only —
   * never persisted, never written to `WorkflowRun` or the audit log.
   */
  readonly pipelineCatalog?: PipelineCatalogProjection;
  /**
   * Feature 083 — authoritative source-aware Workflow catalog for the Workflow
   * Library and Graph Builder. Additive and optional, so a snapshot produced
   * before this feature deserializes unchanged and `SCHEMA_VERSION` does not
   * move. Names the *definition* sense of "Workflow"; the run-side
   * `WorkflowSnapshot` field above is untouched (FR-046). Derived state only —
   * never persisted, never written to `WorkflowRun` or the audit log.
   */
  readonly workflowCatalog?: WorkflowCatalogProjection;
  /**
   * Feature 088 — the connected runs the operator can act on, each already
   * folded to per-node state, legal actions, and `hydrating` by
   * `connected-run-projector.ts`. Derived on read from the stored aggregate and
   * the current child-run states (FR-002); nothing here is persisted, and the
   * refusal arms of `CMD_CONTINUE_WORKFLOW` carry this same shape so the view
   * has one renderer rather than two. Additive and optional — a host with no
   * connected-run wiring omits it and `SCHEMA_VERSION` does not move.
   */
  readonly connectedRuns?: readonly ConnectedRunProjection[];
  /**
   * Feature 033 — ephemeral per-subprocess telemetry for the in-flight
   * task. Present (non-null) only while a Claude CLI subprocess is alive
   * (or for one publish cycle after exit to surface the final sample).
   * Never persisted to `WorkflowRun`, never written to the audit log.
   * Always present on the snapshot envelope so the webview never gates
   * on existence; the field is `null` when no subprocess is in flight.
   */
  readonly telemetry: TelemetrySnapshot | null;
  /**
   * Feature 059 — per-capability trust projection. Always present on the
   * envelope so the webview can render policy banners and disable Save
   * affordances without an existence guard.
   *
   * - `workspaceTrust`: mirrors `vscode.workspace.isTrusted`. When `false`,
   *   all four `resolvedTrust.*` fields are also `false` (the ceiling
   *   per the resolution ladder).
   * - `resolvedTrust.phases`: result of `isCapabilityAllowed('phases')`.
   *   Drives the Phases-tab Save button and policy banner.
   * - `resolvedTrust.retryConditions`: result of
   *   `isCapabilityAllowed('retryConditions')`. Drives the per-row
   *   retry-condition column read-only state.
   * - `resolvedTrust.pipelineOverrides`: result of
   *   `isCapabilityAllowed('pipelineOverrides')`. Drives the Pipelines-
   *   tab Save button and policy banner.
   * - `resolvedTrust.workflowOverrides` (feature 083): result of
   *   `isCapabilityAllowed('workflowOverrides')`. Drives the Workflows-
   *   tab Save button and policy banner. A distinct capability from
   *   `pipelineOverrides` — projected separately so the Builder cannot
   *   infer one from the other.
   *
   * Contract:
   * `specs/059-fine-grained-trust-scopes/contracts/trust-projection-contract.md`.
   */
  readonly workspaceTrust: boolean;
  readonly resolvedTrust: {
    readonly phases: boolean;
    readonly retryConditions: boolean;
    readonly pipelineOverrides: boolean;
    readonly workflowOverrides: boolean;
  };
  /**
   * Feature 063 (FR-021) — projected confirmation-prompt suppression
   * set. Optional for legacy-tolerance: idle snapshots and tests that
   * stub a minimal store omit it; the webview treats `undefined` the
   * same as "no suppressions" (modal always shown).
   */
  readonly confirmSuppression?: {
    readonly version: 1;
    readonly suppressedActionKeys: readonly string[];
  };
}

export interface SessionArtifactsProjection {
  readonly artifactCount: number;
  readonly totalBytes: number;
  readonly lastSweepAt: string | null;
  readonly lastSweepFailures: number;
}

/**
 * Feature 059 — fail-closed defaults for the trust projection. Used on
 * the idle snapshot and as the fallback when the resolver throws. The
 * explicit `TrustProjection` annotation widens the literal booleans to
 * the `WorkflowSnapshot` field type.
 */
interface TrustProjection {
  readonly workspaceTrust: boolean;
  readonly resolvedTrust: Readonly<{
    phases: boolean;
    retryConditions: boolean;
    pipelineOverrides: boolean;
    workflowOverrides: boolean;
  }>;
}

export const IDLE_TRUST_PROJECTION: TrustProjection = Object.freeze({
  workspaceTrust: false,
  resolvedTrust: Object.freeze({
    phases: false,
    retryConditions: false,
    pipelineOverrides: false,
    workflowOverrides: false
  })
});

export const AUDIT_TAIL_MAX = 50;
export const RECENT_QUEUE_MAX = 5;
export const HISTORY_MAX = 50;

export const IDLE_LIVE_ACTIVITY: LiveActivity = Object.freeze({
  summary: null,
  category: null,
  lastEventAt: null,
  freshness: 'idle',
  staleSeconds: null
});

const BUILT_IN_DISPLAY_NAMES: Record<string, string> = {
  'speckit-specify': 'Spec-kit Specify',
  'speckit-clarify': 'Spec-kit Clarify',
  'speckit-plan': 'Spec-kit Plan',
  'speckit-tasks': 'Spec-kit Tasks',
  'speckit-analyze': 'Spec-kit Analyze',
  'speckit-implement': 'Spec-kit Implement',
  finalize: 'Finalize'
};

export function buildEmptyPhases(): readonly PhaseTile[] {
  return BUILT_IN_PHASE_NAMES.map((name, idx) => ({
    name,
    displayName: BUILT_IN_DISPLAY_NAMES[name],
    order: idx + 1,
    state: 'not-started' as const,
    iteration: 0,
    lastResult: null,
    elapsedMs: 0,
    subProgress: null
  }));
}

export function buildIdleSnapshot(opts: {
  isPrimary: boolean;
  producedAt?: string;
}): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    isPrimary: opts.isPrimary,
    status: 'idle' as const,
    activeFeature: null,
    phases: Object.freeze(buildEmptyPhases().map((p) => Object.freeze(p))),
    queue: Object.freeze({
      inFlight: null,
      pending: Object.freeze([]) as readonly QueueItem[],
      recent: Object.freeze([]) as readonly QueueItem[],
      orderedItems: Object.freeze([]) as readonly QueueItem[],
      queues: Object.freeze([]) as readonly QueueSummary[],
      paused: false,
      pausedReason: null,
      lifecycle: 'active-empty' as const,
      scheduledStartAt: null,
      scheduledStartSource: null
    }),
    phaseOverrides: Object.freeze([]),
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: Object.freeze([]),
    resumeTargetPhaseId: null,
    activeRunId: null,
    defaultRunnerKind: 'claude',
    auditTail: Object.freeze([]) as readonly AuditTailEntry[],
    debugLogTail: Object.freeze([]) as readonly DebugLogEntry[],
    liveActivity: IDLE_LIVE_ACTIVITY,
    workflowElapsedMs: null,
    monitor: null,
    history: Object.freeze([]) as readonly HistoryEntry[],
    producedAt: opts.producedAt ?? new Date().toISOString(),
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }) as unknown as Record<BackendRunnerKind, readonly string[]>,
    availableBackends: Object.freeze([] as readonly BackendRunnerKind[]),
    backendPingState: Object.freeze({ status: 'idle' as const }),
    delayedRetry: IDLE_DELAYED_RETRY,
    generalSettings: IDLE_GENERAL_SETTINGS,
    sessionArtifacts: IDLE_SESSION_ARTIFACTS,
    evidenceHealth: IDLE_EVIDENCE_HEALTH,
    wakeUpSettings: IDLE_WAKEUP_SETTINGS,
    wakeUpLog: IDLE_WAKEUP_LOG,
    wakeUp: IDLE_WAKEUP_PROJECTION,
    // Feature 033 — telemetry is ephemeral and absent on idle snapshots.
    telemetry: null,
    // Feature 059 — idle snapshot uses fail-closed trust defaults until
    // the projector composes the first resolver read.
    workspaceTrust: IDLE_TRUST_PROJECTION.workspaceTrust,
    resolvedTrust: IDLE_TRUST_PROJECTION.resolvedTrust
  });
}

export const IDLE_DELAYED_RETRY: DelayedRetryState = Object.freeze({
  pendingRetryAt: null,
  pendingRetryCause: null,
  delayedRetryCount: 0
});

export const IDLE_SESSION_ARTIFACTS: SessionArtifactsProjection = Object.freeze({
  artifactCount: 0,
  totalBytes: 0,
  lastSweepAt: null,
  lastSweepFailures: 0
});

/**
 * Feature 011 — safe defaults for the `generalSettings` projection.
 * Mirrors the `package.json` defaults so the webview can render the
 * Settings surface even before the projector has finished its first
 * `onDidChangeConfiguration` round-trip.
 */
export const IDLE_GENERAL_SETTINGS: GeneralSettings = Object.freeze({
  cliPath: 'claude',
  codexPath: 'codex',
  agyPath: 'agy',
  loggingVerbose: false,
  loopMaxIterations: 10,
  invocationTimeoutSeconds: 5400,
  watchdogPollIntervalMinutes: 30,
  auditRotationSizeMB: 5,
  auditRotationMaxAgeDays: 30,
  defaultPipelineId: 'speckit-new-feature',
  fatalSignatures: Object.freeze([]) as readonly string[],
  claudeAutoCompactPctOverride: undefined,
  queueGlobalConcurrencyCap: 1,
  queueDefaultQueueId: 'default',
  runtimeLogLevel: 'INFO',
  runtimeLogFilePath: '',
  runtimeLogMaxBytes: 5 * 1024 * 1024,
  runtimeLogMaxGenerations: 3,
  sessionRetentionMaxAgeDays: 30,
  sessionRetentionMaxBytes: 512 * 1024 * 1024,
  rawTranscriptMode: 'always',
  retryMaxAttempts: 5,
  scopes: Object.freeze({
    cliPath: 'default',
    codexPath: 'default',
    agyPath: 'default',
    loggingVerbose: 'default',
    loopMaxIterations: 'default',
    invocationTimeoutSeconds: 'default',
    watchdogPollIntervalMinutes: 'default',
    auditRotationSizeMB: 'default',
    auditRotationMaxAgeDays: 'default',
    defaultPipelineId: 'default',
    fatalSignatures: 'default',
    claudeAutoCompactPctOverride: 'default',
    queueGlobalConcurrencyCap: 'default',
    queueDefaultQueueId: 'default',
    runtimeLogLevel: 'default',
    runtimeLogFilePath: 'default',
    runtimeLogMaxBytes: 'default',
    runtimeLogMaxGenerations: 'default',
    sessionRetentionMaxAgeDays: 'default',
    sessionRetentionMaxBytes: 'default',
    rawTranscriptMode: 'default',
    retryMaxAttempts: 'default'
  })
});

/**
 * Feature 014 (BUG-001 / BUG-002) — safe defaults for the
 * `wakeUpSettings` projection. Mirrors `DEFAULTS` in
 * `src/wakeup/settings.ts` so the webview can render the Wake up
 * Settings tab even before the projector has finished its first
 * `onDidChangeConfiguration` round-trip.
 */
export const IDLE_WAKEUP_SETTINGS: WakeUpSettings = Object.freeze({
  enabled: false,
  schedulerType: 'chronological',
  chronologicalTime: '04:00',
  periodicInterval: 'Every 4h',
  // Feature 031 — sentinel meaning "no `--model` flag passed to the
  // Claude CLI"; runner picks its own default.
  model: 'runner-default' as const
});

export const IDLE_WAKEUP_LOG: WakeUpLogProjection = Object.freeze({
  entries: Object.freeze([])
});

/**
 * Feature 031 — DISPLAY-ONLY defaults for the wake-up surface. Always
 * present on the idle snapshot so the webview never gates on existence.
 * `model` matches `IDLE_WAKEUP_SETTINGS.model` and `sessionLogPath` is an
 * empty string until the host wires its `getWakeupSessionLogPath` dep.
 */
export const IDLE_WAKEUP_PROJECTION: {
  readonly model: WakeUpModelSelection;
  readonly sessionLogPath: string;
} = Object.freeze({
  model: 'runner-default' as const,
  sessionLogPath: ''
});

export function isRecursivePhase(name: PhaseName): boolean {
  return name === 'speckit-clarify' || name === 'speckit-analyze';
}

export function isBuiltInPhase(name: string): name is BuiltInPhaseName {
  return (BUILT_IN_PHASE_NAMES as readonly string[]).includes(name);
}
