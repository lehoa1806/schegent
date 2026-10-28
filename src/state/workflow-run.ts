import type { SpawnIdentity } from '../contracts/spawn-identity';
import type { Phase, PhaseOutcome } from '../controller/phase';
import type { PhaseDef } from '../config/pipeline-config';
import type { CatalogVersionRef } from '../contracts/catalog-version';
import type {
  PhaseBinding,
  PipelineExecutionDefaults,
  PipelineInputPort,
  PipelineOutputPort
} from '../contracts/pipeline-definitions';
// Feature 087 — type-only, and deliberately so: `contracts/run-request` imports
// `WorkflowRunPipeline` from this file, so a value import either way would be a
// real cycle. Both directions are erased at compile time.
import type { ExecutionEnvelope, FrozenInputBinding } from '../contracts/run-request';
import type { FailureCause } from '../contracts/failure-cause';
import type { RunOutputRecord } from '../contracts/run-results';
import type { DegradedPhaseEntry } from '../contracts/snapshot-projections';

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
  /**
   * Feature 102 (T037, FR-021, FR-026) — which published version this snapshot
   * froze, when it was frozen from the catalog rather than supplied ready-made.
   *
   * It lives here, on the body, rather than in a map beside it, because a version
   * that can be separated from the body it describes is the failure this feature
   * exists to prevent. A connected run freezes each member Pipeline once at
   * start; every later member start reads its version off the snapshot it is
   * about to execute, so the version a plan records always describes the body
   * that plan runs — never today's Active version of a definition the run stopped
   * tracking at start.
   *
   * Additive and optional, like feature 082's fields above, so a Run persisted
   * before this feature reads back unchanged and no `STATE_SCHEMA_VERSION` moves.
   */
  readonly catalogVersion?: CatalogVersionRef;
}

export type WorkflowRunStatus = 'running' | 'paused' | 'failed' | 'completed' | 'canceled';
export type RawTranscriptMode = 'always' | 'errors-only' | 'off';

/**
 * The statuses that end a Run.
 *
 * Enumerated, never derived by negating the active status: `!== 'running'` also
 * admits `paused`, and a paused Run is not over — it still owns its queue, its
 * execution lease, and (feature 093) its driving session, and a later resume
 * continues on all three. That distinction is the whole of feature 092's
 * FR-033a and feature 093's RS-3/RS-4, which is why the two disposals hang off
 * one list rather than two agreeing ones.
 *
 * Feature 093 (T044) — this list is that one list. It had grown a copy in
 * `services/execution-lease-release.ts` and another in
 * `services/terminal-transition-coordinator.ts`, and session disposal would
 * have made a third; they are the same rule about the same union, so they read
 * it from the union's own module. Distinct from
 * `WORKFLOW_NODE_TERMINAL_STATUSES` in `contracts/workflow-definitions.ts`,
 * which spells the same three words about a Workflow **node** and is not this.
 */
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'canceled'] as const;

