import type { DebugLogEntry } from '../../lib/webview-log-sink';
import type { BackendPingState } from '../../services/backend-ping-service';
import type { PhaseDefinition, PhaseSourceStatus } from '../../contracts/process-definitions';
import type {
  PipelineDefinition,
  PipelineInputPortType,
  PipelineSourceStatus
} from '../../contracts/pipeline-definitions';
import type {
  WorkflowDefinition,
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

import type { CatalogVersionId } from '../../contracts/catalog-store';
import type { DefinitionState, ExpectedDraftVersion } from '../../contracts/catalog-lifecycle';
import type {
  ChangedCollectionField,
  ChangedField,
  ChangedFieldSummary,
  ChangedScalarField
} from '../../catalog/changed-fields';
export type { ChangedCollectionField, ChangedField, ChangedFieldSummary, ChangedScalarField };

export const SCHEMA_VERSION = 4 as const;

/**
 * Feature 101 (T013) — one retained version, as the history panel lists it.
 *
 * Metadata only (FR-012): the version id, when it was written, when it first went
 * live or that it never has, whether it is the active one, and the note written
 * with it. **No `contentHash` and no body.** The hash is the store's integrity
 * check and means nothing to an operator; the body is fetched a version at a time
 * by `CMD_READ_DEFINITION_VERSION`, because eagerly projecting every retained body
 * of every definition is fifty bodies per definition on every snapshot push.
 */
export interface BuilderVersionEntry {
  readonly versionId: CatalogVersionId;
  readonly createdAt: number;
  /** When this version first became active, or `null` while it never has. */
  readonly publishedAt: number | null;
  readonly isActive: boolean;
  /** The operator's note on the save that produced it. `null` renders as empty, never as "null". */
  readonly note: string | null;
}

/**
 * Feature 101 (T013) — a definition's lifecycle, as the Builder reads it.
 *
 * **One nested field rather than six flat ones**, and the nesting is the point:
 * these six facts are present together or not at all. A host with no catalog store
 * wired projects rows out of a resolved catalog it was handed directly and has no
 * manifest entry behind any of them — and there is no honest value for `state`,
 * `versions`, or `activeVersionId` in that situation. Every candidate filler breaks
 * one of the contract's own invariants: `'active'` with no `activeVersionId` breaks
 * the third, an empty `versions` the fourth, and a synthesized version id would be
 * quoted straight back at the host by a history read. Absent is the truth, and one
 * optional field says it in a way six optional fields could drift out of.
 *
 * Contract: `specs/101-builder-surface/contracts/builder-projection.md` §A.2.
 */
export interface BuilderLifecycle {
  /**
   * FR-005 — the return of `deriveDefinitionState`, never a local mapping. A
   * second derivation is a second oracle even on the day it agrees.
   */
  readonly state: DefinitionState;
  /** First save. Never moves. Epoch ms. */
  readonly createdAt: number;
  /** Last effective save. Epoch ms. */
  readonly updatedAt: number;
  /** FR-006 — **absent**, never `''`, when the definition has never been published. */
  readonly activeVersionId?: CatalogVersionId;
  /**
   * FR-012 — the optimistic-concurrency token every lifecycle write carries.
   *
   * The return of `currentDraftToken`, for the same reason `state` is the return
   * of `deriveDefinitionState`: the `draftVersionId ?? NO_DRAFT` fold is the one
   * thing standing between two windows racing a first draft and one silently
   * overwriting the other, and a webview that did the fold itself would be the
   * second place it could be got wrong. The raw pointer is deliberately not
   * projected — there is nothing the surface can correctly do with it that this
   * token does not already say.
   *
   * Opaque to the webview: echoed back verbatim, never parsed, never compared.
   */
  readonly expectedDraftVersion: ExpectedDraftVersion;
  /** Newest first. The surface does not sort. Non-empty for any definition the store holds. */
  readonly versions: readonly BuilderVersionEntry[];
  /** FR-011 — present if and only if `state` is `'active-with-draft'`. */
  readonly changedFields?: ChangedFieldSummary;
}

// Feature 098 (T039, FR-020) — `BUILT_IN_PHASE_NAMES`, its `PHASE_NAMES` alias
// and the `BuiltInPhaseName` union it derived are gone, together with the
// mirrored copy in `webview-ui/src/lib/snapshot-types.ts` (T040) that they were
// kept literal-for-literal in step with. A snapshot carries whatever Phase names
// the resolved catalog produced, so a fixed union of seven could only ever be
// wrong about an operator's catalog; `PhaseName` was already `string` for that
// reason, and it is the type the wire has always actually used.
export type PhaseName = string;

export interface PhaseCatalogFieldErrorProjection {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface PhaseCatalogSourceProjection {
  /**
   * `${phaseId}::${index}`, unique over the one layer.
   *
   * Feature 099 (T489a, FR-043) — was `${scope}:${phaseId}` with a positional
   * de-duplication suffix, because two layers could hold the same id. One layer
   * cannot, so the resolver's own key carries through unchanged.
   */
  readonly key: string;
  readonly phaseId: string;
  readonly status: PhaseSourceStatus;
  readonly definition: PhaseDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly errors: readonly PhaseCatalogFieldErrorProjection[];
  readonly modelAvailable?: boolean;
  /** Feature 101 (FR-005, FR-007) — absent on a host with no catalog store wired. */
  readonly lifecycle?: BuilderLifecycle;
}

export interface PhaseCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly PhaseCatalogSourceProjection[];
  readonly effective: readonly PhaseDefinition[];
  /**
   * The store's revision for this kind, echoed back on save (FR-044, FR-044a).
   *
   * Feature 099 (T489a, FR-043) — was one revision per writable layer. There is
   * one layer and one revision; a per-layer map with a single key would be a
   * layer tier kept alive in the shape of a record.
   */
  readonly revision: string;
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
  /** `${pipelineId}::${index}`, unique over the one layer (FR-043). */
  readonly key: string;
  readonly pipelineId: string;
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
  /** Feature 101 (FR-005, FR-007) — absent on a host with no catalog store wired. */
  readonly lifecycle?: BuilderLifecycle;
}

export interface PipelineCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly PipelineCatalogSourceProjection[];
  readonly effective: readonly PipelineDefinition[];
  /** The store's revision for this kind, echoed back on save (FR-043, FR-044a). */
  readonly revision: string;
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
  /** `${workflowId}::${index}`, unique over the one layer (FR-043). */
  readonly key: string;
  readonly workflowId: string;
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
  /** Feature 101 (FR-005, FR-007) — absent on a host with no catalog store wired. */
  readonly lifecycle?: BuilderLifecycle;
}

