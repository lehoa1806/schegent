import type { PhaseRunInputs, PhaseRunOutput, PhaseRunner } from '../controller/phase-runner';
import { composePhaseMessagePath } from '../controller/phase-runner';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { QueueManager } from '../queue/queue-manager';
import type { SchegentStatusBar } from '../ui/status-bar';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceLockManager } from '../state/lock';
import type { IsContinueGate } from '../controller/is-continue-gate';
import { PhaseSequencer, nextOverridesAfterSkip } from '../controller/phase-sequencer';
import {
  computeRunPhaseStats,
  type PhaseResult,
  type RunPhaseStats,
  type SanitizedError,
  type WorkflowRun
} from '../state/workflow-run';
import type { ClaudeCliMonitor } from '../monitor/claude-cli-monitor';
import type { PhaseName } from '../ui/sidebar/snapshot';
import type { HistoryRecorder } from './history-recorder';
import type { RetryCoordinator } from './retry-coordinator';
import type { PhaseDef } from '../config/pipeline-config';
import { RequiredEvidenceUnavailableError } from '../lib/errors';
import { effectiveRunnerKindForPhase } from '../config/pipeline-snapshot';
import {
  DEFAULT_BACKEND,
  type BackendRunnerKind
} from '../runner/backend-runner-factory';
import { resolveSessionDispatch } from './session-dispatch-policy';
import type { BackendAvailabilityProbe } from './backend-capability-service';
import type { OptionalPhaseFailureContinuedPayload } from '../contracts/audit-events';
import type { TerminalTransitionCoordinator } from './terminal-transition-coordinator';
import { mutationPlanIsApproved } from './mutation-plan';
import type { RunCheckpointService } from './run-checkpoint-service';
import type { PhaseMutationReport, RunMutationLedger } from './run-mutation-ledger';
import type { RunOutputRecord } from '../contracts/run-results';
import { resolveRunOutputs } from './run-output/run-output-resolver';
import { createBoundedOutputProbe } from './run-output/run-output-probe';

/**
 * FR-R3-004 — a phase's own account of what it wrote, taken from the audit
 * record the invocation produced, or `null` when there is no such account.
 *
 * `null` and an empty list are different answers and both are load-bearing. An
 * empty list is a phase that ran and reported writing nothing, which is usable
 * evidence; `null` is a phase that produced no parsed audit entry at all — it
 * threw, was cancelled, or its output was malformed — and what it wrote is
 * unknown. The ledger turns the second into incomplete evidence, so the next
 * checkpoint declines instead of writing a patch that may be missing a file.
 *
 * The paths themselves are untrusted: they come from CLI stdout, which is
 * operator-influenced. Nothing here opens them; the ledger canonicalises them
 * lexically and matches them against sections git itself printed.
 */
function declaredMutations(output: PhaseRunOutput | null): PhaseMutationReport | null {
  const audit = output?.result.auditEntry;
  if (audit === null || audit === undefined) return null;
  return {
    declaredPaths: [...audit.filesCreated, ...audit.filesModified, ...audit.filesDeleted]
  };
}

interface RunDriverOptions {
  readonly cliPath: string;
  readonly cwd: string;
  readonly iterationCap: number;
  readonly timeoutMs: number;
  /** FR-R3-075 — absolute per-invocation wall-clock bound (no per-phase form). */
  readonly maxDurationMs?: number;
  readonly inheritProcessEnv?: boolean;
  readonly processEnvAllowlist?: readonly string[];
  // Feature 074 — resolve the CLI binary path for a given runner kind.
  // When undefined, falls back to `cliPath` for all runners.
  readonly cliPathResolver?: (runnerKind: string) => string;
  /** Effective global backend for phases without an explicit override. */
  readonly defaultRunnerKind?: BackendRunnerKind;
  readonly skipProbing?: boolean;
  readonly isAuditEvidenceAvailable?: () => boolean;
  /**
   * Dynamic reader for `schegent.retry.forceContinueOnCap`. A reader rather
   * than a value on purpose: the driver outlives a phase, and caching an
   * operator setting on a long-lived runner object is the defect this
   * codebase already bans for `logging.verbose` and the fatal-signature
   * additions. Absent reader means the pre-existing halt.
   */
  readonly getForceContinueOnRetryCap?: () => boolean;
}

type PhaseControlEventType =
  | 'phase-paused'
  | 'phase-skipped'
  | 'phase-disabled'
  | 'phase-removed';