export function isTerminalRunStatus(status: WorkflowRunStatus | string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * The statuses from which no operator control can act — a different question
 * from the one above, and sited here so the difference is unmissable.
 *
 * `failed` is in `TERMINAL_RUN_STATUSES` and **not** here, which is the whole
 * point. Terminality answers "has execution ended, release the lease and the
 * session"; a failed Run has, and does. Operability answers "can the operator
 * still do something with this Run", and for a failed Run the answer is
 * emphatically yes — `skipPhase` advances past the failed phase and wakes the
 * pipeline, and retry re-admits it. Those two controls exist very largely *for*
 * failed Runs. Only `completed` and `canceled` are finished in both senses.
 *
 * Enumerated for the same reason as the list above, and negatively for a
 * further one: spelling the operable set positively would put the pinned
 * per-task status literal in this predicate, and the enumeration that matters
 * here is the short, stable, closed one — a status added later is far more
 * likely to be operable than not, so defaulting an unknown status to operable
 * fails toward a control the operator can still reach rather than one that
 * silently refuses.
 */
export const UNCONTROLLABLE_RUN_STATUSES = ['completed', 'canceled'] as const;

export function isOperableRunStatus(status: WorkflowRunStatus | string): boolean {
  return !(UNCONTROLLABLE_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * FR-R4-F01 (data-model §2) — the statuses `updateRun` writers name in `allowedStatuses`.
 * One definition each, so that "which Runs can this writer still act on" is read from one
 * place and a stale update to a finished Run is refused the same way everywhere.
 *
 * - `LIVE_RUN_STATUSES`: a driver is running or a retry is counting down. Liveness, a retry
 *   decision, a spawn identity, a cancel and a pause act on these and nothing else.
 * - `OPERABLE_RUN_STATUSES`: everything an operator control can still act on. A `failed`
 *   Run is operable (skip and retry exist largely for it) but not live.
 * - `ALL_RUN_STATUSES`: for a write that only REMOVES a field, where a finished Run must
 *   still be reachable.
 */
export const LIVE_RUN_STATUSES: readonly WorkflowRunStatus[] = ['running', 'paused'];
export const OPERABLE_RUN_STATUSES: readonly WorkflowRunStatus[] = ['running', 'paused', 'failed'];
export const ALL_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'running',
  'paused',
  'failed',
  'completed',
  'canceled'
];

/**
 * FR-R4-F01 (contract C2) — what a field update patch may hold: any field of the Run, and
 * `undefined` for a field to REMOVE. `Partial<WorkflowRun>` cannot say the second under
 * `exactOptionalPropertyTypes`, and the removal is the point of an absent field such as
 * `spawnIdentity`, so the patch has its own type rather than a cast at each writer.
 */
export type RunPatch = { [K in keyof WorkflowRun]?: WorkflowRun[K] | undefined };

/**
 * FR-R4-F01 (research R3 #3) — the top-level fields whose value differs between
 * `prev` and `next`, compared by reference, as a PATCH for `updateRun`.
 *
 * This is the driver's patch. It still builds the whole `next` Run in its own code
 * shape, and the store applies to the CURRENT Run only what the driver changed. A
 * field the driver did not touch keeps whatever a concurrent operator, monitor or
 * retry write left there. A field `next` dropped appears with the value
 * `undefined`, which `updateRun` reads as "remove the key".
 *
 * One exception, and the reason it exists: {@link DRIVER_OWNED_RUN_FIELDS} are taken
 * from `next` whether or not they changed. The driver records the backend's session
 * on its in-memory Run when an invocation returns (`RunDriver`, after `dispatchObserved`)
 * and lets the NEXT transition carry it to the store, so by the time `persist` is
 * called `prev` already holds them and a diff against it would never write them. No
 * concurrent writer touches these fields, so writing them from `next` cannot clobber
 * anything; every other field keeps the changed-since-`prev` rule.
 */
export function changedRunFields(prev: WorkflowRun, next: WorkflowRun): RunPatch {
  const before = prev as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) patch[key] = after[key];
  }
  for (const key of DRIVER_OWNED_RUN_FIELDS) patch[key] = after[key];
  return patch as RunPatch;
}

/**
 * FR-R4-F01 — the fields only the driver writes, and writes on its in-memory Run
 * before the transition that persists them: the three CLI-session fields
 * (`NO_CLI_SESSION` is the same trio, cleared together).
 */
export const DRIVER_OWNED_RUN_FIELDS = [
  'lastCliSessionId',
  'lastCliSessionRunnerKind',
  'lastCliSessionCostUsd'
] as const;

/**
 * FR-R4-F01 (FR-008) — what a cancel writes, as a PATCH for `updateRun`: the status
 * and the stamp, and every pause and retry field cleared.
 *
 * The fields are cleared because a Run can be canceled while a pause was requested
 * or a retry was counting down, and `validateRunInvariants` forbids the one-sided
 * pair a half-cleared cancel would leave. `resumeTargetPhaseId` goes with the pause
 * cause it is tied to. One definition, because the command and Task deletion both
 * cancel a Run, and two copies of "what cancel writes" are how they come to differ.
 */
