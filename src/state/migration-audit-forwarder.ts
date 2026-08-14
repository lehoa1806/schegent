// Forward state-migration audit events through the sanitized audit
// writer. Extracted from extension.ts to keep the host registration
// site below its LOC budget. Four migration kinds are forwarded:
//   - v5 → v6 single-queue migration (Feature 030)
//   - v6 → v7 enqueue/start-separation lift (Feature 065)
//   - v10 → v11 per-queue Run-record reshape (Feature 093)
//   - workflow-run repair events (legacy)
//
// Each forwarding loop swallows append errors and logs a sanitized
// warn — best-effort, never blocks activation.
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type {
  StateMigratedV5ToV6AuditEvent,
  StateMigratedV6ToV7AuditEvent
} from './queue-state-migrator';
import type { RunStateMigrationAuditEvent } from './run-state-migrator';
import type { WorkflowRunRepairedAuditEvent } from './workflow-run-migrator';
import type { SanitizedLogger } from '../lib/logger';

type WarnLogger = Pick<SanitizedLogger, 'warn'>;
type AuditAppender = Pick<AuditLogWriter, 'append'>;

export interface MigrationAuditEvents {
  readonly v6MigrationEvents: readonly StateMigratedV5ToV6AuditEvent[];
  readonly v7MigrationEvents: readonly StateMigratedV6ToV7AuditEvent[];
  // Feature 093 — the v10 → v11 reshape, plus every repair it made on the way.
  // A migration nobody can audit is a migration nobody can debug, which is why
  // this field exists at the same time as the events that fill it rather than
  // a release later.
  readonly v11MigrationEvents: readonly RunStateMigrationAuditEvent[];
  readonly runRepairEvents: readonly WorkflowRunRepairedAuditEvent[];
}

/**
 * The audit payload for one v10 → v11 event.
 *
 * Identifiers, counts and closed reason codes only — never a queue name, a task
 * description or a pipeline name. Those are operator-authored, and the
 * structured audit log is not a place for operator-authored content. The three
 * event shapes are disjoint, so the payload is built per type rather than by
 * spreading the event and hoping every field is safe.
 */
function runMigrationPayload(event: RunStateMigrationAuditEvent): Record<string, unknown> {
  switch (event.type) {
    case 'state-migrated-v10-to-v11':
      return {
        fromVersion: event.fromVersion,
        toVersion: event.toVersion,
        occurredAt: event.occurredAt,
        queueIds: event.queueIds,
        runCount: event.runCount
      };
    case 'run-reassigned-to-default-queue':
      return {
        occurredAt: event.occurredAt,
        runId: event.runId,
        queueId: event.queueId,
        reason: event.reason
      };
    case 'run-record-repaired':
      return { occurredAt: event.occurredAt, reason: event.reason };
  }
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
  for (const event of events.v11MigrationEvents) {
    try {
      await auditWriter.append({
        // A reshape event belongs to no single Run, and a reassign event names
        // its Run in the payload rather than in `runId`: the reshape is the
        // record the auditor correlates on, and giving one of the three shapes
        // a different correlation key would split the migration across two
        // views of the log.
        runId: '',
        phase: 'state-migration',
        iteration: 0,
        eventType: event.type,
        payload: runMigrationPayload(event),
        outcome: 'success'
      });
    } catch (err) {
      logger.warn(`state-migrated-v10-to-v11 audit append failed: ${(err as Error).message}`);
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
