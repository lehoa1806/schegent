import type { PhaseRunner } from '../controller/phase-runner';
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
  readonly emitRunEndedBreakpointAudit: (run: WorkflowRun) => Promise<void>;
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
  private readonly removedActivePhaseAborts = new Set<string>();
  private readonly sequencer = new PhaseSequencer();

  constructor(private readonly deps: RunDriverDeps) {}

  public get running(): boolean {
    return this.isRunning;
  }

  public cancelActive(): void {
    this.cancellationController?.abort();
  }

  public noteActivePhaseRemovalAbort(runId: string, phaseId: string): void {
    this.removedActivePhaseAborts.add(this.phaseRemovalAbortKey(runId, phaseId));
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

    try {
      await this.deps.lock.withLock('drive-run', async (session) => {
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
          const output = await this.deps.runner.run({
            phase: run.currentPhase,
            phaseDef: activePhaseDef,
            pipelineId: run.pipeline?.id ?? BUILT_IN_PIPELINE_ID,
            iteration,
            iterationCap: this.deps.options.iterationCap,
            featureDescription: description,
            featureDir: run.featureDir || null,
            carriedIssues: this.carriedIssues,
            cliPath: this.deps.options.cliPath,
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
            isContinue: dispatchIsContinue
          });
          if (
            this.removedActivePhaseAborts.delete(
              this.phaseRemovalAbortKey(run.id, run.currentPhase)
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
            await this.deps.queue.finish(run.featureId, 'failed', {
              code: sanitized.code,
              message: sanitized.message,
              phase: sanitized.phase ?? undefined,
              correlationId: run.id
            });
            await this.deps.historyRecorder.record(run, description, 'failed');
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
          await this.deps.queue.finish(run.featureId, 'completed');
          await this.deps.historyRecorder.record(run, description, 'completed');
        }
      });
    } finally {
      this.isRunning = false;
      this.cancellationController = null;
      this.carriedIssues = [];
      this.deps.scheduleAutoDrain();
    }
  }

  private phaseRemovalAbortKey(runId: string, phaseId: string): string {
    return `${runId}:${phaseId}`;
  }
}

function pickCarriedIssues(
  result: import('../parser/stdout-parser').InvocationResult
): Array<{ tag?: string; summary: string }> | string[] {
  if (result.kind === 'open_questions') return result.questions;
  if (result.kind === 'remaining_issues') return result.issues;
  return [];
}