export function canceledRunPatch(now: number): RunPatch {
  return {
    status: 'canceled',
    lastTransitionAt: now,
    manualPauseAt: null,
    manualPauseCause: null,
    resumeTargetPhaseId: null,
    pendingRetryAt: null,
    pendingRetryCause: null,
    creditPause: null,
    // FR-R4-F14 — a failed Run can be canceled, and a failure cause beside `canceled` is refused.
    failureCause: undefined
  };
}

export interface GitApprovalReceipt {
  readonly approvedAt: number;
  readonly planFingerprint: string;
  readonly approvedPhaseIds: readonly string[];
}

export interface MutationPlanSnapshot {
  readonly fingerprint: string;
  readonly gitCapablePhaseIds: readonly string[];
  readonly capturedAt: number;
  /**
   * FR-R3-146 (FR-012) — the pipeline the plan was built from, recorded rather
   * than only hashed.
   *
   * `buildMutationPlan` has always fed `pipeline.id` into the fingerprint, so a
   * snapshot could identify its plan but not name it. A durable Git grant is
   * stored under the fingerprint and has to be legible to the operator who
   * granted it, and a hex digest names nothing.
   *
   * Optional because a Run created before this field existed carries a snapshot
   * without it, and `workflow-controller.ts:780` resumes such a Run from the
   * persisted value rather than rebuilding. Absent means unrecorded, never
   * "no pipeline"; see `UNRECORDED_PIPELINE_ID`.
   */
  readonly pipelineId?: string;
}

export interface TerminalTransitionIntent {
  readonly schemaVersion: 1;
  readonly run: WorkflowRun;
  /**
   * FR-R3-196 — when this transition was first journalled. Kept when a description is added
   * later, and compared against the task row's `updatedAt` on replay.
   */
  readonly createdAt: number;
  /**
   * FR-R3-071 — the sanitized description the terminal transition was
   * completing with, journalled so crash-replay records the operator's text
   * rather than substituting the feature id. Optional: intents written before
   * this field (and the controller's early `begin`) carry none, and replay
   * falls back with a warn. Transient — the intent clears at completion, or is
   * dropped when its Run has moved on — so this does not re-grow the memento the
   * sidecar move shrank.
   */
  readonly description?: string;
}

// FR-R3-075 — 'deadline' is the absolute wall-clock bound; 'timeout' remains
// the idle stall. An operator reading a stopped phase needs to know whether it
// went quiet or ran long, so the two are never collapsed.
//
// Feature 212 (FR-004) — 'pre_spawn_refusal' is the attempt refused before any
// child process existed, distinct from 'error', which describes a child that ran
// and went wrong. Spelled identically here and in the projected `phase-end`
// cause, deliberately unlike the cap classification, which reaches the audit as
// two spellings in ONE record: `cause: 'cap_exhausted'` and
// `terminationReason: 'cap-exhausted'`. The hyphen form is not a member of this
// union — `appendCapExhaustedPhaseEnd()` writes it into a payload typed
// `Record<string, unknown>` (src/controller/phase-runner.ts), which is exactly how it
// escaped this vocabulary. `projectPhaseEnd()` records the consequence
// (audit-payload.ts, the `cause` field's docblock).
//
// FR-R3-172 (FR-013, FR-015, T1744, 2026-09-14) — AMENDED, not replaced: the
// paragraph above is what was true, and it is how the escape is still found. The
// seam it names is now shut. That payload is typed
// `CapExhaustedPhaseEndPayload` (src/controller/cap-exhausted-payload.ts), which
// admits this union plus one named constant for the hyphen form and nothing
// else, so a second non-member cannot leave the same way unannounced. The VALUE
// is unchanged and stays divergent on purpose — it is on disk in every
// cap-exhaustion row already written, and the cost of renaming it is borne by
// records nobody can go back and edit. This union was not widened to accommodate
// it, and must not be: the exception is named at the one site that needs it.
export type TerminationReason =
  | 'deadline'
  | 'token'
  | 'open_questions'
  | 'remaining_issues'
  | 'iteration_cap'
  | 'error'
  | 'rate_limit'
  | 'timeout'
  | 'cancel'
  | 'pre_spawn_refusal'
  // FR-R3-198 — the turn ended unfinished: work still open in the background,
  // or no contract block. Decided from the runner's turn-end facts.
  | 'incomplete_turn';

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
  /**
   * Feature 212 (FR-006, FR-014) — whether the backend's end-of-invocation
   * result envelope was received. Three-state by construction: 'received',
   * 'absent', or the field missing, which means UNKNOWN and must never be read
   * as either value. Records persisted before this feature carry no such field,
   * permanently, and no migration can invent one.
   */
  resultEnvelope?: 'received' | 'absent';
}

