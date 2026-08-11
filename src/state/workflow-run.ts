import type { Phase, PhaseOutcome } from '../controller/phase';
import type { PhaseDef } from '../config/pipeline-config';
import type {
  PhaseBinding,
  PipelineExecutionDefaults,
  PipelineInputPort,
  PipelineOutputPort
} from '../contracts/pipeline-definitions';
// Feature 087 — type-only, and deliberately so: `contracts/run-request` imports
// `WorkflowRunPipeline` from this file, so a value import either way would be a
// real cycle. Both directions are erased at compile time.
import type { FrozenInputBinding } from '../contracts/run-request';
import type { RunOutputRecord } from '../contracts/run-results';

export interface WorkflowRunPipeline {
  readonly id: string;
  readonly name: string;
  readonly phases: ReadonlyArray<PhaseDef>;
  /**
   * Feature 082 (US5) — the rest of the resolved Pipeline contract, frozen with
   * the Run so ports and bindings cannot drift while the Phase list stays pinned
   * (FR-026, FR-027).
   *
   * Optional, and written only when the resolved definition carried them, so a
   * Run persisted before this feature reads back byte-for-byte unchanged and no
   * `STATE_SCHEMA_VERSION` bump is needed (research R8).
   */
  readonly description?: string;
  readonly version?: number;
  readonly inputs?: readonly PipelineInputPort[];
  readonly outputs?: readonly PipelineOutputPort[];
  readonly bindings?: readonly PhaseBinding[];
  readonly executionDefaults?: PipelineExecutionDefaults;
  readonly recommendedNext?: readonly string[];
}

export type WorkflowRunStatus = 'running' | 'paused' | 'failed' | 'completed' | 'canceled';
export type RawTranscriptMode = 'always' | 'errors-only' | 'off';

export interface GitApprovalReceipt {
  readonly approvedAt: number;
  readonly planFingerprint: string;
  readonly approvedPhaseIds: readonly string[];
}

export interface MutationPlanSnapshot {
  readonly fingerprint: string;
  readonly gitCapablePhaseIds: readonly string[];
  readonly capturedAt: number;
}

export interface TerminalTransitionIntent {
  readonly schemaVersion: 1;
  readonly run: WorkflowRun;
  readonly createdAt: number;
}

export type TerminationReason =
  | 'token'
  | 'open_questions'
  | 'remaining_issues'
  | 'iteration_cap'
  | 'error'
  | 'rate_limit'
  | 'timeout'
  | 'cancel';

export interface SanitizedError {
  code: string;
  message: string;
  phase: Phase | null;
  iteration: number | null;
  at: number;
}

/**
 * Feature 010 — BUG-001 (FR-028). Snapshot of the most recent
 * `phase.retry_evaluated` decision projected onto the operator-visible
 * `WorkflowRun`. Surfaced via the sidebar snapshot so an operator can see
 * which metrics the controller expected but did not find without enabling
 * verbose mode. Additive on the `WorkflowRun` shape — absent on legacy
 * records (no migration required; webview readers tolerate absence).
 *
 * `missingKeys` is alphabetically sorted; empty array means the expression
 * resolved fully against present metrics (per FR-028 — empty, not omitted).
 */
export interface LastRetryDecision {
  readonly phase: Phase;
  readonly iteration: number;
  readonly decision: boolean;
  readonly missingKeys: readonly string[];
  readonly at: number;
}

export interface PhaseResult {
  phase: Phase;
  iteration: number;
  startedAt: number;
  endedAt: number;
  result: PhaseOutcome;
  terminationReason: TerminationReason;
  exitCode: number | null;
  stdoutSummary: string;
  stderrSummary: string;
  auditEntryId: string | null;
}

export type DelayedRetryCause = 'transient_error' | 'rate_limit';

/**
 * Feature 017 — per-run phase override action. `'skipped'` means the
 * runner bypasses one invocation of the phase and transitions to the next
 * phase; `'disabled'` means every future encounter of the phase during
 * this run is bypassed. Feature 022 adds `'removed'`, which omits the
 * phase from this task's visible progression and future execution without
 * mutating the immutable pipeline snapshot. Per-run scope: a new
 * `WorkflowRun` starts with empty `phaseOverrides`. (research.md R-006)
 */