export interface RunDriverDeps {
  readonly runner: PhaseRunner;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly statusBar: SchegentStatusBar;
  readonly notifier: Notifier;
  readonly logger: SanitizedLogger;
  /**
   * Feature 092 (T136, FR-032a) — no longer read by `drive()`. The `drive-run`
   * `withLock` wrapper was this dep's only consumer; window primacy is now held
   * activation-to-disposal by `extension.ts` and is not the driver's to take or
   * release. Kept on the interface so the many construction sites are untouched
   * by the bugfix; a driver that needs lock business again should justify it
   * against FR-032a first.
   */
  readonly lock: WorkspaceLockManager;
  readonly options: RunDriverOptions;
  readonly backendCapabilities?: BackendAvailabilityProbe;
  readonly monitor: Pick<ClaudeCliMonitor, 'onStart'> | null;
  readonly historyRecorder: HistoryRecorder;
  readonly retryCoordinator: RetryCoordinator;
  readonly isContinueGate: IsContinueGate;
  readonly persistTransition: (prev: WorkflowRun, next: WorkflowRun) => Promise<WorkflowRun>;
  readonly appendPhaseControlAudit: (
    eventType: PhaseControlEventType,
    run: WorkflowRun,
    payload: Record<string, unknown>
  ) => Promise<void>;
  readonly appendBreakpointAudit: (
    eventType: 'phase-breakpoint-cleared',
    run: WorkflowRun,
    payload: Record<string, unknown>
  ) => Promise<void>;
  readonly appendRunnerProbeFailedAudit: (
    run: WorkflowRun,
    payload: Record<string, unknown>
  ) => Promise<void>;
  readonly emitRunEndedBreakpointAudit: (run: WorkflowRun) => Promise<void>;
  readonly emitTaskLifecycleAudit: (
    eventType: 'task-execution-started' | 'task-execution-ended' | 'task-execution-paused',
    run: WorkflowRun,
    payload: Record<string, unknown>
  ) => Promise<void>;
  readonly emitOptionalPhaseFailureContinued: (
    run: WorkflowRun,
    payload: OptionalPhaseFailureContinuedPayload
  ) => Promise<void>;
  readonly scheduleAutoDrain: () => void;
  /**
   * Feature 092 (T132, FR-033a) — returns the finished Run's queue execution
   * lease. Optional so the unit harnesses that build a driver directly keep
   * working; the controller always supplies it.
   */
  readonly releaseExecutionLease?: (run: WorkflowRun) => Promise<void>;
  readonly onRunTerminal?: (run: WorkflowRun) => Promise<void>;
  readonly terminalTransitions?: Pick<TerminalTransitionCoordinator, 'complete'>;
  readonly checkpoints?: Pick<RunCheckpointService, 'checkpoint'>;
  /**
   * FR-R3-004 — brackets every phase dispatch so a checkpoint taken under
   * concurrency knows which Run wrote which file. Optional on the same terms as
   * `checkpoints`: the unit harnesses build a driver directly, and a driver
   * without a ledger simply produces no attribution evidence, which the
   * checkpoint service reads as grounds to decline rather than to guess.
   */
  readonly mutationLedger?: Pick<RunMutationLedger, 'observeBeforePhase' | 'observeAfterPhase'>;
}

/**
 * Feature 013 T096 - owns the phase driving loop formerly embedded in
 * WorkflowController. The controller remains the public command surface;
 * RunDriver owns run-loop state, cancellation, and phase advancement
 * orchestration. It no longer owns lock retention — feature 092 (T136,
 * FR-032a) removed the `drive-run` wrapper, so a Run's lifetime and window
 * primacy's lifetime are independent.
 */
export class RunDriver {
  private cancellationController: AbortController | null = null;
  private isRunning = false;
  private carriedIssues: Array<{ tag?: string; summary: string }> | string[] = [];
  private readonly overriddenActivePhaseAborts = new Set<string>();
  private readonly sequencer = new PhaseSequencer();

  constructor(private readonly deps: RunDriverDeps) {}

  public get running(): boolean {
    return this.isRunning;
  }

  public cancelActive(): void {
    this.cancellationController?.abort();
  }

  public noteActivePhaseOverrideAbort(runId: string, phaseId: string): void {
    this.overriddenActivePhaseAborts.add(this.phaseOverrideAbortKey(runId, phaseId));
  }

  /**
   * Feature 074 — resolve the CLI binary path for a given runner kind.
   * When no per-runner resolver is configured, falls back to the global
   * `cliPath` (backwards compatible with single-runner mode).
   */
  private resolveRunnerKind(
    phaseDef: PhaseDef | undefined,
    runDefaultRunnerKind: BackendRunnerKind | undefined
  ): BackendRunnerKind {
    // New runs always persist an effective runner on every phase. The run-level
    // fallback is therefore limited to partially migrated snapshots. The
    // controller pins a configured default when it first migrates a truly
    // legacy run, so subsequent dispatches are stable across setting changes.
    return effectiveRunnerKindForPhase(phaseDef, runDefaultRunnerKind);
  }

  private resolveCliPath(runnerKind?: BackendRunnerKind): string {
    const effectiveKind = runnerKind
      ?? this.deps.options.defaultRunnerKind
      ?? DEFAULT_BACKEND;
    if (this.deps.options.cliPathResolver) {
      return this.deps.options.cliPathResolver(effectiveKind);
    }
    return this.deps.options.cliPath;
  }

  /**
   * Feature 093 (T039) — pattern C-2. The latest persisted snapshot **of the
   * Run this driver is advancing**, or `null` if that Run is no longer the one
   * on its queue.
   *
   * The three reads this replaces asked the store "what is running?" and took
   * whatever occupied the single slot. Every one of them feeds its answer
   * straight back into this Run's next write, so under N Runs the ambient form
   * would have merged a sibling's phase, iteration, and completed-phase list
   * into this Run's record — a corruption with no error attached to it.
   *
   * Addressing by the Run's own Task is the same answer the queue would give
   * and needs nothing threaded in; T041 hands the session its queue at
   * construction and the resolution moves there. The identity check lives here
   * rather than at the three call sites so there is one place that decides what
   * "still mine" means: `deleteTask` can cancel this Run and let the drain start
   * a successor on the same queue while this driver is mid-flight, and the
   * successor is not a newer snapshot of this Run.
   */
  private latestSnapshotOf(run: WorkflowRun): WorkflowRun | null {
    const found = this.deps.store.findRunByTask(run.featureId);
    return found !== null && found.run.id === run.id ? found.run : null;
  }

  /**
   * FR-R3-004 — dispatch one phase inside this Run's attribution window.
   *
   * Every phase is bracketed, not just the Git-capable ones: `PhaseSideEffects`
   * marks most built-in phases `workspace`, and those mutate the tree too, so
   * observing only at the checkpoint seam would leave their writes undeclared and
   * force a decline for every sibling.
   *
   * The window closes in a `finally`, so a phase that threw or was cancelled
   * still closes its own — carrying `null`, because a phase that did not finish
   * produced no audit record and what it wrote is therefore unknown. An unclosed
   * window is a hole in the record, and a hole is indistinguishable from a
   * sibling's write.
   */
  private async dispatchObserved(
    run: WorkflowRun,
    inputs: PhaseRunInputs
  ): Promise<PhaseRunOutput> {
    await this.deps.mutationLedger?.observeBeforePhase(run);
    let output: PhaseRunOutput | null = null;
    try {
      output = await this.deps.runner.run(inputs);
      return output;
    } finally {
      await this.deps.mutationLedger?.observeAfterPhase(run, declaredMutations(output));
    }
  }

