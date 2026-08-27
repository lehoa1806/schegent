import type {
  PhaseBinding,
  PipelineExecutionDefaults,
  PipelineInputPort,
  PipelineOutputPort
} from './pipeline-definitions';

// FR-R3-132 (T1502, FR-001) — the vocabulary the snapshot carries, given a
// contracts home so both sides import it instead of one side retyping it.
//
// A FIRST VERSION OF THE CENSUS LOOKED AT THREE DIRECTORIES — `src/contracts`,
// `src/state`, `src/ui` — and reported 0 duplicated declarations. A review pointed
// at `EvidenceSinkStatus` and three neighbours in
// `src/services/evidence-health/evidence-health-monitor.ts`: byte-identical to the
// mirror's copies, and counted as "webview-local" because the gate was not
// looking there. Widening the walk to `src/` turned 0 into 13.
//
// That is the more useful finding than the 13: a gate that polices copies while
// looking at a quarter of the tree reports a number, not a fact. The census now
// walks the whole host source tree.
//
// WHAT BELONGS HERE. Shapes the sidebar snapshot carries across the IPC boundary,
// declared next to code that does something else. Each one moved; its original
// module re-exports it, so no host call site changed.

// From `src/lib/webview-log-sink.ts`.
export interface DebugLogEntry {
  /** Monotonic counter — unique within the sink's lifetime. */
  readonly id: number;
  /** ISO 8601 timestamp parsed from the SanitizedLogger line prefix. */
  readonly timestamp: string;
  /** Log level parsed from the SanitizedLogger line prefix. */
  readonly level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  /** Sanitized message body (secrets already redacted by SanitizedLogger). */
  readonly message: string;
}

// From `src/queue/feature-request.ts`.
/**
 * Queue lifecycle discriminator. Single source of truth for whether
 * `AutoDrainCoordinator` may promote the next pending task.
 *
 * - `running`         — `inFlightId !== null`; an in-flight task is draining.
 * - `operator-paused` — operator paused the queue; auto-drain is suppressed.
 * - `idle-pending`    — entered from `active-empty` via an enqueue without an
 *                       explicit start. May carry a scheduled trigger.
 * - `active-empty`    — no in-flight, no operator pause, no pending start
 *                       intent — the steady-state default.
 *
 * Transition graph and lockstep invariants live in
 * [data-model.md §QueueLifecycle](../../specs/065-enqueue-start-separation/data-model.md).
 */
export type QueueLifecycle =
  | 'running'
  | 'operator-paused'
  | 'idle-pending'
  | 'active-empty';

// From `src/catalog/changed-fields.ts`.
/**
 * A top-level field that differs and has no entry-level story to tell.
 *
 * Deliberately carries nothing but its name (FR-008). The old and new values are
 * not projected: they are the definition body, and the projection contract holds
 * that no body crosses the boundary.
 */
export interface ChangedScalarField {
  readonly field: string;
  readonly change: 'differs';
}

/**
 * One of the four ordered collections, with its entries accounted for.
 *
 * All three lists empty is a real and meaningful result: it says an entry changed
 * in place, keeping its identity while its content moved. There is no fourth
 * `modified` bucket, so this is how that case reads, and it is never wrong —
 * the field is only present at all because something in it differs.
 */
export interface ChangedCollectionField {
  readonly field: string;
  readonly change: 'collection';
  /** Entry identities the draft has and the active version does not. */
  readonly added: readonly string[];
  /** Entry identities the active version has and the draft does not. */
  readonly removed: readonly string[];
  /**
   * Entries in both whose position **among the shared entries** moved.
   *
   * Relative order, not absolute index. An insertion at the front shifts every
   * absolute index behind it, and reporting all of those as reorderings buries
   * the one change that matters under its own consequences (FR-008). An entry
   * already named in `added` or `removed` is excluded — with a repeated entry
   * both can otherwise be true of the same name at once.
   */
  readonly reordered: readonly string[];
}