export type DelayedRetryCause = 'transient_error' | 'rate_limit';

/**
 * FR-R4-F02 (data-model §3) — the persisted record of a credit pause.
 *
 * At `5d700407` a credit pause left the same persisted shape as a cap-exhausted pause (`paused`, no
 * retry pair, no manual pair), so nothing could tell the two apart and an unattended sweep resumed
 * whichever it found. This is one nullable object, written by the credit arm in the same
 * transition as `status: 'paused'` and cleared by every write that leaves `paused`, so there is no
 * half to leave behind (hard rule 28; `validateRunInvariants`).
 *
 * `windowStartedAt` is null until the first credit poll after the pause; `stoppedAt` is set when
 * the 24-hour polling window ends, and the Run then waits for the operator's Resume.
 */
export interface CreditPause {
  readonly pausedAt: number;
  readonly windowStartedAt: number | null;
  readonly stoppedAt: number | null;
}

/** The Run's credit pause, with an absent key read as `null` (the field is optional on the type). */
export function creditPauseOf(run: Pick<WorkflowRun, 'creditPause'>): CreditPause | null {
  return run.creditPause ?? null;
}

/**
 * FR-R4-F02 (contract W5 G15) — the credit arm's pause, built as one Run: paused and naming its
 * pause in the SAME value, so no write can leave a Run paused for credits that does not say so.
 */