  public async drive(initial: WorkflowRun, description: string): Promise<void> {
    if (this.isRunning) {
      this.deps.logger.warn('controller already running; ignoring duplicate driveRun');
      return;
    }
    this.isRunning = true;
    this.cancellationController = new AbortController();
    let run = initial;
    let previousPhaseMessage: Readonly<Record<string, string>> | null = null;
    let pendingIsContinue = this.deps.isContinueGate.consume();
    // Session reuse: after the first invocation returns a session ID,
    // all subsequent invocations in this drive cycle resume it for
    // cost optimization (prompt cache preservation). Distinct from
    // isContinue (which is for interrupted conversation resumption).
    let pendingSessionReuse = false;
    let allowAutoDrain = true;

    try {
      // Feature 092 (T136, BUG-002, FR-032a) — the `withLock('drive-run', …)`
      // wrapper that used to enclose this body is gone. Window primacy is
      // acquired at activation and released at disposal; it was never a single
      // Run's to end, and `withLock` keeps no reference count, so with two Runs
      // in one window the first to finish released primacy for both. `drive()`
      // now holds only its queue's execution lease.
      this.assertAuditEvidenceAvailable();
      // Feature 074 T017 — Probe all distinct runners referenced in the pipeline at start
      if (
        process.env.NODE_ENV !== 'test' &&
        !this.deps.options.skipProbing &&
        run.phasesCompleted.length === 0 &&
        run.currentIteration === 0 &&
        run.pipeline
      ) {
        const runners = new Set(
          run.pipeline.phases.map((phase) =>
            this.resolveRunnerKind(phase, run.defaultRunnerKind)
          )
        );
        for (const runnerKind of runners) {
          try {
            const available = this.deps.backendCapabilities
              ? await this.deps.backendCapabilities.probeAvailability(runnerKind)
              : false;
            if (!available) throw new Error('backend unavailable');
          } catch {
            const failureMessage =
              `Runner probe failed for ${runnerKind}: CLI executable is unavailable or invalid.`;
            this.deps.logger.error(`run-driver: ${failureMessage}`);
            const sanitized: SanitizedError = {
              code: 'runner-probe-failed',
              message: failureMessage,
              phase: run.currentPhase,
              iteration: run.currentIteration,
              at: Date.now()
            };
            run = await this.deps.persistTransition(run, {
              ...run,
              status: 'failed',
              lastError: sanitized,
              lastTransitionAt: Date.now()
            });

            if (this.deps.appendRunnerProbeFailedAudit) {
              await this.deps.appendRunnerProbeFailedAudit(run, {
                runnerKind,
                errorMessage: failureMessage,
                runId: run.id
              });
            }
            this.deps.statusBar.update(run.id, {
              kind: 'failed',
              phase: run.currentPhase,
              detail: failureMessage
            });
            this.deps.notifier.warn(`Schegent: ${failureMessage}`);
            try {
              await this.deps.queue.finish(run.featureId, 'failed', {
                code: sanitized.code,
                message: sanitized.message,
                phase: sanitized.phase ?? undefined,
                correlationId: run.id
              });
            } catch (queueError) {
              this.deps.logger.warn(
                `run-driver: queue.finish (probe failed) failed: ${(queueError as Error).message}`
              );
            }
            // Feature 072 — emit task-execution-ended
            try {
              if (this.deps.emitTaskLifecycleAudit) {
                await this.deps.emitTaskLifecycleAudit('task-execution-ended', run, {
                  taskId: run.featureId,
                  runId: run.id,
                  terminalStatus: 'failed',
                  phasesCompleted: 0,
                  phasesSkipped: 0,
                  phasesTotal: run.pipeline?.phases.length || 0,
                  lastErrorSummary: failureMessage
                });
              }
            } catch (auditErr) {
              this.deps.logger.warn(`run-driver: task-execution-ended (failed) audit failed: ${(auditErr as Error).message}`);
            }
              
            await this.deps.emitRunEndedBreakpointAudit(run);
            await this.deps.historyRecorder.record(run, description, 'failed');
            return; // abandon the phase loop; this run is terminal
          }
        }
      }

      while (run.currentPhase !== 'done' && run.status === 'running') {
        this.assertAuditEvidenceAvailable();
        if (this.cancellationController!.signal.aborted) {
          run = await this.deps.persistTransition(run, { ...run, status: 'canceled' });
          await this.deps.emitRunEndedBreakpointAudit(run);
          await this.deps.historyRecorder.record(run, description, 'canceled');
          break;
        }

        const preDecision = this.sequencer.decideBeforePhase({
          run,
          iterationCap: this.deps.options.iterationCap,
          now: Date.now()
        });
        if (preDecision.kind === 'skip-phase') {
          const { override: phaseOverride, skippedResult, transition: decision } = preDecision;
          const nextPhaseDef = decision.kind === 'advance'
            ? run.pipeline?.phases.find((phase) => phase.id === decision.nextPhase)
            : undefined;
          const nextRunnerKind = nextPhaseDef
            ? this.resolveRunnerKind(nextPhaseDef, run.defaultRunnerKind)
            : undefined;
          const sessionOwnerMatchesTarget =
            nextRunnerKind !== undefined &&
            run.lastCliSessionRunnerKind === nextRunnerKind;
          if (!sessionOwnerMatchesTarget) pendingSessionReuse = false;
          const advanced: WorkflowRun = {
            ...run,
            phaseOverrides: nextOverridesAfterSkip(run, phaseOverride),
            currentPhase: decision.kind === 'advance' ? decision.nextPhase : run.currentPhase,
            currentIteration:
              decision.kind === 'advance' ? decision.nextIteration : run.currentIteration,
            lastTransitionAt: Date.now(),
            phasesCompleted: [...run.phasesCompleted, skippedResult],
            ...(sessionOwnerMatchesTarget
              ? {}
              : {
                  lastCliSessionId: undefined,
                  lastCliSessionRunnerKind: undefined
                })
          };
          run = await this.deps.persistTransition(run, advanced);
          previousPhaseMessage = null;
          await this.deps.appendPhaseControlAudit(
            phaseOverride.action === 'disabled'
              ? 'phase-disabled'
              : phaseOverride.action === 'removed'
                ? 'phase-removed'
                : 'phase-skipped',
            run,
            {
              runId: run.id,
              phaseId: skippedResult.phase,
              disabledByOverride: phaseOverride.action === 'disabled',
              removedByOverride: phaseOverride.action === 'removed'
            }
          );
          continue;
        }

        const iteration = preDecision.iteration;
        this.deps.statusBar.update(run.id, {
          kind: 'running',
          phase: run.currentPhase,
          iteration,
          iterationCap: this.deps.options.iterationCap
        });

        const phaseStartedAt = Date.now();
        if (this.deps.monitor) {
          try {
            this.deps.monitor.onStart(run.id, run.currentPhase as PhaseName, null);
          } catch {
            // monitor errors must not propagate
          }
        }
        const activePhaseDef = preDecision.activePhaseDef;
        const effectiveRunnerKind = this.resolveRunnerKind(
          activePhaseDef,
          run.defaultRunnerKind
        );
        // A partially migrated pipeline can lack phase.runner even though
        // the run already has a pinned default. PhaseRunner owns adapter
        // selection and audit attribution, so pass it the same effective
        // runner used for CLI-path/session selection. This is an immutable
        // dispatch view; the persisted pipeline snapshot remains untouched.
        const dispatchPhaseDef =
          activePhaseDef && activePhaseDef.runner === undefined
            ? Object.freeze({ ...activePhaseDef, runner: effectiveRunnerKind })
            : activePhaseDef;
        if (
          (dispatchPhaseDef?.sideEffects === 'git' ||
            dispatchPhaseDef?.sideEffects === 'unrestricted') &&
          (!run.mutationPlan ||
            !mutationPlanIsApproved(run.mutationPlan, run.gitApprovalReceipt) ||
            !run.mutationPlan.gitCapablePhaseIds.includes(dispatchPhaseDef.id))
        ) {
          throw new Error('git-mutation-plan-not-approved');
        }
        if (
          dispatchPhaseDef?.sideEffects === 'git' ||
          dispatchPhaseDef?.sideEffects === 'unrestricted'
        ) {
          await this.deps.checkpoints?.checkpoint(run, dispatchPhaseDef.id);
        }
        const requestedContinue = pendingIsContinue;
        pendingIsContinue = false;
        const sessionDispatch = resolveSessionDispatch({
          requestedContinue,
          pendingSessionReuse,
          resumePrompt: run.resumePrompt,
          persistedSessionId: run.lastCliSessionId,
          persistedSessionRunnerKind: run.lastCliSessionRunnerKind,
          effectiveRunnerKind
        });
        if (run.resumePrompt !== undefined) {
          const nextRun = { ...run };
          delete nextRun.resumePrompt;
          run = await this.deps.persistTransition(run, nextRun);
        }

        // Feature 098 (T045, FR-034) — both reads below were
        // `run.pipeline?.id ?? BUILT_IN_PIPELINE_ID`. Resolved once so the
        // attribution the runner records and the directory the sidecar is
        // written to cannot disagree about which Pipeline this is.
        const dispatchPipelineId = run.pipeline?.id;
        const output = await this.dispatchObserved(run, {
          phase: run.currentPhase,
          phaseDef: dispatchPhaseDef,
          pipelineId: dispatchPipelineId,
          iteration,
          iterationCap: this.deps.options.iterationCap,
          featureDescription: description,
          featureDir: run.featureDir || null,
          carriedIssues: this.carriedIssues,
          // Feature 074 — resolve CLI path per-runner-kind. When a phase
          // specifies a runner, use the cliPathResolver to pick the
          // correct binary; otherwise fall back to the global cliPath.
          cliPath: this.resolveCliPath(effectiveRunnerKind),
          cwd: this.deps.options.cwd,
          timeoutMs: activePhaseDef?.timeoutSeconds
            ? activePhaseDef.timeoutSeconds * 1000
            : this.deps.options.timeoutMs,
          // FR-R3-075 — deliberately NOT per-phase: the deadline bounds the
          // invocation as a whole and a Phase definition cannot loosen it.
          maxDurationMs: this.deps.options.maxDurationMs,
          inheritProcessEnv: this.deps.options.inheritProcessEnv !== false,
          processEnvAllowlist: this.deps.options.processEnvAllowlist,
          runId: run.id,
          rawTranscriptMode: run.rawTranscriptMode,
          // A path segment cannot be omitted, so with no Pipeline id there is
          // no canonical sidecar path — not one under an invented directory.
          phaseMessagePath:
            dispatchPipelineId === undefined
              ? null
              : composePhaseMessagePath({
                  cwd: this.deps.options.cwd,
                  runId: run.id,
                  pipelineId: dispatchPipelineId,
                  phaseId: run.currentPhase,
                  iteration
                }),
          previousPhaseMessage,
          cancellationSignal: this.cancellationController!.signal as unknown as {
            aborted: boolean;
            addEventListener(event: 'abort', cb: () => void): void;
          },
          isContinue: sessionDispatch.isContinue,
          sessionReuse: sessionDispatch.sessionReuse,
          resumeSessionId: sessionDispatch.resumeSessionId,
          resumePrompt: sessionDispatch.resumePrompt,
          // FR-R3-001 (T260) — forwarded whole, on every phase of the Run, so
          // the request the operator approved is the request each phase is asked
          // to carry out. Read from the Run rather than re-read from the queue
          // row: the row can be edited or removed mid-Run, and the envelope
          // cannot.
          envelope: run.envelope
        });
        if (
          this.overriddenActivePhaseAborts.delete(
            this.phaseOverrideAbortKey(run.id, run.currentPhase)
          )
        ) {
          const latestRun = this.latestSnapshotOf(run);
          if (latestRun !== null) {
            run = latestRun;
          }
          this.cancellationController = new AbortController();
          continue;
        }

        // Capture the backend-owned session before any pause/breakpoint
        // branch persists and exits. A completed invocation can disclose
        // its exact session ID even when the controller immediately pauses;
        // that ID is what makes a later resume safe and deterministic.
        if (output.cliSessionId !== undefined) {
          run = {
            ...run,
            lastCliSessionId: output.cliSessionId,
            lastCliSessionRunnerKind: effectiveRunnerKind
          };
          pendingSessionReuse = true;
        }

        const postDecision = this.sequencer.decideAfterPhase({
          run,
          output,
          iteration,
          iterationCap: this.deps.options.iterationCap,
          activePhaseDef,
          latestManualPauseAt: this.latestSnapshotOf(run)?.manualPauseAt ?? null,
          now: Date.now(),
          forceContinueOnRetryCapDefault:
            this.deps.options.getForceContinueOnRetryCap?.() ?? false
        });
        for (const w of postDecision.warnings) {
          this.deps.logger.warn(w);
        }

        if (postDecision.kind === 'pause-breakpoint') {
          const consumedPhaseId = postDecision.consumedPhaseId;
          const now = Date.now();
          const paused: WorkflowRun = {
            ...run,
            status: 'paused',
            currentIteration: iteration,
            manualPauseAt: now,
            manualPauseCause: 'breakpoint-paused',
            resumeTargetPhaseId: consumedPhaseId,
            phaseBreakpoints: run.phaseBreakpoints.filter(
              (bp) => bp.phaseId !== consumedPhaseId
            ),
            lastTransitionAt: now
          };
          run = await this.deps.persistTransition(run, paused);
          await this.deps.appendBreakpointAudit('phase-breakpoint-cleared', run, {
            runId: run.id,
            phaseId: consumedPhaseId,
            cause: 'consumed-by-fire'
          });
          this.deps.statusBar.update(run.id, { kind: 'paused', phase: run.currentPhase });
          const feature = this.deps.queue.findById(run.featureId);
          const queueId = feature?.queueId ?? null;
          if (queueId) {
            await this.deps.queue.cascadedPause(queueId);
          }
          // Pause-style exit (T136): a fired phase breakpoint. A later resume
          // entry point continues this Run. The `session.retain()` that used to
          // stand here suppressed the `drive-run` wrapper's auto-release of
          // window primacy; with no wrapper there is nothing to retain, and
          // primacy was never this Run's to hold or hand on.
          break;
        }

        previousPhaseMessage =
          output.phaseMessage && output.phaseMessage.entryCount > 0
            ? output.phaseMessage.entries
            : null;

        const phaseResult: PhaseResult = {
          ...postDecision.phaseResult,
          startedAt: phaseStartedAt
        };

        if (postDecision.kind === 'pause-delayed-retry') {
          if (
            activePhaseDef?.isRequired === false &&
            !this.sequencer.isVerificationPhase(run.currentPhase) &&
            this.deps.retryCoordinator.isRetryCapExhaustedOnNextFailure(run)
          ) {
            const terminalPhaseResult: PhaseResult = {
              ...phaseResult,
              result: 'failed',
              terminationReason:
                postDecision.cause === 'rate_limit' ? 'rate_limit' : 'error'
            };
            await this.deps.runner.appendCapExhaustedPhaseEnd({
              runId: run.id,
              phase: run.currentPhase,
              iteration,
              pipelineId: run.pipeline?.id,
              phaseDef: dispatchPhaseDef
            });
            run = await this.continueOptionalFailure(
              run,
              terminalPhaseResult,
              activePhaseDef,
              effectiveRunnerKind
            );
            continue;
          }
          run = await this.deps.retryCoordinator.handleDelayedRetry(
            run,
            iteration,
            phaseResult,
            postDecision.cause,
            postDecision.resetsAtMs,
            postDecision.rateLimitMessage,
            postDecision.originalCause
          );
          // Pause-style exit (T136): a delayed retry is armed and a scheduled
          // wake-up resumes this Run. Nothing to retain — see the breakpoint
          // exit above.
          break;
        }

        if (postDecision.kind === 'pause-rate-limit') {
          const paused: WorkflowRun = {
            ...run,
            status: 'paused',
            currentIteration: iteration,
            lastTransitionAt: Date.now(),
            phasesCompleted: [...run.phasesCompleted, phaseResult]
          };
          run = await this.deps.persistTransition(run, paused);
          this.deps.statusBar.update(run.id, { kind: 'paused', phase: run.currentPhase });
          await this.deps.retryCoordinator.handleRateLimitPause(postDecision.cause, run);
          // Pause-style exit (T136): paused on a rate limit, resumed when the
          // backoff elapses. Nothing to retain — see the breakpoint exit above.
          break;
        }

        if (postDecision.kind === 'fail') {
          if (postDecision.capExhausted) {
            await this.deps.runner.appendCapExhaustedPhaseEnd({
              runId: run.id,
              phase: run.currentPhase,
              iteration,
              pipelineId: run.pipeline?.id,
              phaseDef: dispatchPhaseDef
            });
          }
          const sanitized: SanitizedError = {
            code: 'invocation-failed',
            message: postDecision.baseMessage.slice(0, 240),
            phase: run.currentPhase,
            iteration,
            at: Date.now()
          };
          const failed: WorkflowRun = {
            ...run,
            status: 'failed',
            currentIteration: iteration,
            lastTransitionAt: Date.now(),
            phasesCompleted: [...run.phasesCompleted, phaseResult],
            lastError: sanitized
          };
          run = await this.deps.persistTransition(run, failed);
          await this.deps.emitRunEndedBreakpointAudit(run);
          this.deps.statusBar.update(run.id, {
            kind: 'failed',
            phase: run.currentPhase,
            detail: sanitized.message
          });
          this.deps.notifier.warn(
            `Schegent: ${run.currentPhase} failed — ${sanitized.message}. Run "Schegent: Resume" to retry.`
          );
          try {
            await this.deps.queue.finish(run.featureId, 'failed', {
              code: sanitized.code,
              message: sanitized.message,
              phase: sanitized.phase ?? undefined,
              correlationId: run.id
            });
          } catch (qErr) {
            this.deps.logger.warn(
              `run-driver: queue.finish (failed) failed: ${(qErr as Error).message}`
            );
          }
          try {
            await this.deps.historyRecorder.record(run, description, 'failed');
          } catch (hErr) {
            this.deps.logger.warn(
              `run-driver: history record (failed) failed: ${(hErr as Error).message}`
            );
          }
          // Feature 072 — emit task-execution-ended (failed).
          try {
            await this.deps.emitTaskLifecycleAudit('task-execution-ended', run, {
              taskId: run.featureId,
              runId: run.id,
              terminalStatus: 'failed',
              durationMs: Date.now() - run.startedAt,
              ...this.computePhaseStats(run),
              lastErrorSummary: sanitized.message
            });
          } catch (err) {
            this.deps.logger.warn(
              `run-driver: task-execution-ended (failed) audit failed: ${(err as Error).message}`
            );
          }
          break;
        }

        this.carriedIssues = pickCarriedIssues(output.result);

        if (postDecision.kind === 'pause-verify') {
          const now = Date.now();
          const paused: WorkflowRun = {
            ...run,
            status: 'paused',
            currentIteration: iteration,
            // BUG-003 — `status: 'paused'` is not what makes a Run resumable;
            // `manualPauseAt` is. `resumeActivePhase` — the webview's Resume
            // control — refuses `run-not-paused` unless one of `manualPauseAt` /
            // `pendingRetryAt` is set, so this branch used to leave the Run in a
            // status the UI renders as paused with the pair that lets it leave
            // that status unset. The command-palette `resumeExisting` path did
            // work, which is why the end-to-end test passed throughout.
            //
            // No `resumeTargetPhaseId`: that field is `'breakpoint-paused'`-only
            // by a migrator invariant, and it is not needed here — `currentPhase`
            // stays on the verify phase, so resume re-runs the verification.
            manualPauseAt: now,
            manualPauseCause: 'verify-paused',
            lastTransitionAt: now,
            phasesCompleted: [...run.phasesCompleted, phaseResult]
          };
          run = await this.deps.persistTransition(run, paused);
          await this.deps.queue.pause(run.featureId, 'phase-paused');
          await this.deps.appendPhaseControlAudit('phase-paused', run, {
            runId: run.id,
            phaseId: run.currentPhase
          });
          this.deps.statusBar.update(run.id, { kind: 'paused', phase: run.currentPhase });
          // Pause-style exit (T136): an operator or policy pause on the active
          // phase, resumed by an explicit resume. Nothing to retain — see the
          // breakpoint exit above.
          break;
        }

        if (postDecision.kind === 'break-unexpected') {
          break;
        }

        if (postDecision.kind === 'pause-manual') {
          const decision = postDecision.transition;
          // Feature 093 (T039) — was `store.getRun()!`. The assertion held only
          // because the single slot was necessarily this Run; addressed by Task,
          // a null answer means this Run is no longer the one on its queue
          // (`deleteTask` canceled it and the drain started a successor). The
          // old read would have merged the successor's phase, iteration, and
          // completed-phase list into this pause write. There is nothing left to
          // pause, so the loop exits the same way every other pause branch does.
          const latestRun = this.latestSnapshotOf(run);
          if (latestRun === null) {
            this.deps.logger.warn(
              `manual pause skipped: run ${run.id} is no longer active on its queue`
            );
            break;
          }
          const paused: WorkflowRun = {
            ...latestRun,
            // The invocation just completed after the operator's pause
            // write. Keep the session ownership captured from its output;
            // the latest persisted snapshot predates that output.
            lastCliSessionId: run.lastCliSessionId,
            lastCliSessionRunnerKind: run.lastCliSessionRunnerKind,
            status: 'paused',
            currentPhase:
              decision.kind === 'advance' ? decision.nextPhase : latestRun.currentPhase,
            currentIteration:
              decision.kind === 'advance' || decision.kind === 'loop'
                ? decision.nextIteration
                : latestRun.currentIteration,
            lastTransitionAt: Date.now(),
            phasesCompleted: [...latestRun.phasesCompleted, phaseResult]
          };
          run = await this.deps.persistTransition(latestRun, paused);
          await this.deps.queue.pause(run.featureId, 'phase-paused');
          await this.deps.appendPhaseControlAudit('phase-paused', run, {
            runId: run.id,
            phaseId: phaseResult.phase,
            nextPhaseId: run.currentPhase,
            nextIteration: run.currentIteration
          });
          this.deps.statusBar.update(run.id, { kind: 'paused', phase: phaseResult.phase });
          // Pause-style exit (T136): paused after a phase completed, with the
          // next phase and iteration already recorded for the resume. Nothing to
          // retain — see the breakpoint exit above.
          break;
        }

        run = await this.deps.retryCoordinator.maybeEmitRetryRecovered(
          run,
          output.outcome
        );

        const decision = postDecision.transition;
        const optionalTerminalContinued =
          activePhaseDef?.isRequired === false &&
          decision.kind === 'advance' &&
          (phaseResult.result === 'failed' || phaseResult.result === 'timeout');
        const nextPhaseDef = decision.kind === 'advance'
          ? run.pipeline?.phases.find((phase) => phase.id === decision.nextPhase)
          : undefined;
        const nextRunnerKind = nextPhaseDef
          ? this.resolveRunnerKind(nextPhaseDef, run.defaultRunnerKind)
          : undefined;
        const crossesRunnerBoundary =
          decision.kind === 'advance' &&
          nextRunnerKind !== undefined &&
          effectiveRunnerKind !== nextRunnerKind;
        if (crossesRunnerBoundary) pendingSessionReuse = false;
        const advanced: WorkflowRun = {
          ...run,
          currentPhase: decision.kind === 'advance' ? decision.nextPhase : run.currentPhase,
          currentIteration:
            decision.kind === 'advance' || decision.kind === 'loop'
              ? decision.nextIteration
              : run.currentIteration,
          lastTransitionAt: Date.now(),
          phasesCompleted: [...run.phasesCompleted, phaseResult],
          ...(optionalTerminalContinued
            ? {
                delayedRetryCount: 0,
                pendingRetryAt: null,
                pendingRetryCause: null
              }
            : {}),
          ...(crossesRunnerBoundary
            ? {
                lastCliSessionId: undefined,
                lastCliSessionRunnerKind: undefined
              }
            : {})
        };
        run = await this.deps.persistTransition(run, advanced);
        if (optionalTerminalContinued) {
          await this.deps.emitOptionalPhaseFailureContinued(run, {
            runId: run.id,
            // Feature 098 (T045, FR-034) — omitted, not substituted.
            ...(run.pipeline?.id === undefined ? {} : { pipelineId: run.pipeline.id }),
            phaseId: phaseResult.phase,
            runner: effectiveRunnerKind,
            iteration: phaseResult.iteration,
            terminationReason: phaseResult.terminationReason
          });
        }
      }

      if (run.currentPhase === 'done' && run.status === 'running') {
        const runOutputs = await this.recordDeclaredOutputs(run);
        const completed: WorkflowRun = {
          ...run,
          status: 'completed',
          lastTransitionAt: Date.now(),
          // Folded in *before* persistTransition, not written after it. The
          // `finally` below re-persists the outer `run` through
          // `terminalTransitions.complete`, so a later write is overwritten
          // by a value captured earlier (W7).
          ...(runOutputs.length > 0 ? { runOutputs } : {})
        };
        run = await this.deps.persistTransition(run, completed);
        await this.deps.emitRunEndedBreakpointAudit(run);
        this.deps.statusBar.update(run.id, { kind: 'completed' });
        this.deps.notifier.info(`Schegent: workflow ${run.featureId} completed.`);
        try {
          await this.deps.queue.finish(run.featureId, 'completed');
        } catch (qErr) {
          this.deps.logger.warn(
            `run-driver: queue.finish (completed) failed: ${(qErr as Error).message}`
          );
        }
        try {
          await this.deps.historyRecorder.record(run, description, 'completed');
        } catch (hErr) {
          this.deps.logger.warn(
            `run-driver: history record (completed) failed: ${(hErr as Error).message}`
          );
        }
        // Feature 072 — emit task-execution-ended (completed).
        try {
          await this.deps.emitTaskLifecycleAudit('task-execution-ended', run, {
            taskId: run.featureId,
            runId: run.id,
            terminalStatus: 'completed',
            durationMs: Date.now() - run.startedAt,
            ...this.computePhaseStats(run)
          });
        } catch (err) {
          this.deps.logger.warn(
            `run-driver: task-execution-ended (completed) audit failed: ${(err as Error).message}`
          );
        }
      }
    } catch (error) {
      const auditUnavailable =
        error instanceof RequiredEvidenceUnavailableError ||
        this.deps.options.isAuditEvidenceAvailable?.() === false;
      if (!auditUnavailable) throw error;

      allowAutoDrain = false;
      run = await this.failClosedForAuditEvidence(run, description);
    } finally {
      if (run.status !== 'running') {
        if (run.status !== 'paused') {
          await this.deps.terminalTransitions?.complete(run, description);
        }
        try {
          await this.deps.onRunTerminal?.(run);
        } catch (error) {
          this.deps.logger.warn(
            `run-driver: terminal retention hook failed: ${(error as Error).message}`
          );
        }
      }
      this.isRunning = false;
      this.cancellationController = null;
      this.carriedIssues = [];
      // Feature 092 (T132, FR-033a) — this is the ordinary terminal funnel for
      // completed, failed, and canceled Runs, so it is where the execution
      // lease's tenure ends. Unconditional on the drain gates below: a Run that
      // ends with auto-drain suppressed still has to give its queue back, or
      // the suppression outlives the reason for it.
      await this.deps.releaseExecutionLease?.(run);
      if (allowAutoDrain && this.isAuditEvidenceAvailable()) {
        this.deps.scheduleAutoDrain();
      }
    }
  }

