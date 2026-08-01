import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PhaseRunner } from '../controller/phase-runner';
import { buildSpawnEnv } from '../runner/spawn-env';

const execFileAsync = promisify(execFile);
import { composePhaseMessagePath } from '../controller/phase-runner';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { QueueManager } from '../queue/queue-manager';
import type { SchegentStatusBar } from '../ui/status-bar';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceLockManager } from '../state/lock';
import type { IsContinueGate } from '../controller/is-continue-gate';
import { PhaseSequencer, nextOverridesAfterSkip } from '../controller/phase-sequencer';
import type { PhaseResult, SanitizedError, WorkflowRun } from '../state/workflow-run';
import type { ClaudeCliMonitor } from '../monitor/claude-cli-monitor';
import type { PhaseName } from '../ui/sidebar/snapshot';
import { BUILT_IN_PIPELINE_ID } from '../config/pipeline-config';
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

interface RunDriverOptions {
  readonly cliPath: string;
  readonly cwd: string;
  readonly iterationCap: number;
  readonly timeoutMs: number;
  readonly inheritProcessEnv?: boolean;
  readonly processEnvAllowlist?: readonly string[];
  // Feature 074 — resolve the CLI binary path for a given runner kind.
  // When undefined, falls back to `cliPath` for all runners.
  readonly cliPathResolver?: (runnerKind: string) => string;
  /** Effective global backend for phases without an explicit override. */
  readonly defaultRunnerKind?: BackendRunnerKind;
  readonly skipProbing?: boolean;
  readonly isAuditEvidenceAvailable?: () => boolean;
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
  readonly lock: WorkspaceLockManager;
  readonly options: RunDriverOptions;
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
  readonly scheduleAutoDrain: () => void;
  readonly onRunTerminal?: (run: WorkflowRun) => Promise<void>;
}

