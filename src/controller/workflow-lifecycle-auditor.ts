import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkflowRun } from '../state/workflow-run';
import type {
  BreakpointAuditEvent,
  PhaseControlAuditEvent
} from './phase-control-service';
import type {
  OptionalPhaseFailureContinuedPayload,
  OutputTargetRefusedAtDispatchPayload,
  RunSnapshotDeclinedPayload
} from '../contracts/audit-events';
import { emitTerminalOutcomeAudit } from '../services/terminal-outcome-audit';

export type TaskLifecycleAuditEvent =
  | 'task-execution-started'
  | 'task-execution-ended'
  | 'task-execution-paused';

/**
 * Constructs and appends workflow/phase lifecycle evidence. State mutation and
 * dispatch policy stay in their services; this class owns audit taxonomy,
 * envelopes, and best-effort failure logging.
 */
export class WorkflowLifecycleAuditor {
  constructor(
    private readonly writer: Pick<AuditLogWriter, 'append'> | null,
    private readonly logger: SanitizedLogger
  ) {}

  public async appendPhaseControl(
    eventType: PhaseControlAuditEvent,
    run: WorkflowRun,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.writer) return;
    try {
      await this.writer.append({
        runId: run.id,
        phase: run.currentPhase,
        iteration: run.currentIteration,
        eventType,
        payload: { ...payload },
        outcome: 'info'
      });
    } catch (err) {
      this.logger.warn(`phase-control audit append failed: ${(err as Error).message}`);
    }
  }

  public async appendRunnerProbeFailed(
    run: WorkflowRun,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.writer) return;
    try {
      await this.writer.append({
        runId: run.id,
        phase: run.currentPhase,
        iteration: run.currentIteration,
        eventType: 'runner-probe-failed',
        payload,
        outcome: 'failure'
      });
    } catch (err) {
      this.logger.warn(`appendRunnerProbeFailedAudit failed: ${(err as Error).message}`);
    }
  }

  public async emitTaskLifecycle(
    eventType: TaskLifecycleAuditEvent,
    run: WorkflowRun,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.writer) return;
    try {
      await this.writer.append({
        runId: run.id,
        phase: run.currentPhase,
        iteration: run.currentIteration,
        eventType,
        payload,
        outcome: 'info'
      });
    } catch (err) {
      this.logger.warn(
        `task-lifecycle audit append failed (${eventType}): ${(err as Error).message}`
      );
    }
  }

  /**
   * The terminal record, for the controller's own route to a terminal state.
   *
   * `handleUnexpectedStartFailure` fails a Run that threw before or outside the drive:
   * it persists `status: 'failed'`, finishes the queue row, records history and releases
   * the lease — and until 2026-08-31 it emitted nothing, because FR-R3-107's one emitter
   * was private to `RunDriver`. A run could be `failed` in the state store and still open
   * in the durable record. `terminal-outcome-audit.ts` holds the payload and the history.
   *
   * It goes through that module rather than building a payload here for the reason the
   * consolidation existed: two shapes for one event is the drift FR-R3-107 removed.
   */
  public async emitTaskExecutionEnded(
    run: WorkflowRun,
    terminalStatus: 'completed' | 'failed',
    lastErrorSummary?: string
  ): Promise<void> {
    const extra = lastErrorSummary === undefined ? {} : { lastErrorSummary };
    await emitTerminalOutcomeAudit(this, this.logger, run, terminalStatus, extra);
  }

  public async emitOptionalPhaseFailureContinued(
    run: WorkflowRun,
    payload: OptionalPhaseFailureContinuedPayload
  ): Promise<void> {
    if (!this.writer) return;
    try {
      await this.writer.append({
        runId: run.id,
        phase: payload.phaseId,
        iteration: payload.iteration,
        eventType: 'phase-optional-failure-continued',
        payload: { ...payload },
        outcome: 'info'
      });
    } catch (err) {
      this.logger.warn(
        `optional-phase continuation audit append failed: ${(err as Error).message}`
      );
    }
  }

  /**
   * FR-R3-077 (T1040) — the read-side decline, as evidence.
   *
   * `warn` and not `info`: a superseded record reaching a reader means a write
   * landed in the window the commit-point check cannot cover, which is a fact
   * about this workspace's concurrency rather than a routine event.
   */
  public async emitRunSnapshotDeclined(
    run: WorkflowRun,
    payload: RunSnapshotDeclinedPayload
  ): Promise<void> {
    if (!this.writer) return;
    try {
      await this.writer.append({
        runId: run.id,
        phase: run.currentPhase,
        iteration: run.currentIteration,
        eventType: 'run-snapshot-declined',
        // `failure` and not `info`: the audit outcome vocabulary has three arms
        // and no `warn`. A superseded record reaching a reader is a refusal that
        // happened, which is what `failure` records here — the read declined.
        outcome: 'failure',
        payload: { ...payload }
      });
    } catch (err) {
      this.logger.warn(`run-snapshot-declined audit append failed: ${(err as Error).message}`);
    }
  }

  /** FR-R3-079 (T1058) — the dispatch refusal, as evidence an operator can read. */
  public async emitOutputTargetRefusedAtDispatch(
    run: WorkflowRun,
    payload: OutputTargetRefusedAtDispatchPayload
  ): Promise<void> {
    if (!this.writer) return;
    try {
      await this.writer.append({
        runId: run.id,
        phase: run.currentPhase,
        iteration: run.currentIteration,
        eventType: 'output-target-refused-at-dispatch',
        outcome: 'failure',
        payload: { ...payload }
      });
    } catch (err) {
      this.logger.warn(
        `output-target-refused audit append failed: ${(err as Error).message}`
      );
    }
  }

  public async emitPhaseJumped(run: WorkflowRun, phaseId: string): Promise<void> {
    if (!this.writer) return;
    try {
      await this.writer.append({
        runId: run.id,
        phase: phaseId,
        iteration: run.currentIteration,
        eventType: 'phase-jumped',
        outcome: 'info',
        payload: {
          phaseId,
          runId: run.id,
          pipelineId: run.pipeline?.id ?? '',
          durationMs: Date.now() - (run.lastTransitionAt ?? Date.now()),
          iterationN: run.currentIteration,
          reason: 'operator-jump',
          phasesSkipped: 1
        }
      });
    } catch (err) {
      this.logger.warn(`phase-jumped audit append failed: ${(err as Error).message}`);
    }
  }

  public async emitRunEndedBreakpoints(run: WorkflowRun): Promise<void> {
    for (const breakpoint of run.phaseBreakpoints) {
      await this.appendBreakpoint('phase-breakpoint-cleared', run, {
        runId: run.id,
        phaseId: breakpoint.phaseId,
        cause: 'run-ended'
      });
    }
  }

  public async appendBreakpoint(
    eventType: BreakpointAuditEvent,
    run: WorkflowRun,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.writer) return;
    try {
      await this.writer.append({
        runId: run.id,
        phase: run.currentPhase,
        iteration: run.currentIteration,
        eventType,
        payload,
        outcome: 'info'
      });
    } catch (err) {
      this.logger.warn(`breakpoint audit append failed: ${(err as Error).message}`);
    }
  }
}