  private assertAuditEvidenceAvailable(): void {
    if (!this.isAuditEvidenceAvailable()) {
      throw new RequiredEvidenceUnavailableError('health-gate');
    }
  }

  private async continueOptionalFailure(
    run: WorkflowRun,
    phaseResult: PhaseResult,
    phaseDef: PhaseDef,
    runner: BackendRunnerKind
  ): Promise<WorkflowRun> {
    const transition = this.sequencer.decideAfterOptionalTerminalFailure({
      run,
      phaseResult,
      phaseDef,
      iterationCap: this.deps.options.iterationCap
    });
    const nextPhaseDef = run.pipeline?.phases.find(
      (candidate) => candidate.id === transition.nextPhase
    );
    const crossesRunnerBoundary =
      nextPhaseDef !== undefined &&
      this.resolveRunnerKind(nextPhaseDef, run.defaultRunnerKind) !== runner;
    const advanced: WorkflowRun = {
      ...run,
      currentPhase: transition.nextPhase,
      currentIteration: transition.nextIteration,
      lastTransitionAt: Date.now(),
      phasesCompleted: [...run.phasesCompleted, phaseResult],
      pendingRetryAt: null,
      pendingRetryCause: null,
      delayedRetryCount: 0,
      ...(crossesRunnerBoundary
        ? {
            lastCliSessionId: undefined,
            lastCliSessionRunnerKind: undefined
          }
        : {})
    };
    const persisted = await this.deps.persistTransition(run, advanced);
    await this.deps.emitOptionalPhaseFailureContinued(persisted, {
      runId: persisted.id,
      // Feature 098 (T045, FR-034) — omitted, not substituted.
      ...(persisted.pipeline?.id === undefined ? {} : { pipelineId: persisted.pipeline.id }),
      phaseId: phaseResult.phase,
      runner,
      iteration: phaseResult.iteration,
      terminationReason: phaseResult.terminationReason
    });
    return persisted;
  }

