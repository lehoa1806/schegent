import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PhaseRunner } from '../controller/phase-runner';

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

interface RunDriverOptions {
  readonly cliPath: string;
  readonly cwd: string;
  readonly iterationCap: number;
  readonly timeoutMs: number;
  readonly inheritProcessEnv?: boolean;
  // Feature 074 — resolve the CLI binary path for a given runner kind.
  // When undefined, falls back to `cliPath` for all runners.
  readonly cliPathResolver?: (runnerKind: string) => string;
  readonly skipProbing?: boolean;
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
  private resolveCliPath(runnerKind?: string): string {
    if (runnerKind && this.deps.options.cliPathResolver) {
      return this.deps.options.cliPathResolver(runnerKind);
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

    try {
      await this.deps.lock.withLock('drive-run', async (session) => {
        // Feature 074 T017 — Probe all distinct runners referenced in the pipeline at start
        if (
          process.env.NODE_ENV !== 'test' &&
          !this.deps.options.skipProbing &&
          run.phasesCompleted.length === 0 &&
          run.currentIteration === 0 &&
          run.pipeline
        ) {
          const runners = new Set(run.pipeline.phases.map((p) => p.runner || 'claude'));
          for (const runnerKind of runners) {
            const cliPath = this.resolveCliPath(runnerKind);
            try {
              await execFileAsync(cliPath, ['--help']);
            } catch (err: any) {
              const probeErr = err as Error;
              this.deps.logger.error(`Probe failed for runner ${runnerKind} at ${cliPath}: ${probeErr.message}`);
              run = await this.deps.persistTransition(run, { ...run, status: 'failed' });
              
              if (this.deps.appendRunnerProbeFailedAudit) {
                await this.deps.appendRunnerProbeFailedAudit(run, {
                  runnerKind,
                  cliPath,
                  errorMessage: probeErr.message,
                  runId: run.id
                });
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
                    lastErrorSummary: `Runner probe failed for ${runnerKind}: ${probeErr.message}`.slice(0, 240)
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
            const advanced: WorkflowRun = {
              ...run,
              phaseOverrides: nextOverridesAfterSkip(run, phaseOverride),
              currentPhase: decision.kind === 'advance' ? decision.nextPhase : run.currentPhase,
              currentIteration:
                decision.kind === 'advance' ? decision.nextIteration : run.currentIteration,
              lastTransitionAt: Date.now(),
              phasesCompleted: [...run.phasesCompleted, skippedResult]
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
          const dispatchIsContinue = pendingIsContinue;
          pendingIsContinue = false;
          // Session reuse: use --resume for both isContinue (interrupted
          // conversation) AND session reuse (cost optimization). isContinue
          // takes precedence when both are true.
          const shouldResumeSession = dispatchIsContinue || pendingSessionReuse;
          const dispatchResumeSessionId =
            shouldResumeSession && typeof run.lastCliSessionId === 'string'
              ? run.lastCliSessionId
              : undefined;
          const dispatchSessionReuse = pendingSessionReuse && !dispatchIsContinue;
          const dispatchResumePrompt = dispatchIsContinue ? run.resumePrompt : undefined;
          if (run.resumePrompt !== undefined) {
            const nextRun = { ...run };
            delete nextRun.resumePrompt;
            run = await this.deps.persistTransition(run, nextRun);
          }

          const output = await this.deps.runner.run({
            phase: run.currentPhase,
            phaseDef: activePhaseDef,
            pipelineId: run.pipeline?.id ?? BUILT_IN_PIPELINE_ID,
            iteration,
            iterationCap: this.deps.options.iterationCap,
            featureDescription: description,
            featureDir: run.featureDir || null,
            carriedIssues: this.carriedIssues,
            // Feature 074 — resolve CLI path per-runner-kind. When a phase
            // specifies a runner, use the cliPathResolver to pick the
            // correct binary; otherwise fall back to the global cliPath.
            cliPath: this.resolveCliPath(activePhaseDef?.runner),
            cwd: this.deps.options.cwd,
            timeoutMs: activePhaseDef?.timeoutSeconds
              ? activePhaseDef.timeoutSeconds * 1000
              : this.deps.options.timeoutMs,
            inheritProcessEnv: this.deps.options.inheritProcessEnv !== false,
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
            isContinue: dispatchIsContinue,
            sessionReuse: dispatchSessionReuse,
            resumeSessionId: dispatchResumeSessionId,
            resumePrompt: dispatchResumePrompt
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

          // Session ID capture — persist the captured session ID onto
          // the run so future retry/resume dispatches can target the
          // exact session via `--resume <id>`. Only overwrite if the
          // runner returned a non-undefined value (stream-json was
          // active and a session_id was found).
          if (output.cliSessionId !== undefined) {
            run = { ...run, lastCliSessionId: output.cliSessionId };
            // Enable session reuse for subsequent invocations in this
            // drive cycle now that we have a valid session ID.
            pendingSessionReuse = true;
          }

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
                phaseDef: activePhaseDef
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
          const advanced: WorkflowRun = {
            ...run,
            currentPhase: decision.kind === 'advance' ? decision.nextPhase : run.currentPhase,
            currentIteration:
              decision.kind === 'advance' || decision.kind === 'loop'
                ? decision.nextIteration
                : run.currentIteration,
            lastTransitionAt: Date.now(),
            phasesCompleted: [...run.phasesCompleted, phaseResult]
          };
          run = await this.deps.persistTransition(run, advanced);

          // Feature 074 — session context reset on runner transition. When
          // the next phase uses a different runner kind than the current phase,
          // clear the cached session ID and session reuse flag so the new
          // runner starts a fresh session. Cross-backend session continuation
          // is explicitly out of scope (FR-016).
          if (decision.kind === 'advance') {
            const currentRunnerKind = activePhaseDef?.runner;
            const nextPhaseDef = run.pipeline?.phases?.find(
              (p: { id: string }) => p.id === decision.nextPhase
            );
            const nextRunnerKind = nextPhaseDef?.runner;
            if (currentRunnerKind !== nextRunnerKind) {
              pendingSessionReuse = false;
              run = { ...run, lastCliSessionId: undefined };
            }
          }
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
    } finally {
      this.isRunning = false;
      this.cancellationController = null;
      this.carriedIssues = [];
      this.deps.scheduleAutoDrain();
    }
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