export interface WorkflowCatalogProjection {
  readonly state: 'ready' | 'error';
  readonly records: readonly WorkflowCatalogSourceProjection[];
  readonly effective: readonly WorkflowDefinition[];
  /** The store's revision for this kind, echoed back on save (FR-043, FR-044a). */
  readonly revision: string;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * Feature 102 — what Runs may start. Contract:
 * `specs/102-runs-launch-surface/contracts/launch-projection.md`.
 *
 * Derived on read from the two catalog projections above, which already carry
 * everything a launchable needs. Nothing here re-resolves the store, and nothing
 * here is persisted.
 */
export interface LaunchablePort {
  readonly portId: string;
  readonly label: string;
  readonly type: PipelineInputPortType;
  /**
   * FR-009 — what the definition itself declares, never what the surface infers.
   *
   * Present for a Pipeline, whose `PipelineInputPort` declares it. **Absent for a
   * Workflow**, because `WorkflowDerivedPort` is `{ nodeId, portId, label, type }`
   * and the derivation does not carry requiredness through. Absent therefore
   * means "the definition does not declare this port required" — reconstructing
   * it here by reaching back into each node's Pipeline would put a second
   * derivation beside `deriveWorkflowPorts`, and the two would disagree the first
   * time either moved.
   */
  readonly required?: boolean;
  readonly description?: string;
  /** Workflows only — which node in the graph asks for this port. */
  readonly nodeId?: string;
}

/** One entry Runs offers. Identity is `(kind, id)`, never `id` alone (FR-014). */
export interface Launchable {
  readonly kind: 'pipeline' | 'workflow';
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /**
   * Required here, unlike on `CatalogVersionRef`. A launchable exists *because*
   * its definition has an active version — that is what put it in the list
   * (FR-003). An entry without one is not an entry.
   */
  readonly activeVersionId: string;
  /** Pipelines: the declared input ports. Workflows: the derived, unsatisfied ones. */
  readonly inputs: readonly LaunchablePort[];
  /** Workflows only; documented non-empty when present. Drives FR-043. */
  readonly startNodeIds?: readonly string[];
}

/**
 * What one section is showing.
 *
 * **`loading` is not an arm.** It is the absence of `launchables` on the
 * snapshot, which is how this file already signals "not resolved" for
 * `phaseCatalog`, `pipelineCatalog`, and `workflowCatalog`. A fourth arm would
 * give one fact two representations, and the two would eventually disagree about
 * a host that has no catalog wired at all.
 *
 * Three arms rather than two because two of them produce an empty list for
 * different reasons and the surface cannot tell them apart from the list: a
 * workspace holding unpublished drafts must be told about *publishing*, not told
 * it has no definitions (FR-028).
 */
export type LaunchSection =
  | { readonly state: 'entries'; readonly entries: readonly Launchable[] }
  | { readonly state: 'no-definitions' }
  | { readonly state: 'none-active' };

export interface LaunchProjection {
  readonly pipelines: LaunchSection;
  readonly workflows: LaunchSection;
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
import type { ManualPauseCause } from '../../state/workflow-run';
export type { QueueLifecycle, ScheduledStartSource };

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
import type { TelemetrySnapshot } from '../../telemetry/telemetry-snapshot';
export type { GeneralSettings } from '../../config/general-settings';
// Feature 099 (T491, FR-041) — `PhasePrecedenceLayer` and `PhasePrecedenceProjection`
// are gone with `config/phase-precedence.ts`. Precedence answered "which layer wins
// for this Phase id"; with one layer the question has no second answer, and a
// projection that reports it would be a tier the operator can still see.
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

/**
 * FR-R3-008 (T379) — the persisted liveness stamp, as the webview sees it.
 *
 * Distinct from `LiveActivity` above, which is derived from the audit tail and
 * from in-memory monitor state, and therefore says nothing after a window
 * reload. This one comes from the Run record, so it survives one — that is the
 * whole point of the field.
 *
 * `null` on the Run projection means **unknown**: a record written before the
 * feature, or a Run whose phase has not produced output yet. It never means
 * "no activity", which is why the shape is nullable rather than zero-filled.
 */
export interface RunLivenessProjection {
  /** ISO-8601, converted at this boundary from the record's epoch ms. */
  readonly lastActivityAt: string;
  readonly stdoutLines: number;
  readonly stderrLines: number;
}

/**
 * FR-R3-008 (T379) — determinate progress against the Run's frozen total.
 *
 * `phasesCompleted` and `phaseCount` exclude the same override set, so the
 * fraction cannot exceed one; `percent` is that fraction, rounded and clamped
 * once here rather than at each renderer. `iterationCap` and
 * `maxPhaseInvocations` are carried for context — the cap is the number the Run
 * froze at creation, so an operator who has since changed the setting can see
 * which one this Run is actually running with.
 *
 * `null` means unknown, for a Run with no recorded total. A renderer must show
 * that as unknown, never as 0%.
 */
export interface RunProgressProjection {
  readonly phasesCompleted: number;
  readonly phaseCount: number;
  readonly iterationCap: number;
  readonly maxPhaseInvocations: number;
  /** 0..100, integer. `100` when the plan has no phases left to run. */
  readonly percent: number;
}

/**
 * Feature 092 (T090, US4) — the per-queue Run projection, and the whole of what
 * v3 published at the root about "the" Run.
 *
 * A queue owns at most one Run (`PER_QUEUE_CAPACITY = 1`), so nesting the
 * run-scoped readings here rather than beside the queue-scoped ones makes the
 * cardinality structural: there is no way to hold a phase list for a queue that
 * has no Run, and no way to read a status without having said which Run's.
 *
 * `null` on `QueueRuntime.inFlightRun` is the empty projection FR-053 requires.
 */
export interface InFlightRunProjection {
  /**
   * Feature 028 — id of the `WorkflowRun` (distinct from `feature.id`, which is
   * the queue/task id). The webview needs it to target the two breakpoint IPC
   * commands `CMD_SET_PHASE_BREAKPOINT` and `CMD_CLEAR_PHASE_BREAKPOINT` at the
   * controller, and feature 092 uses it as the attribution key that scopes
   * output and audit lines to the Run that wrote them (FR-051).
   */
  readonly runId: string;
  readonly status: WorkflowStatus;
  readonly feature: ActiveFeatureSummary | null;
  /** Null on the built-in `standard` pipeline, matching the v3 `activePipeline` omission. */
  readonly pipeline: ActivePipelineSummary | null;
  readonly elapsedMs: number | null;
  readonly liveActivity: LiveActivity;
  /**
   * FR-R3-008 (T379) — last CLI output observed for this Run, from the persisted
   * record. `null` is unknown, not silence; see `RunLivenessProjection`.
   */
  readonly liveness: RunLivenessProjection | null;
  /**
   * FR-R3-008 (T379) — progress against the frozen total. `null` on a Run with no
   * recorded total; see `RunProgressProjection`.
   */
  readonly progress: RunProgressProjection | null;
  /**
   * Feature 011 — delayed-retry state. Always present; fields are null/0 when
   * no retry is pending. The webview reads `pendingRetryAt !== null` to gate
   * the "Retry Phase Now" affordance.
   */
  readonly delayedRetry: DelayedRetryState;
  /**
   * Feature 028 — id of the phase that fired the breakpoint, non-null iff
   * `QueueRuntime.manualPause.cause === 'breakpoint-paused'`.
   */
  readonly resumeTargetPhaseId: string | null;
  /**
   * Feature 087 (T064, FR-043) — the named outputs the Run recorded at
   * completion, each a **location, never content** (FR-040a). Empty on every
   * Run that recorded none, which is every Run started outside the composer and
   * every composed Run before it completes. An entry whose status is
   * `unresolved` carries no reference and is shown alongside the rest (FR-042).
   */
  readonly outputs: readonly RunOutputRecord[];
}

/**
 * Feature 092 (T090, FR-048, FR-050) — one queue's published state.
 *
 * Exactly the ten fields of `data-model.md` §1.4: three from the registry
 * entry, six that v3 published as top-level singulars, and one derived. What
 * is deliberately *not* here is a copy of the audit tail: a line carries the
 * `runId` that wrote it, and `inFlightRun.runId` joins it to a queue, so
 * scoping is a read-side join over one feed rather than N partitioned copies
 * to keep consistent (FR-051).
 */
export interface QueueRuntime {
  readonly queueId: string;
  readonly name: string;
  readonly position: number;
  readonly lifecycle: QueueLifecycle;
  /** `null` when this queue owns no Run — the empty projection of FR-053. */
  readonly inFlightRun: InFlightRunProjection | null;
  readonly phases: readonly PhaseTile[];
  readonly phaseOverrides: readonly {
    readonly phaseId: string;
    readonly action: 'skipped' | 'disabled' | 'removed';
  }[];
  /**
   * Feature 028 — one nullable pair rather than two loose fields, so a cause
   * without a timestamp is unrepresentable. `'breakpoint-paused'` distinguishes
   * a future-phase breakpoint fire from an active pause on the phase tile.
   *
   * BUG-003 — `cause` was a hand-copied inline union and had silently fallen a
   * member behind `ManualPauseCause`. It carries the run-level cause verbatim,
   * so it is that type; re-listing the members here is what let it drift.
   */
  readonly manualPause: {
    readonly at: string;
    readonly cause: ManualPauseCause;
  } | null;
  /**
   * Feature 028 — per-run future-phase breakpoints projected for the UI.
   * Sorted by `setAt` ascending for deterministic ordering. Empty when the
   * queue's Run has no breakpoints, and when it has no Run; the field is always
   * present so the webview can read it without an existence guard.
   */
  readonly phaseBreakpoints: readonly {
    readonly phaseId: string;
    readonly setAt: string;
    readonly actor: 'operator' | 'system';
  }[];
  /** Pending Tasks on this queue, derived from its own rows — never a total. */
  readonly pendingCount: number;
  /**
   * Feature 092 (T108, FR-057) — this queue's own Task rows in position order,
   * active and historical alike, which is what the Queue Detail tier lists.
   *
   * Not served by `QueueProjection.orderedItems`: that list is the **default**
   * queue's rows, and its indices are the global address space the reorder
   * handler translates (`handler-helpers.ts` `fromGlobalPosition`), so widening
   * it would silently retarget every move. A queue's rows therefore hang off the
   * queue, and `pendingCount` above is the same rows counted.
   */
  readonly tasks: readonly QueueItem[];
}

export interface WorkflowSnapshot {
  readonly schemaVersion: 4;
  /**
   * Window primacy, which stays at the root deliberately: it is a property of
   * this window against the workspace, not of any one queue (plan.md D6).
   */
  readonly isPrimary: boolean;
  /**
   * Feature 092 (FR-048) — one entry per registry entry, in position order.
   * Replaces the top-level per-run singulars v3 published; those were deleted
   * rather than deprecated so the compiler locates every consumer (FR-049).
   */
  readonly queues: readonly QueueRuntime[];
  readonly queue: QueueProjection;
  /** Backend inherited by phases whose run snapshot predates runner pinning. */
  readonly defaultRunnerKind: BackendRunnerKind;
  /**
   * The workspace audit feed, not partitioned per queue: a line with no Run —
   * a state migration, a queue mutation — belongs to no queue and must not be
   * dropped. Per-queue scoping is the `runId` join described on `QueueRuntime`.
   */
  readonly auditTail: readonly AuditTailEntry[];
  /**
   * Debug log tail — recent SanitizedLogger output projected for the
   * System tab. Populated from the WebviewLogSink ring buffer. Always
   * present; empty array when no logs have been captured.
   */
  readonly debugLogTail: readonly DebugLogEntry[];
  /**
   * Host-level CLI subprocess telemetry. Stays at the root with `telemetry`
   * below: both have exactly one source in the host, and a per-queue copy would
   * be a second source of truth for a reading neither the queue nor the Run
   * owns. `CliMonitorState` carries its own `runId` for attribution.
   */
  readonly monitor: CliMonitorState | null;
  readonly history: readonly HistoryEntry[];
  readonly producedAt: string;
  readonly availablePipelines: readonly PipelineDef[];
  readonly availablePhases: readonly PhaseDef[];
  /**
   * Model ids each backend was DISCOVERED to offer, for the advisory
   * `modelAvailable` cue only. A live backend fact, re-read every snapshot
   * from the capability service — never the operator's catalog, and never a
   * value to save back. Empty for `claude` and `codex`, whose CLIs expose no
   * way to enumerate models; only `agy` reports a real list.
   */
  readonly availableModels: Record<BackendRunnerKind, readonly string[]>;
  /**
   * The operator's Model Catalog — `schegent.models`, merged user over
   * workspace — which is what the Models editor loads, edits, saves, and
   * exports, and what a Model Catalog import writes.
   *
   * Separate from `availableModels` above because the two answer different
   * questions and moved for different reasons: this changes when the operator
   * or an import edits configuration, that changes when a backend is probed.
   * The Models editor read `availableModels` until this field existed, so a
   * confirmed import wrote `schegent.models` and the page went on showing the
   * capability service's list — and "Save All Models" would then persist that
   * list back over the imported catalog.
   */
  readonly configuredModels: Record<BackendRunnerKind, readonly string[]>;
  readonly availableBackends: readonly BackendRunnerKind[];
  readonly backendPingState: BackendPingState;
  /**
   * Feature 011 — scalar `schegent.*` settings projected for the
   * Settings surface. Always present (defaults populated when the
   * workspace/user override is absent).
   */
  readonly generalSettings: GeneralSettings;
  readonly sessionArtifacts: SessionArtifactsProjection;
  readonly evidenceHealth: EvidenceHealthSnapshot;
  // Feature 099 (T491, FR-041) — `phasePrecedence` is gone. It reported, per Phase
  // field, which of `workspace | user | built-in` supplied the effective value. With
  // one layer every answer would be the same one, and a projection whose value is
  // constant is a tier the Builder keeps rendering after the tier is deleted.
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
   * Feature 102 — what Runs may start: Active only, at the active version,
   * filtered and ordered host-side (FR-001, FR-002, FR-003).
   *
   * Additive and optional. Absence means the host has not resolved a catalog
   * yet, so each section renders a loading state (FR-006) — the same convention
   * the three catalog projections above already use, which is why `LaunchSection`
   * has no `loading` arm. Derived state only: never persisted, never written to
   * `WorkflowRun` or the audit log.
   *
   * `availablePipelines` keeps its existing runtime-selection meaning and is
   * untouched, exactly as feature 082 left it when `pipelineCatalog` arrived.
   */
  readonly launchables?: LaunchProjection;
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
   *   both `resolvedTrust.*` fields are also `false` (the ceiling
   *   per the resolution ladder).
   * - `resolvedTrust.phases`: result of `isCapabilityAllowed('phases')`.
   *   Drives the Phases-tab Save button and policy banner.
   * - `resolvedTrust.retryConditions`: result of
   *   `isCapabilityAllowed('retryConditions')`. Drives the per-row
   *   retry-condition column read-only state.
   *
   * Feature 099 (T492, FR-046) — `pipelineOverrides` and `workflowOverrides`
   * are gone with the layer tier they gated. The Pipelines and Workflows tabs
   * are governed by Workspace Trust alone, which `workspaceTrust` already
   * carries.
   *
   * Contract:
   * `specs/059-fine-grained-trust-scopes/contracts/trust-projection-contract.md`.
   */
  readonly workspaceTrust: boolean;
  readonly resolvedTrust: {
    readonly phases: boolean;
    readonly retryConditions: boolean;
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
export interface TrustProjection {
  readonly workspaceTrust: boolean;
  readonly resolvedTrust: Readonly<{
    phases: boolean;
    retryConditions: boolean;
  }>;
}

export const IDLE_TRUST_PROJECTION: TrustProjection = Object.freeze({
  workspaceTrust: false,
  resolvedTrust: Object.freeze({
    phases: false,
    retryConditions: false
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

/**
 * Feature 092 (T096, FR-054) — the read-side join, spelled once for the host.
 *
 * v3 let any consumer read "the" Run off the root; v4 requires it to say which
 * queue it means. This is that question and nothing more — no fallback to the
 * first queue, no synthesised runtime, because a consumer that names a queue
 * the registry does not have is asking about something that does not exist and
 * should see `null` rather than another queue's Run.
 *
 * The webview has the same join in `snapshot-store.svelte.ts`; the two do not
 * share code because the webview holds its own copy of the wire types, but they
 * are the same rule and neither is entitled to a different answer.
 */
export function findQueueRuntime(
  snapshot: Pick<WorkflowSnapshot, 'queues'>,
  queueId: string
): QueueRuntime | null {
  return snapshot.queues.find((runtime) => runtime.queueId === queueId) ?? null;
}

export function buildIdleSnapshot(opts: {
  isPrimary: boolean;
  producedAt?: string;
}): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    isPrimary: opts.isPrimary,
    // Feature 092 (T091) — no registry has been read yet on an idle snapshot,
    // so there is no queue to publish a runtime for. Empty, never a fabricated
    // default entry: the registry is the only thing entitled to say a queue
    // exists.
    queues: Object.freeze([]) as readonly QueueRuntime[],
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
    defaultRunnerKind: 'claude',
    auditTail: Object.freeze([]) as readonly AuditTailEntry[],
    debugLogTail: Object.freeze([]) as readonly DebugLogEntry[],
    monitor: null,
    history: Object.freeze([]) as readonly HistoryEntry[],
    producedAt: opts.producedAt ?? new Date().toISOString(),
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }) as unknown as Record<BackendRunnerKind, readonly string[]>,
    configuredModels: Object.freeze({ claude: [], codex: [], agy: [] }) as unknown as Record<BackendRunnerKind, readonly string[]>,
    availableBackends: Object.freeze([] as readonly BackendRunnerKind[]),
    backendPingState: Object.freeze({ status: 'idle' as const }),
    generalSettings: IDLE_GENERAL_SETTINGS,
    sessionArtifacts: IDLE_SESSION_ARTIFACTS,
    evidenceHealth: IDLE_EVIDENCE_HEALTH,
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
 *
 * "Mirrors `package.json`" is the whole contract of this object: every value
 * here must equal the `default` its setting contributes in the manifest, and
 * `tests/parity/settings-defaults-parity.test.ts` derives its expectations
 * from that manifest rather than restating them. Feature 094 corrected
 * `queueGlobalConcurrencyCap`, which stayed at the pre-092 value of 1 for
 * three days after the manifest moved to 3, and was displayed to operators
 * for the width of the first configuration round-trip.
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
  // Feature 098 (T048, FR-033) — unset, matching the manifest, the settings
  // schema and the webview idle snapshot. `settings-defaults-parity` compares
  // this object against the manifest, so the four have to move together.
  defaultPipelineId: '',
  fatalSignatures: Object.freeze([]) as readonly string[],
  claudeAutoCompactPctOverride: undefined,
  // Feature 098 (REL-02) — the manifest default moved 3 -> 1. Concurrent
  // Runs share one working tree, so `RunCheckpointService` declines to
  // snapshot above one in-flight Run; at a default of 3 that decline was
  // every fresh install's behaviour. Raising it back is gated on per-run
  // worktree isolation, not on this line.
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
  retryForceContinueOnCap: false,
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
    retryMaxAttempts: 'default',
    retryForceContinueOnCap: 'default'
  })
});

// Feature 098 (FR-008) — `isRecursivePhase` stood here, answering "does this
// Phase loop?" from two hardcoded Spec Kit ids. Its sole caller, the sidebar's
// sub-progress bar, now asks the tile's own frozen definition through the
// controller's `isLoopPhase`, so the host holds one loop predicate rather than
// two that could disagree. See `phase-projector.ts`.