  private isAuditEvidenceAvailable(): boolean {
    return this.deps.options.isAuditEvidenceAvailable?.() ?? true;
  }

  private async failClosedForAuditEvidence(
    run: WorkflowRun,
    description: string
  ): Promise<WorkflowRun> {
    const message = 'Required structured audit evidence is unavailable.';
    const lastError: SanitizedError = {
      code: 'audit-evidence-unavailable',
      message,
      phase: run.currentPhase,
      iteration: run.currentIteration,
      at: Date.now()
    };
    const failed = await this.deps.persistTransition(run, {
      ...run,
      status: 'failed',
      lastError,
      lastTransitionAt: Date.now()
    });

    this.deps.logger.error(
      'run-driver: execution stopped because required structured audit evidence is unavailable'
    );
    this.deps.statusBar.update(failed.id, {
      kind: 'failed',
      phase: failed.currentPhase,
      detail: message
    });
    this.deps.notifier.warn(
      'Schegent: execution stopped because required structured audit evidence is unavailable. Resolve the evidence sink and reload the workspace before resuming.'
    );
    try {
      await this.deps.queue.finish(failed.featureId, 'failed', {
        code: lastError.code,
        message: lastError.message,
        phase: lastError.phase ?? undefined,
        correlationId: failed.id
      });
    } catch (queueError) {
      this.deps.logger.warn(
        `run-driver: queue.finish (audit unavailable) failed: ${(queueError as Error).message}`
      );
    }
    try {
      await this.deps.historyRecorder.record(failed, description, 'failed');
    } catch (historyError) {
      this.deps.logger.warn(
        `run-driver: history record (audit unavailable) failed: ${(historyError as Error).message}`
      );
    }
    return failed;
  }

