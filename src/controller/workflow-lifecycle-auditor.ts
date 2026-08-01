import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkflowRun } from '../state/workflow-run';
import type {
  BreakpointAuditEvent,
  PhaseControlAuditEvent
} from './phase-control-service';

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
        payload,
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