/**
 * Feature 013 T096 - owns the phase driving loop formerly embedded in
 * WorkflowController. The controller remains the public command surface;
 * RunDriver owns run-loop state, cancellation, lock retention, and phase
 * advancement orchestration.
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
      await this.deps.lock.withLock('drive-run', async (session) => {
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
            const cliPath = this.resolveCliPath(runnerKind);
            try {
              await execFileAsync(cliPath, ['--help'], {
                cwd: this.deps.options.cwd,
                env: buildSpawnEnv({
                  env: {
                    SCHEGENT_PHASE: 'runner-probe',
                    SCHEGENT_ITERATION: '0'
                  },
                  inheritProcessEnv: this.deps.options.inheritProcessEnv !== false,
                  processEnvAllowlist: this.deps.options.processEnvAllowlist
                })
              });
            } catch (err: unknown) {
              const probeErr = err instanceof Error ? err : new Error(String(err));
              const failureMessage =
                `Runner probe failed for ${runnerKind}: CLI executable is unavailable or invalid.`;
              this.deps.logger.error(
                `run-driver: ${failureMessage} ${probeErr.message}`
              );
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
              this.deps.statusBar.update({
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
              return; // break out of withLock completely
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
          this.deps.statusBar.update({
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

          const output = await this.deps.runner.run({
            phase: run.currentPhase,
            phaseDef: dispatchPhaseDef,
            pipelineId: run.pipeline?.id ?? BUILT_IN_PIPELINE_ID,
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
            inheritProcessEnv: this.deps.options.inheritProcessEnv !== false,
            processEnvAllowlist: this.deps.options.processEnvAllowlist,
            runId: run.id,
            phaseMessagePath: composePhaseMessagePath({
              cwd: this.deps.options.cwd,
              runId: run.id,
              pipelineId: run.pipeline?.id ?? BUILT_IN_PIPELINE_ID,
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
            resumePrompt: sessionDispatch.resumePrompt
          });
          if (
            this.overriddenActivePhaseAborts.delete(
              this.phaseOverrideAbortKey(run.id, run.currentPhase)
            )
          ) {
            const latestRun = this.deps.store.getRun();
            if (latestRun?.id === run.id) {
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
            latestRun: this.deps.store.getRun(),
            now: Date.now()
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
            this.deps.statusBar.update({ kind: 'paused', phase: run.currentPhase });
            const feature = this.deps.queue.findById(run.featureId);
            const queueId = feature?.queueId ?? null;
            if (queueId) {
              await this.deps.queue.cascadedPause(queueId);
            }
            session.retain();
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
            run = await this.deps.retryCoordinator.handleDelayedRetry(
              run,
              iteration,
              phaseResult,
              postDecision.cause,
              postDecision.resetsAtMs,
              postDecision.rateLimitMessage,
              postDecision.originalCause
            );
            session.retain();
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
            this.deps.statusBar.update({ kind: 'paused', phase: run.currentPhase });
            await this.deps.retryCoordinator.handleRateLimitPause(postDecision.cause, run);
            session.retain();
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
            this.deps.statusBar.update({
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
            const paused: WorkflowRun = {
              ...run,
              status: 'paused',
              currentIteration: iteration,
              lastTransitionAt: Date.now(),
              phasesCompleted: [...run.phasesCompleted, phaseResult]
            };
            run = await this.deps.persistTransition(run, paused);
            await this.deps.queue.pause(run.featureId, 'phase-paused');
            await this.deps.appendPhaseControlAudit('phase-paused', run, {
              runId: run.id,
              phaseId: run.currentPhase
            });
            this.deps.statusBar.update({ kind: 'paused', phase: run.currentPhase });
            session.retain();
            break;
          }

          if (postDecision.kind === 'break-unexpected') {
            break;
          }

          if (postDecision.kind === 'pause-manual') {
            const decision = postDecision.transition;
            const latestRun = this.deps.store.getRun()!;
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
            this.deps.statusBar.update({ kind: 'paused', phase: phaseResult.phase });
            session.retain();
            break;
          }

          run = await this.deps.retryCoordinator.maybeEmitRetryRecovered(
            run,
            output.outcome
          );

          const decision = postDecision.transition;
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
            ...(crossesRunnerBoundary
              ? {
                  lastCliSessionId: undefined,
                  lastCliSessionRunnerKind: undefined
                }
              : {})
          };
          run = await this.deps.persistTransition(run, advanced);
        }

        if (run.currentPhase === 'done' && run.status === 'running') {
          const completed: WorkflowRun = {
            ...run,
            status: 'completed',
            lastTransitionAt: Date.now()
          };
          run = await this.deps.persistTransition(run, completed);
          await this.deps.emitRunEndedBreakpointAudit(run);
          this.deps.statusBar.update({ kind: 'completed' });
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
      });
    } catch (error) {
      const auditUnavailable =
        error instanceof RequiredEvidenceUnavailableError ||
        this.deps.options.isAuditEvidenceAvailable?.() === false;
      if (!auditUnavailable) throw error;

      allowAutoDrain = false;
      run = await this.failClosedForAuditEvidence(run, description);
    } finally {
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'canceled') {
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
    this.deps.statusBar.update({
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

  // Feature 072 — derive phase stats from the pipeline snapshot and
  // completion records for the task-execution-ended payload.
  private computePhaseStats(run: WorkflowRun): {
    phasesTotal: number;
    phasesCompleted: number;
    phasesSkipped: number;
  } {
    const total = run.pipeline?.phases?.length ?? 0;
    const completed = run.phasesCompleted.filter(
      (p) => p.result === 'clean'
    ).length;
    const skipped = run.phasesCompleted.filter(
      (p) => p.result === 'skipped'
    ).length;
    return { phasesTotal: total, phasesCompleted: completed, phasesSkipped: skipped };
  }
}

function pickCarriedIssues(
  result: import('../parser/stdout-parser').InvocationResult
): Array<{ tag?: string; summary: string }> | string[] {
  if (result.kind === 'open_questions') return result.questions;
  if (result.kind === 'remaining_issues') return result.issues;
  return [];
}