export function creditPausedRun(
  run: WorkflowRun,
  iteration: number,
  phaseResult: PhaseResult,
  at: number
): WorkflowRun {
  return {
    ...run,
    status: 'paused',
    currentIteration: iteration,
    lastTransitionAt: at,
    phasesCompleted: [...run.phasesCompleted, phaseResult],
    creditPause: { pausedAt: at, windowStartedAt: null, stoppedAt: null }
  };
}

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
 *
 * BUG-003 — extends with `'verify-paused'`, set when a verify phase reports a
 * non-clean outcome (`PhaseSequencer`'s `pause-verify`). Naming it after the
 * task-level `'phase-paused'` the same event sets was the rejected alternative:
 * the first paragraph above makes the two vocabularies disjoint on purpose, and
 * `workflow-run-migrator.test.ts` pins that by feeding a task-level cause in and
 * requiring the pair be zeroed. Reusing `'breakpoint-paused'` was rejected too —
 * `derivePauseCause` maps it to the `'breakpoint'` projection, which would label
 * a verify halt as a breakpoint the operator never set.
 *
 * Purely additive on a forward-only schema: no persisted record can carry it, so
 * there is nothing to migrate and no version bump. It does have to be added to
 * `VALID_MANUAL_PAUSE_CAUSES`, or the parser drops it on reload and
 * `manualPausePairInvariant` zeroes the pair the driver just wrote.
 *
 * Unlike `'breakpoint-paused'` this cause carries no `resumeTargetPhaseId`:
 * `pause-verify` leaves `currentPhase` on the verify phase, so resume re-runs
 * the verification the operator was asked to satisfy.
 */
export type ManualPauseCause =
  | 'operator-paused'
  | 'queue-paused-mid-run'
  | 'breakpoint-paused'
  | 'verify-paused'
  /**
   * FR-R3-112 (FR-120, FR-120a, FR-121) — the run crossed its spend bound.
   *
   * A NEW CAUSE ON THE EXISTING PAUSE, not a new status. The bounds this product had were all time-
   * and count-shaped — iteration cap 10, retry cap 5, idle 5400 s, absolute 21600 s — and **nothing
   * bounded spend**. Cost was recorded (the rollup accumulates `costUsd` and validates
   * non-negativity) and no code path in controller or services read it to refuse, pause or warn, so
   * a pathological run burned budget at full speed inside every existing cap.
   *
   * IT PAUSES; IT NEVER DESTROYS. No terminal transition. An operator returning from lunch to a
   * paused run has lost time; to a failed one, possibly work. This reuses the operator-resumable
   * pause the rate-limit path already uses, so the existing resume works unchanged and no status
   * literal is introduced — which the hard rules forbid outside the pinned projection paths.
   */
  | 'spend-bound-reached';

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

/**
 * FR-R3-008 (T370) — the persisted answer to "is this Run working or hung".
 *
 * `ClaudeCliMonitor` already knew this, and only in memory: a window reload
 * dropped every `CliMonitorState` and left the record it reloaded from with
 * nothing that distinguishes a phase streaming productively for three hours
 * from one dead for three hours. Both look identical through
 * `lastTransitionAt`, which by design does not move while a phase runs.
 *
 * `lastActivityAt` is UTC ms of the most recent stdout or stderr chunk the
 * monitor observed for this Run, as of the last coalesced write — **not** as of
 * process exit. Nothing flushes at `onExit`, deliberately (see
 * `ActivityCoalescer`), so on a finished phase this stamp trails the true last
 * output by up to one coalesce interval and the counters trail the true totals.
 * Exact per-invocation totals are in the `monitor-invocation-summary` audit
 * event; this field exists to answer a liveness question, not an accounting one.
 *
 * The counters are the monitor's per-phase line counts, which `onStart` resets
 * to zero for each invocation — that reset is what bounds them. They are counts
 * only: no line content, no paths, nothing an operator or the CLI authored ever
 * reaches this field, which is what makes it safe to persist in a medium that
 * has no rotation.
 *
 * Absence means "unknown", never "zero" — a Run written before this feature has
 * no liveness field, and a projector MUST render that as unknown rather than as
 * a stale or zeroed stamp.
 */
export interface RunLiveness {
  readonly lastActivityAt: number;
  readonly stdoutLines: number;
  readonly stderrLines: number;
}

/**
 * FR-R3-008 (T372) — the frozen denominator for progress, sibling to the
 * pipeline snapshot and frozen for the same reason.
 *
 * `currentPhase` and `phasesCompleted` give a numerator; before this feature
 * there was no stable denominator to divide it by. The plan's phase list is
 * fixed by the snapshot, but the number of *invocations* it implies was not:
 * a `loopable` phase repeats up to the live `schegent.loop.maxIterations`
 * setting, so an operator changing that setting mid-run silently moved the
 * denominator under a run already in flight. `iterationCap` is therefore
 * captured at creation and read from here forever after — never re-read from
 * settings, not even when this record is recomputed.
 *
 * `phaseCount` counts the plan's **distinct** phase ids minus the ones this Run
 * has overridden (`skipped` / `disabled` / `removed`) — distinct, because a plan
 * may list one phase twice and both positions record completions under a single
 * id. It is a *recorded* total, adjusted explicitly in the same write that
 * changes `phaseOverrides` (T378) rather than estimated on read: the driver
 * appends an overridden phase to `phasesCompleted` with `result: 'skipped'`, so
 * a denominator that excluded overrides while the numerator counted their skip
 * records would let progress exceed 100%. Both sides exclude the same set, which
 * is why the recorded total cannot go stale, and why overriding a phase that has
 * not run yet makes progress rise rather than fall. Overriding one that already
 * completed removes it from both sides — the operator took it out of the
 * process, so neither its slot nor its completion counts.
 *
 * `maxPhaseInvocations` is the upper bound on CLI invocations —
 * `Σ (phase.loopable ? iterationCap : 1)` over the non-overridden **positions**,
 * since a repeated position is genuinely a further invocation. It is a ceiling,
 * not a forecast: a loop that converges early uses fewer.
 *
 * `run-planned-total.ts` owns every one of these computations, for the factory,
 * the override write, and the projector alike.
 *
 * Absence means "legacy record" and nothing else. Every Run created after this
 * feature carries one, including a Run with no pipeline snapshot, so a
 * projector treats absence as unknown progress rather than as zero of zero.
 */
export interface RunPlannedTotal {
  readonly phaseCount: number;
  readonly iterationCap: number;
  readonly maxPhaseInvocations: number;
}

export interface WorkflowRun {
  /**
   * FR-R3-055 (H-06) — the execution-lease generation this record was last
   * written under, when the writer supplied one.
   *
   * Stamped so a reader holding a NEWER generation can tell the record came from
   * a superseded holder. That is the "fence-stamped snapshots" half of the
   * protocol: the commit-point check refuses the write it can see, and the stamp
   * lets a reader disbelieve one that slipped past.
   *
   * Optional and additive: a record written before this field deserializes
   * unchanged, so no `STATE_SCHEMA_VERSION` moves.
   */
  writtenAtFence?: number;
  /**
   * FR-R3-103 (FR-041) — the process tree this Run last spawned, or absent.
   *
   * Written under the fence at spawn and cleared when the child is reaped, so its presence
   * means a tree was running when this record was last written. Whether it is running NOW is
   * what the liveness check asks, and activation asks it before resuming a persisted
   * `running` Run — because before this field existed, activation resumed into whatever the
   * previous host had left behind and the two raced in one worktree.
   *
   * Optional and additive: a Run persisted before this field deserializes unchanged and reads
   * as `unrecorded`, which resumes exactly as it did before. So no `STATE_SCHEMA_VERSION`
   * moves and no migrator is owed.
   */
  spawnIdentity?: SpawnIdentity;
  id: string;
  featureId: string;
  featureDir: string;
  status: WorkflowRunStatus;
  currentPhase: Phase;
  currentIteration: number;
  startedAt: number;
  /**
   * UTC ms of the last *status* transition, and nothing else.
   *
   * FR-R3-008 (T371) — this is not a heartbeat and MUST NOT become one. Every
   * existing reader measures "how long has this Run been in its current state":
   * the lifecycle auditor's phase and run durations, the staleness reclaim, the
   * projections that render time-in-status. Moving it on stdout activity would
   * change what all of them measure, silently — a long phase would report a
   * short duration because its own output kept resetting the clock, and a hung
   * phase would be the only one whose duration stayed honest.
   *
   * Liveness has its own field, `liveness.lastActivityAt`, precisely so the two
   * questions stay separable: this one is answered by transitions, that one by
   * output. A reader that wants "working or hung" reads that field; a reader
   * that wants "how long in this state" reads this one.
   */
  lastTransitionAt: number;
  /**
   * FR-R3-008 (T370) — most recent CLI output observed for this Run, coalesced.
   * Absent on legacy records and on a Run that has not produced output yet;
   * absence is unknown, not zero. See `RunLiveness`.
   */
  liveness?: RunLiveness;
  phasesCompleted: PhaseResult[];
  /**
   * FR-R3-157 — every phase this run carried past its retry cap under
   * `onRetryCap: 'continue-degraded'`, in the order they happened.
   *
   * **Absence means NOT degraded**, and that is the opposite of the convention
   * `plannedTotal` and `liveness` above follow, where absence means unknown. It
   * has to be: a degraded run is one that recorded something, so a run with no
   * record is a run that degraded nowhere. Reading absence as "unknown" would
   * make every legacy record and every clean run alike look suspicious, which is
   * exactly the indistinguishability FR-006 forbids — in the other direction.
   *
   * No migration is needed and none is written. The field is optional and
   * additive: a record persisted before this feature reads back byte-identical,
   * and the reader's answer for it (`not degraded`) is the true one.
   */
  degradedPhases?: readonly DegradedPhaseEntry[];
  lastError: SanitizedError | null;
  /**
   * FR-R4-F14 (spec 242, D5) — why this Run failed, one code from the closed vocabulary in
   * `contracts/failure-cause.ts`. Present only while `status === 'failed'`, and set in the write
   * that makes the Run `failed`, so the terminal audit event and the metrics rollup read it from
   * the Run (a crash replay reads the journalled Run and records the same code).
   *
   * **Absent means "not recorded"**, for a Run that failed before this feature as for any other. It
   * is optional and additive, as `degradedPhases` is: no migration, no `STATE_SCHEMA_VERSION` bump,
   * and a record persisted before this feature reads back byte-identical.
   *
   * What keeps it one-sided-free: `validateRunInvariants` refuses it beside any other status, and
   * `tests/lint/failure-cause-clear-census.test.ts` makes every writer that leaves `failed` name it.
   * A writer that leaves `failed` writes `failureCause: undefined`, which `updateRun` reads as
   * "remove the key".
   */
  failureCause?: FailureCause;
  /** Frozen at run creation; legacy records migrate to `always`. */
  rawTranscriptMode?: RawTranscriptMode;
  /** Frozen projection of phases that can mutate Git state. */
  mutationPlan?: MutationPlanSnapshot;
  /** Present only after an operator approved the matching frozen plan. */
  gitApprovalReceipt?: GitApprovalReceipt;
  pipeline?: WorkflowRunPipeline;
  /**
   * FR-R3-008 (T372) — the frozen progress denominator, captured at creation
   * beside the pipeline snapshot above and adjusted only by an override write.
   * Absent on legacy records; absence is unknown progress. See `RunPlannedTotal`.
   */
  plannedTotal?: RunPlannedTotal;
  /**
   * Effective global backend captured when the run is created. Phases in new
   * snapshots also persist their effective runner, but this run-level value is
   * the stable fallback for partially migrated snapshots. Missing on records
   * created before runner pinning; those conservatively fall back to Claude.
   */
  defaultRunnerKind?: import('../contracts/backend-kinds').BackendRunnerKind;
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
   * FR-R4-F02 (spec 240, data-model §3) — non-null iff the Run is paused for credits. The
   * invariant `validateRunInvariants` enforces: `creditPause` set requires `status === 'paused'`,
   * no pending retry pair and no manual-pause pair. Written `null` on every new Run and by the v15
   * ladder step on every Run that lacked the key.
   *
   * OPTIONAL ON THE TYPE, NULL IN THE DATA. Absent reads as `null` everywhere (`creditPauseOf()`),
   * and every writer stores an explicit `null`, so the persisted shape is the one the data model
   * names. The type is optional only because a required key would have broken some fifty test
   * fixtures that build a whole `WorkflowRun` for reasons unrelated to credits, and the additive
   * convention (`lastCliSessionId?`, `runInputs?`) is how this file already carries a field a
   * record written before it cannot have.
   */
  readonly creditPause?: CreditPause | null;
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
  lastCliSessionRunnerKind?: import('../contracts/backend-kinds').BackendRunnerKind;
  /**
   * FR-R3-209 — the cumulative `total_cost_usd` the claude runner last recorded for the session
   * `lastCliSessionId` names. A host restart empties the runner's own ledger, and this is what
   * lets the first resume afterwards record only its own cost.
   *
   * Written, cleared and carried with the id (`NO_CLI_SESSION`, `cliSessionOf`), optional and
   * additive like the id so it needs no migration, and never logged. `| undefined` is
   * deliberate: the driver writes an invocation's figure, absent included, beside the id it
   * reports.
   */
  lastCliSessionCostUsd?: number | undefined;
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
   * FR-R3-001 (T259) — the accepted request, whole, as the execution path reads
   * it. Present only on a composed Run; a Run started from any other path
   * carries none and takes the legacy path byte for byte (T267).
   *
   * This is the Run's copy of what `validateRunRequest()` froze, and it is what
   * the prompt builder and the output probe read. Carrying the whole envelope
   * rather than the two or three fields today's consumers happen to want is the
   * point of the feature: the next field added to the envelope reaches the
   * backend without an edit here.
   *
   * `envelope.pipeline` and `pipeline` above are the same snapshot and serialize
   * twice. That is the accepted cost of consuming the envelope by reference —
   * storing a de-duplicated projection instead would put a second, partial copy
   * of the contract in the record, which is the shape this feature removed.
   */
  envelope?: ExecutionEnvelope;
  /**
   * Feature 087 (T035, US4) — the bindings this Run executed with, frozen at
   * submission. Present only on a composed Run; a Run started from any other
   * path carries none.
   *
   * The Pipeline snapshot above already pins *what* runs. This pins *what it
   * was given*, which is the other half of reproducing the Run: the same
   * definition with different inputs is a different execution.
   *
   * Superseded by `envelope.inputs` as of FR-R3-001 and retained as a legacy
   * projection: records written before that feature carry this and no envelope,
   * and dropping the field would make them unreadable rather than merely older.
   * Nothing under `src/` reads it — new consumers read the envelope.
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

/** FR-R3-209 — the three session fields cleared together, for a Run that stops owning a session. */
export const NO_CLI_SESSION = Object.freeze({
  lastCliSessionId: undefined,
  lastCliSessionRunnerKind: undefined,
  lastCliSessionCostUsd: undefined
});

/** FR-R3-209 — the three session fields of a Run, carried together onto another record. */
export function cliSessionOf(run: WorkflowRun): {
  readonly lastCliSessionId: string | null | undefined;
  readonly lastCliSessionRunnerKind:
    | import('../contracts/backend-kinds').BackendRunnerKind
    | undefined;
  readonly lastCliSessionCostUsd: number | undefined;
} {
  return {
    lastCliSessionId: run.lastCliSessionId,
    lastCliSessionRunnerKind: run.lastCliSessionRunnerKind,
    lastCliSessionCostUsd: run.lastCliSessionCostUsd
  };
}

export interface RunPhaseStats {
  readonly phasesTotal: number;
  readonly phasesCompleted: number;
  readonly phasesSkipped: number;
}

/**
 * The phase counters a terminal Run reports, on the same reasoning as
 * `TERMINAL_RUN_STATUSES` above: one rule about one shape, read from the shape's
 * own module rather than copied.
 *
 * FR-R3-009 needs the identical three numbers the `task-execution-ended` audit
 * payload carries, because the durable rollup and the audit fold are unioned and
 * deduplicated by run id — a run counted through one path must produce the same
 * figures as the same run counted through the other, or a cumulative total would
 * depend on which range the run happened to fall in. A second implementation
 * that merely agreed today is exactly how that drifts.
 */
export function computeRunPhaseStats(run: WorkflowRun): RunPhaseStats {
  return {
    phasesTotal: run.pipeline?.phases?.length ?? 0,
    phasesCompleted: run.phasesCompleted.filter((p) => p.result === 'clean').length,
    phasesSkipped: run.phasesCompleted.filter((p) => p.result === 'skipped').length
  };
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
  /**
   * FR-R4-F02 (data-model §4) — what the last credit poll could say: `not-recovered` for an
   * exit-zero poll whose text was negative or ambiguous, `unreachable` for a poll that threw, timed
   * out, was killed or exited nonzero. `null` before any poll. Written by `CreditWatchdog` only.
   * Optional on the type for the reason `WorkflowRun.creditPause` is: the v15 step writes `null`
   * on an existing record and `getWatchdog()`'s fallback carries it, absent reads as `null`.
   */
  lastPollOutcome?: 'not-recovered' | 'unreachable' | null;
  cause: string | null;
}

/**
 * FR-R3-055 (H-06) — is this record the work of a superseded holder?
 *
 * The read-time half of the protocol. The commit-point check in `setRun` refuses
 * a write it can see; this lets a reader disbelieve one that slipped past —
 * written by a holder whose lease had already moved on, in the window the check
 * cannot cover because `Memento` has no conditional write.
 *
 * An unstamped record answers **false**. That is deliberate: records written
 * before this field existed, and every write made without a claim, carry no
 * generation to compare, and treating "no stamp" as "superseded" would reject
 * the entire existing corpus. The stamp is evidence when present, not an absence
 * to be read as guilt.
 */
export function isSupersededRun(run: WorkflowRun, liveFence: number): boolean {
  return run.writtenAtFence !== undefined && run.writtenAtFence < liveFence;
}