  private phaseOverrideAbortKey(runId: string, phaseId: string): string {
    return `${runId}:${phaseId}`;
  }

  // Feature 091 (T011, US1) — the call site FR-001 was missing. `resolveRunOutputs`
  // shipped with 087 and nothing invoked it, so `WorkflowRun.runOutputs` was never
  // written and every downstream reader — prior-output references, the Run details
  // projection — answered from an absence rather than from a record.
  //
  // The declaration is read from the **frozen envelope** on the Run, never from
  // the live catalog: the envelope is what the operator approved, and a Pipeline
  // edited mid-Run must not change what this Run is judged to have produced.
  //
  // FR-R3-001 (T266) moved the read off the queue row. It used to be
  // `queue.findById(run.featureId)?.runPlan?.outputs` — a second lookup, of a
  // second copy, keyed on a row that may already be gone by the time a Run
  // completes. The targets the backend was told to write (T264) and the targets
  // probed here are now literally the same array on the same object, so the two
  // cannot disagree; under the old read they could disagree silently, and the
  // observable symptom was an `unresolved` output nobody had asked for.
  //
  // Returns `[]` — not a throw — for every "there is nothing to record" shape:
  // no envelope (a legacy or non-composed Run) and no declared outputs. FR-008's
  // "records nothing" and "there was nothing to record" are the same observable
  // outcome, and a completion transition must not be gated on it.
  private async recordDeclaredOutputs(run: WorkflowRun): Promise<readonly RunOutputRecord[]> {
    const outputs = run.envelope?.outputs;
    if (!outputs || outputs.length === 0) return [];

    return resolveRunOutputs(outputs, {
      workspaceRoot: this.deps.options.cwd,
      probe: createBoundedOutputProbe()
    });
  }

  // Feature 072 — derive phase stats from the pipeline snapshot and
  // completion records for the task-execution-ended payload.
  //
  // FR-R3-009 — delegated to `computeRunPhaseStats` in `state/workflow-run.ts`
  // so the durable metrics rollup reports the same three numbers this payload
  // does. Both are unioned by run id downstream; two implementations would let
  // a total depend on which range a run fell in.
  private computePhaseStats(run: WorkflowRun): RunPhaseStats {
    return computeRunPhaseStats(run);
  }
}

function pickCarriedIssues(
  result: import('../parser/stdout-parser').InvocationResult
): Array<{ tag?: string; summary: string }> | string[] {
  if (result.kind === 'open_questions') return result.questions;
  if (result.kind === 'remaining_issues') return result.issues;
  return [];
}
