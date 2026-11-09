import type { AuditLogWriter } from '../../audit/audit-log-writer';
import type { ArtifactLifecycleMutationPayload } from '../../contracts/artifact-lifecycle/audit-payload';
import { historyErrorCode } from '../history/error-code';
import type { LifecycleAuditRecord, LifecycleAuditSink } from './mutation-authority';

// FR-R6-F05 (FR-022, T044) — the lifecycle service's audit sink, adapted onto the existing audit
// writer. Each mutation becomes one system-scoped `artifact-lifecycle-mutation` row whose payload is
// the record's metadata and nothing else.
//
// The sink is synchronous because the service records the row inside its effect step; the writer's
// append is asynchronous, so the adapter starts it and observes the settlement. A failed append is
// logged by error code only (never the caught message, which can quote the log path) and reported to
// `onAppendFailed`, which the composition root points at the audit-health latch so the next mutation
// is refused `audit-unhealthy` (the service gate's third check).

/** The narrow logger this adapter needs. */
export interface LifecycleAuditLogger {
  warn(message: string): void;
}

export interface LifecycleAuditSinkOptions {
  readonly writer: Pick<AuditLogWriter, 'append'>;
  readonly logger: LifecycleAuditLogger;
  readonly onAppendFailed?: (() => void) | undefined;
}

const SYSTEM_RUN_ID = 'system';

function outcomeOf(result: LifecycleAuditRecord['result']): 'success' | 'failure' | 'info' {
  if (result === 'completed' || result === 'resumed') return 'success';
  if (result === 'partial') return 'failure';
  return 'info';
}

function payloadOf(record: LifecycleAuditRecord): ArtifactLifecycleMutationPayload {
  return {
    operationKind: record.operationKind,
    operationId: record.operationId,
    counts: { ...record.counts },
    result: record.result
  };
}

/** Adapts the existing audit writer to the lifecycle service's `LifecycleAuditSink` port. */
export function createLifecycleAuditSink(options: LifecycleAuditSinkOptions): LifecycleAuditSink {
  const { writer, logger, onAppendFailed } = options;
  return {
    recordLifecycleMutation(record) {
      const appended = writer.append({
        runId: SYSTEM_RUN_ID,
        phase: 'done',
        iteration: 0,
        eventType: 'artifact-lifecycle-mutation',
        outcome: outcomeOf(record.result),
        payload: { ...payloadOf(record) }
      });
      appended.catch((err: unknown) => {
        logger.warn(`artifact lifecycle: audit append failed: ${historyErrorCode(err)}`);
        onAppendFailed?.();
      });
    }
  };
}
