// FR-R3-132 (T1502, FR-001) — the snapshot projection shapes, given a contracts
// home so both sides can import them instead of one side retyping them.
//
// WHY THEY WERE COPIED IN THE FIRST PLACE, which is the whole finding.
// `webview-ui/src/lib/snapshot-types.ts` held 51 declarations byte-identical to a
// host declaration, and 24 of them were these — declared in
// `src/ui/sidebar/snapshot.ts`, outside `src/contracts/`.
// `webview-host-import-direction.test.ts` pins the boundary there: values from
// `contracts/` only, types from anywhere but non-contract modules on a dated
// allowlist that is *expected to shrink as shapes move into `contracts/`*. These
// shapes had no contracts home, so the mirror restated them, and a copy kept in
// step by hand is how `QueueSummary.pauseSource` lost `'retry-cap'`.
//
// THEY BELONG HERE ON THE MERITS, not only for the boundary rule: this is the
// snapshot the host publishes and the webview renders. It is the IPC contract in
// the plainest sense — a shape both sides must agree on, where disagreement is a
// defect rather than a preference.
//
// `src/ui/sidebar/snapshot.ts` RE-EXPORTS every name below, so no host call site
// changed when they moved. That is deliberate: a move that also rewrote 40 import
// sites would make the diff unreviewable and hide whether anything else changed.
//
// The layer rule holds — `contracts/` is a leaf. The only types these reference
// from outside the moved set are `PhaseName` and `PipelineInputPortType`, both
// already in `src/contracts/`.
import type { PhaseName } from './phase-identity';
import type { PipelineInputPortType } from './pipeline-definitions';
import type { AuditScope } from './audit-events';
import type { CatalogVersionId } from './catalog-store';
import type { ChangedFieldSummary } from './snapshot-vocabulary';
import type { DefinitionState, ExpectedDraftVersion } from './catalog-lifecycle';

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

export interface ActivePipelineSummary {
  readonly id: string;
  readonly name: string;
}

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
 * FR-R3-130 (T1496) — aggregate stream pressure, as it stands right now.
 *
 * The audit of 2026-08-27's point about the cap-20 ceiling was that an operator can
 * accept it without ever seeing it. `stream-pressure-advice.ts` warns at the moment
 * the cap is chosen; this makes a loaded configuration observable while it is loaded.
 *
 * `ceilingBytes` is what the SAME live buffers could grow to under their own caps —
 * not the product's theoretical maximum. A projection showing 2.56 GiB while two
 * buffers hold 3 MiB would be the arithmetic ceiling `FR-R3-081` corrected, restated
 * on a dashboard.
 */
export interface StreamPressureProjection {
  readonly liveBuffers: number;
  readonly retainedBytes: number;
  readonly ceilingBytes: number;
  /**
   * `os.totalmem()`, carried so the surface that WARNS can reach it.
   *
   * FR-R3-130 (T1495) — the cap warning's threshold is machine-derived, and the
   * point of configuration is a webview dialog with no `os`. It rides with this
   * projection rather than acquiring a field of its own: both facts are about what
   * the machine can hold, and one host read serves both.
   *
   * `0` when unavailable, which `adviseStreamPressure` reads as "do not warn" —
   * a warning derived from an absent fact is worse than silence.
   */
  readonly machineMemoryBytes: number;
}

export interface SessionArtifactsProjection {
  readonly artifactCount: number;
  readonly totalBytes: number;
  readonly lastSweepAt: string | null;
  readonly lastSweepFailures: number;
}
// FR-R3-132 (T1502) — THE SECOND WAVE. These four were NOT byte-identical to the
// mirror when the first 24 moved: each differed by exactly the defect or the
// restated union that this cycle fixed. Correcting the mirror made them identical,
// so they joined the move. That ordering is worth recording: a copy whose only
// difference is a bug does not look like a copy until the bug is fixed.

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

// FR-R3-132 (T1502) — THIS ONE ARRIVED LAST, and the ordering is the record.
//
// It stayed behind in `src/ui/sidebar/snapshot.ts` through two waves because its
// `changes` field is a `ChangedFieldSummary` from `src/catalog/`, and `contracts/`
// is a leaf layer — moving it would have dragged the changed-field family with it.
// That was written up as the stopping line the item asked for.
//
// Then the census widened from three host directories to the whole tree, found
// `ChangedFieldSummary` itself duplicated in the mirror, and moved it to
// `snapshot-vocabulary.ts`. The blocker dissolved as a side effect of fixing a
// different finding, so the allowlist entry recording it was deleted rather than
// left to describe a constraint that had stopped existing.
// Feature 098 (FR-008) — `isRecursivePhase` stood here, answering "does this
// Phase loop?" from two hardcoded Spec Kit ids. Its sole caller, the sidebar's
// sub-progress bar, now asks the tile's own frozen definition through the
// controller's `isLoopPhase`, so the host holds one loop predicate rather than
// two that could disagree. See `phase-projector.ts`.

// FR-R3-132 (T1502) — THIS ONE STAYS, and the reason is the stopping line the item
// asked to be recorded. `BuilderLifecycle.changes` is a `ChangedFieldSummary`,
// declared in `src/catalog/changed-fields.ts`. `src/contracts/` is a LEAF layer
// (`dependency-direction.test.ts`), so moving this declaration there would drag
// the changed-field family with it — a cascade worth its own item and its own
// review, not a side effect of a duplication cleanup.
//
// The mirror therefore keeps a hand-written copy, allowlisted with this reason in
// `tests/lint/snapshot-mirror-census.test.ts`. Both halves of that are deliberate:
// the copy exists, and the gate says out loud that it exists.
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