export type PhaseOverrideAction = 'skipped' | 'disabled' | 'removed';

export interface PhaseOverride {
  readonly phaseId: string;
  readonly action: PhaseOverrideAction;
  readonly setAt: number;
  readonly actor: string;
  readonly priorPhaseState?: string;
}

/**
 * Feature 017 — WorkflowRun manual pause causes (kebab-case).
 * Task-level pause causes live on `FeatureRequest.pauseCause`; the run-level
 * pair only records cooperative phase pauses that stop dispatch boundaries.
 *
 * Feature 028 — extends with `'breakpoint-paused'`, set when the driver
 * reaches a phase that has a breakpoint entry. The cause flows to the
 * task-level pause-cause projection (`'breakpoint'`); the run-level
 * `resumeTargetPhaseId` carries the marked phase id so resume invokes
 * the same phase that fired the breakpoint.
 */
export type ManualPauseCause =
  | 'operator-paused'
  | 'queue-paused-mid-run'
  | 'breakpoint-paused';

/**
 * Feature 028 — future-phase breakpoint entry. Operator marks a pending
 * phase as a "pause when reached" point. The pipeline runs preceding
 * phases; when the driver reaches `phaseId`, the runner emits
 * `phase-breakpoint-fired`, consumes the entry, and pauses the run
 * with `manualPauseCause = 'breakpoint-paused'`.
 */
export interface PhaseBreakpoint {
  readonly phaseId: string;
  readonly setAt: number;
  readonly actor: 'operator' | 'system';
}

