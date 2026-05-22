// Forward state-migration audit events through the sanitized audit
// writer. Extracted from extension.ts to keep the host registration
// site below its LOC budget. Three migration kinds are forwarded:
//   - v5 → v6 single-queue migration (Feature 030)
//   - v6 → v7 enqueue/start-separation lift (Feature 065)
//   - workflow-run repair events (legacy)
//
// Each forwarding loop swallows append errors and logs a sanitized
// warn — best-effort, never blocks activation.
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type {
  StateMigratedV5ToV6AuditEvent,
  StateMigratedV6ToV7AuditEvent
} from './queue-state-migrator';
import type { WorkflowRunRepairedAuditEvent } from './workflow-run-migrator';
import type { SanitizedLogger } from '../lib/logger';

type WarnLogger = Pick<SanitizedLogger, 'warn'>;
type AuditAppender = Pick<AuditLogWriter, 'append'>;

export interface MigrationAuditEvents {
  readonly v6MigrationEvents: readonly StateMigratedV5ToV6AuditEvent[];
  readonly v7MigrationEvents: readonly StateMigratedV6ToV7AuditEvent[];
  readonly runRepairEvents: readonly WorkflowRunRepairedAuditEvent[];
}

export async function forwardMigrationAuditEvents(
  events: MigrationAuditEvents,
  auditWriter: AuditAppender,
  logger: WarnLogger
): Promise<void> {
  for (const event of events.v6MigrationEvents) {
    try {
      await auditWriter.append({
        runId: '',
        phase: 'state-migration',
        iteration: 0,
        eventType: event.type,
        payload: {
          fromVersion: event.fromVersion,
          toVersion: event.toVersion,
          sourceQueueCount: event.sourceQueueCount,
          pendingTaskCount: event.pendingTaskCount,
          inFlightTaskCount: event.inFlightTaskCount,
          inheritedPausedState: event.inheritedPausedState,
          coalesceRule: event.coalesceRule
        },
        outcome: 'success'
      });
    } catch (err) {
      logger.warn(`state-migrated audit append failed: ${(err as Error).message}`);
    }
  }
  for (const event of events.v7MigrationEvents) {
    try {
      await auditWriter.append({
        runId: '',
        phase: 'state-migration',
        iteration: 0,
        eventType: event.type,
        payload: {
          fromVersion: event.fromVersion,
          toVersion: event.toVersion,
          occurredAt: event.occurredAt,
          counts: event.counts
        },
        outcome: 'success'
      });
    } catch (err) {
      logger.warn(`state-migrated-v6-to-v7 audit append failed: ${(err as Error).message}`);
    }
  }
  for (const event of events.runRepairEvents) {
    try {
      await auditWriter.append({
        runId: event.runId,
        phase: 'state-migration',
        iteration: 0,
        eventType: event.type,
        payload: {
          pipelineId: event.pipelineId,
          repair: event.repair,
          removedPhaseCount: event.removedPhaseCount,
          removedBreakpointCount: event.removedBreakpointCount,
          remainingPhaseCount: event.remainingPhaseCount
        },
        outcome: 'success'
      });
    } catch (err) {
      logger.warn(`workflow-run-repaired audit append failed: ${(err as Error).message}`);
    }
  }
}