export type ChangedField = ChangedScalarField | ChangedCollectionField;

/**
 * What a publish would change (FR-008, FR-009).
 *
 * `no-prior-version` is its own arm rather than "everything was added" because
 * those are different facts: the second tells an operator publishing for the
 * first time that their entire definition changed, which is true and tells them
 * nothing they can act on.
 */
export type ChangedFieldSummary =
  | { readonly kind: 'no-prior-version' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'changed'; readonly fields: readonly ChangedField[] };

// From `src/config/general-settings.ts`.
/** Setting scope as projected to the webview. */
export type SettingScope = 'workspace' | 'user' | 'default';

// From `src/lib/runtime-log/runtime-log-level.ts`.
// Feature 019 — Runtime log level severity helpers.
//
// The runtime-log severity ladder mirrors the existing `SanitizedLogger`
// method set (info/warn/error) plus the new `debug()` level added in
// T010. Ordering: DEBUG < INFO < WARN < ERROR.
//
// `shouldEmit(record, configured)` is the gate used by the sink: it
// allows the record if its severity is ≥ the configured filter, so
// configuring `WARN` admits both WARN and ERROR records and rejects
// DEBUG / INFO.

export type RuntimeLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

// From `src/telemetry/telemetry-snapshot.ts`.
/**
 * Process status at the sample boundary. Closed enum.
 */
export type TelemetryStatus =
  | 'active'
  | 'sleeping'
  | 'zombie'
  | 'exited'
  | 'killed'
  | 'unavailable';

export interface TelemetrySnapshot {
  /** OS process id of the sampled subprocess. */
  readonly pid: number;
  /** Process status at the sample boundary. */
  readonly status: TelemetryStatus;
  /** Latest CPU utilization as a percentage (0–100 per core; `ps -%cpu` semantics on macOS/Linux). Null when unavailable. */
  readonly cpuPercent: number | null;
  /** Resident set size in bytes at the sample boundary. Null when unavailable. */
  readonly memoryRssBytes: number | null;
  /** Wall-clock uptime since the subprocess `started` event, in milliseconds. Null when unavailable. */
  readonly uptimeMs: number | null;
  /** Sampling timestamp (ISO 8601, millisecond precision). */
  readonly sampledAt: string;
}

// From `src/services/evidence-health/evidence-health-monitor.ts`.
export type EvidenceSinkStatus = 'healthy' | 'degraded' | 'unavailable';

export type EvidenceOverallStatus = 'healthy' | 'degraded' | 'unavailable';

export type EvidenceContinuationPolicy = 'fail-closed' | 'continue-degraded';

// From `src/config/pipeline-config.ts`. The webview's name for it differs; see the alias at the
// re-export in `webview-ui/src/lib/snapshot-types.ts`.
// Feature 082 — the runtime Pipeline shape. `id`, `name`, and `phases` are the
// legacy required trio; every contract field added by the Pipeline Builder is
// optional and normalizes on parse so a row authored before those fields existed
// keeps resolving without a rewrite (research R2).
export interface PipelineDef {
  readonly id: string;
  readonly name: string;
  readonly phases: readonly string[];
  readonly description?: string;
  readonly version?: number;
  readonly inputs?: readonly PipelineInputPort[];
  readonly outputs?: readonly PipelineOutputPort[];
  readonly bindings?: readonly PhaseBinding[];
  readonly executionDefaults?: PipelineExecutionDefaults;
  readonly recommendedNext?: readonly string[];
}

// From `src/services/evidence-health/evidence-health-monitor.ts`. The webview's name for it differs; see the alias at the
// re-export in `webview-ui/src/lib/snapshot-types.ts`.
export interface EvidenceSinkHealth {
  readonly status: EvidenceSinkStatus;
  readonly continuationPolicy: EvidenceContinuationPolicy;
  readonly failureCount: number;
  readonly lastFailureAt: string | null;
  readonly cause: string | null;
}