export interface WorkflowRun {
  id: string;
  featureId: string;
  featureDir: string;
  status: WorkflowRunStatus;
  currentPhase: Phase;
  currentIteration: number;
  startedAt: number;
  lastTransitionAt: number;
  phasesCompleted: PhaseResult[];
  lastError: SanitizedError | null;
  /** Frozen at run creation; legacy records migrate to `always`. */
  rawTranscriptMode?: RawTranscriptMode;
  /** Frozen projection of phases that can mutate Git state. */
  mutationPlan?: MutationPlanSnapshot;
  /** Present only after an operator approved the matching frozen plan. */
  gitApprovalReceipt?: GitApprovalReceipt;
  pipeline?: WorkflowRunPipeline;
  /**
   * Effective global backend captured when the run is created. Phases in new
   * snapshots also persist their effective runner, but this run-level value is
   * the stable fallback for partially migrated snapshots. Missing on records
   * created before runner pinning; those conservatively fall back to Claude.
   */
  defaultRunnerKind?: import('../runner/backend-runner-factory').BackendRunnerKind;
  /**
   * Feature 011 — total delayed-retry attempts for this run. Starts at 0;
   * incremented per FR-002/FR-003; reset to 0 by FR-007/FR-009.
   * MUST be a non-negative integer ≤ DELAYED_RETRY_CAP (5).
   */
  delayedRetryCount: number;
  /**
   * Feature 011 — absolute UTC ms timestamp of the next scheduled delayed
   * retry. Present iff the run is waiting on a delayed retry. Persisted
   * across restart (FR-013).
   */
  pendingRetryAt: number | null;
  /**
   * Feature 011 — cause that triggered the pending retry. Present iff
   * `pendingRetryAt` is non-null (invariant enforced by `setRun()`).
   */
  pendingRetryCause: DelayedRetryCause | null;
  /**
   * Feature 017/022 — per-run phase overrides (skip / disable / remove).
   * Per-run scope; a new run starts with `[]`. The pipeline snapshot is
   * NEVER mutated; overrides are consulted by `RunDriver.drive()` before invoking
   * each phase and by projectors before rendering phase progression.
   */
  phaseOverrides: PhaseOverride[];
  /**
   * Feature 017 — UTC ms timestamp when the operator paused the active
   * phase. Both-null-or-both-non-null invariant with `manualPauseCause`,
   * enforced by `WorkspaceStateStore.setRun()`.
   */
  manualPauseAt: number | null;
  /**
   * Feature 017 — kebab-case cause for the manual pause. Both-null-or-both-non-null
   * invariant with `manualPauseAt`.
   */
  manualPauseCause: ManualPauseCause | null;
  /**
   * Feature 028 — per-run future-phase breakpoints. Pipeline runs
   * preceding phases; when the driver reaches a phase whose id is in
   * this list, the runner halts with `outcome: 'paused-at-breakpoint'`
   * BEFORE invoking the CLI. New runs start with `[]`. Entries are
   * consumed (filtered out) when the breakpoint fires.
   *
   * Invariants enforced by `WorkspaceStateStore.setRun()`:
   *   - Every `phaseId` MUST appear in `pipeline.phases[].id`.
   *   - No duplicate `phaseId`.
   *   - A `phaseId` MUST NOT appear here AND in `phaseOverrides[]` with
   *     `action ∈ {'skipped','disabled','removed'}`.
   */
  phaseBreakpoints: PhaseBreakpoint[];
  /**
   * Feature 028 — when `manualPauseCause === 'breakpoint-paused'`, the
   * id of the phase that fired the breakpoint. The resume code path
   * invokes this phase. `null` otherwise; invariant: non-null iff
   * `manualPauseCause === 'breakpoint-paused'`.
   */
  resumeTargetPhaseId: string | null;
  /**
   * CLI session ID captured from the Claude CLI's stream-json output.
   * When non-null, retry/resume dispatches use `--resume <sessionId>`
   * instead of `-c` for deterministic session targeting. Absent on
   * legacy runs, runs without stream-json output, or when the parser
   * failed to extract a session ID. Optional field per the additive-
   * projection convention — no migration required.
   */
  lastCliSessionId?: string | null;
  /**
   * Backend that created `lastCliSessionId`. Session identifiers are scoped
   * to a backend provider and MUST only be reused when this value matches the
   * effective backend of the next dispatch. Missing on legacy records; a
   * missing owner fails closed by starting a fresh backend session.
   */
  lastCliSessionRunnerKind?: import('../runner/backend-runner-factory').BackendRunnerKind;
  /**
   * Feature 010 — BUG-001 (FR-028). Most recent `phase.retry_evaluated`
   * decision projected onto the operator-visible run. Absent until the
   * first decision is consulted; absent on legacy persisted records (no
   * migration required — optional field per the additive-projection
   * convention).
   */
  lastRetryDecision?: LastRetryDecision;
  /**
   * Custom continuation prompt provided by the operator on resume.
   * When set, `RunDriver.drive()` uses this instead of rebuilding
   * the phase prompt, allowing a literal "continue" message.
   */
  resumePrompt?: string;
  /**
   * Feature 087 (T035, US4) — the bindings this Run executed with, frozen at
   * submission. Present only on a composed Run; a Run started from any other
   * path carries none.
   *
   * The Pipeline snapshot above already pins *what* runs. This pins *what it
   * was given*, which is the other half of reproducing the Run: the same
   * definition with different inputs is a different execution.
   */
  runInputs?: readonly FrozenInputBinding[];
  /**
   * Feature 087 (T035, US6, FR-040) — the named outputs recorded at completion.
   * Each carries a **location, never content** (FR-040a), and one the Phases
   * never produced is recorded as `unresolved` rather than dropped (FR-042).
   *
   * Absent until the Run completes, and on every Run that declared no outputs.
   */
  runOutputs?: readonly RunOutputRecord[];
}

export interface WorkflowRunSummary {
  id: string;
  featureId: string;
  status: WorkflowRunStatus;
  startedAt: number;
  endedAt: number | null;
}

export interface WorkspaceLock {
  ownerId: string;
  acquiredAt: number;
  heartbeatAt: number;
}

export interface WatchdogState {
  paused: boolean;
  pausedSince: number | null;
  nextPollAt: number | null;
  pollIntervalMs: number;
  lastStatusOk: boolean | null;
  cause: string | null;
}
