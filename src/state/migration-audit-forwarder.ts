// Forward state-migration audit events through the sanitized audit
// writer. Extracted from extension.ts to keep the host registration
// site below its LOC budget. Five migration kinds are forwarded:
//   - v5 → v6 single-queue migration (Feature 030)
//   - v6 → v7 enqueue/start-separation lift (Feature 065)
//   - v10 → v11 per-queue Run-record reshape (Feature 093)
//   - v11 → v12 per-queue history partition (FR-R3-010)
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
import type { HistoryStateMigrationAuditEvent } from './history-state-migrator';
import type { WorkflowRunRepairedAuditEvent } from './workflow-run-migrator';
import type { SanitizedLogger } from '../lib/logger';
import { errorMessage } from '../lib/errors';
import type { RunRecordQuarantinedPayload } from '../contracts/audit-events';

type WarnLogger = Pick<SanitizedLogger, 'warn'>;
type AuditAppender = Pick<AuditLogWriter, 'append'>;

/**
 * FR-R3-111 — quarantined run records, forwarded the same way the migration events are.
 *
 * WHY IT IS HERE AND WHY IT WAS MISSING. `WorkspaceStateStore.initialize()` runs before the audit
 * writer exists, so a quarantine is buffered and drained afterwards — exactly the arrangement the
 * five migration kinds above use. The buffer, the drain and the closed payload all shipped; **the
 * drain was called by nothing but its own test**, so in production a corrupt run record was
 * quarantined and the audit event that replaces the silent discard was never appended. The item was
 * about not discarding evidence silently, and its own evidence was being discarded silently.
 *
 * Found by measuring public methods with no caller anywhere in `src/` — the same shape as
 * `seedChainFrom`, in the same batch, three hours apart.
 */
export interface QuarantineAuditEvent {
  readonly eventType: 'run-record-quarantined';
  // The contract's own payload type, not a widened record: this forwarder must not become a way to
  // put an unclosed shape into a closed union. `src/contracts/audit-events.ts` owns what may be in
  // it, and its parity gates check that.
  readonly payload: RunRecordQuarantinedPayload;
}

export interface MigrationAuditEvents {
  readonly v6MigrationEvents: readonly StateMigratedV5ToV6AuditEvent[];
  readonly v7MigrationEvents: readonly StateMigratedV6ToV7AuditEvent[];
  // Feature 093 — the v10 → v11 reshape, plus every repair it made on the way.
  // A migration nobody can audit is a migration nobody can debug, which is why
  // this field exists at the same time as the events that fill it rather than
  // a release later.
  readonly v11MigrationEvents: readonly RunStateMigrationAuditEvent[];
  // FR-R3-010 — the v11 → v12 history reshape, plus the entries it could not
  // attribute. Same contract as `v11MigrationEvents`: the store collects them
  // during `initialize()` and hands them here rather than writing them itself,
  // because a migrator that reaches the audit writer is a migrator that can fail
  // activation on an I/O error.
  readonly v12MigrationEvents: readonly HistoryStateMigrationAuditEvent[];
  readonly runRepairEvents: readonly WorkflowRunRepairedAuditEvent[];
  /**
   * FR-R3-111 — records quarantined during `initialize()`. Optional so every existing caller and
   * test constructs this object unchanged; absent means none, which is the common case.
   */
  readonly quarantineEvents?: readonly QuarantineAuditEvent[];
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

/**
 * The audit payload for one v11 → v12 event.
 *
 * Built per type for the same reason as `runMigrationPayload` above: the three
 * shapes are disjoint, and spreading the event would make the safety of the
 * payload depend on nobody ever adding a field to the migrator's event types. A
 * history entry carries a task description and an error summary, so this is the
 * one migration family where a spread would have somewhere unsafe to reach.
 */
function historyMigrationPayload(event: HistoryStateMigrationAuditEvent): Record<string, unknown> {
  switch (event.type) {
    case 'state-migrated-v11-to-v12':
      return {
        fromVersion: event.fromVersion,
        toVersion: event.toVersion,
        occurredAt: event.occurredAt,
        queueIds: event.queueIds,
        entryCount: event.entryCount
      };
    case 'history-entries-unattributed':
      return {
        occurredAt: event.occurredAt,
        queueId: event.queueId,
        entryCount: event.entryCount,
        reason: event.reason
      };
    case 'history-record-repaired':
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
  for (const event of events.v12MigrationEvents) {
    try {
      await auditWriter.append({
        // No runId, on the same reasoning as the reshape above and one more
        // besides: a history entry describes a Run that has already ended, so
        // there is no Run for the correlation key to reach even in principle.
        runId: '',
        phase: 'state-migration',
        iteration: 0,
        eventType: event.type,
        payload: historyMigrationPayload(event),
        outcome: 'success'
      });
    } catch (err) {
      logger.warn(`state-migrated-v11-to-v12 audit append failed: ${(err as Error).message}`);
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
  // FR-R3-111 — the quarantine's audit half. `runId` is empty because a quarantined record is one
  // whose run identity could not be trusted enough to read; the payload carries the queue, the
  // reason and the depth, and nothing else. `outcome: 'failure'` because a record that had to be
  // quarantined is a failure of the state this host was handed, not a routine migration step.
  for (const event of events.quarantineEvents ?? []) {
    try {
      await auditWriter.append({
        runId: '',
        phase: 'state-migration',
        iteration: 0,
        eventType: event.eventType,
        payload: { ...event.payload },
        outcome: 'failure'
      });
    } catch (err) {
      logger.warn(`run-record-quarantined audit append failed: ${errorMessage(err)}`);
    }
  }
}
