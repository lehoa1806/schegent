// ---------------------------------------------------------------------------
// FR-R4-F15 (feature 243, contract C4) — the recorder the driver and the start-failure handler call.
//
// WHY NOTHING HERE CAN FAIL A RUN. A failure record is diagnostic content kept for an operator. The
// Run it describes has already failed and been persisted by the time `record()` is called, so a record
// that cannot be written changes nothing about the Run: not its status, its cause, its last error, the
// queue's `finish`, the audit events or the history entry. `record()` therefore catches everything,
// returns `false`, and says so once, by code. Its callers do not wrap it.
//
// What the warning may say: which step failed and an error code. Never a path, a name, a Run id, a
// summary or a message, because a filesystem error's message quotes the absolute path it addressed.
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import type { ReadFailureRecordRequest, ReadFailureRecordResponse } from '../../contracts/sidebar-ipc';
import type { SanitizedLogger } from '../../lib/logger';
import type { WorkspaceStateStore } from '../../state/workspace-state';
import { historyErrorCode } from '../history/error-code';
import { decideFailureRecordAnswer } from './failure-record-answer';
import { FailureRecordStore, type ReadNewestOutcome, type RecordWriteOperation } from './failure-record-store';
import { buildFailureRecord, type FailureRecordInput } from './record-builder';

export type { FailureRecordInput } from './record-builder';

export interface FailureRecorder {
  /** Never throws. `true` only when the whole record was written and closed. */
  record(input: FailureRecordInput): Promise<boolean>;
}

export interface FailureRecorderDeps {
  readonly logger: Pick<SanitizedLogger, 'warn' | 'sanitize'>;
  /** `queueIdForExistingTask` is the strict lookup: it returns `null` rather than a default queue. */
  readonly queue: { queueIdForExistingTask(taskId: string): string | null };
  readonly workspaceRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
  /** 8 lowercase hex characters. Tests inject a sequence to force and observe collisions. */
  readonly drawSuffix?: () => string;
  readonly store?: FailureRecordStore;
}

/** Which step a warning names: the two the recorder owns, or the one the store reports. */
type RecordOperation = 'identity' | 'build' | RecordWriteOperation;

const WARNING = 'failure-record: not written';
const SUFFIX_BYTES = 4;

function randomSuffix(): string {
  return randomBytes(SUFFIX_BYTES).toString('hex');
}

export function createFailureRecorder(deps: FailureRecorderDeps): FailureRecorder {
  const store = deps.store ?? new FailureRecordStore({ workspaceRoot: deps.workspaceRoot, logger: deps.logger });
  const now = deps.now ?? (() => new Date());
  const drawSuffix = deps.drawSuffix ?? randomSuffix;
  const platform = deps.platform ?? process.platform;

  function warnOnce(operation: RecordOperation, errorCode: string, cleanup?: 'failed'): false {
    try {
      deps.logger.warn(WARNING, cleanup === undefined ? { operation, errorCode } : { operation, errorCode, cleanup });
    } catch {
      // A sink that throws must not turn a diagnostic into a failure of the Run it describes.
    }
    return false;
  }

  return {
    async record(input: FailureRecordInput): Promise<boolean> {
      let operation: RecordOperation = 'identity';
      try {
        const queueId = deps.queue.queueIdForExistingTask(input.run.featureId);
        if (queueId === null) return warnOnce('identity', 'no-queue-row');
        operation = 'build';
        const record = buildFailureRecord(input, {
          queueId,
          failedAt: now().toISOString(),
          suffix: drawSuffix(),
          sanitize: (value) => deps.logger.sanitize(value),
          workspaceRoot: deps.workspaceRoot,
          platform
        });
        // An id that is not a name segment is an identity problem: nothing is written (research R5).
        if (record === null) return warnOnce('identity', 'invalid-id');
        operation = 'write';
        const result = await store.write(record, drawSuffix);
        if (result.ok) return true;
        return warnOnce(result.operation, result.errorCode, result.cleanup);
      } catch (error) {
        return warnOnce(operation, historyErrorCode(error));
      }
    }
  };
}

// ---------------------------------------------------------------------------
// FR-R4-F15 (contract Q3.4) — the read side: gather the facts about a row, then decide.
// ---------------------------------------------------------------------------

export interface FailureRecordAnswererDeps {
  readonly logger: Pick<SanitizedLogger, 'warn'>;
  readonly workspaceRoot: string;
  /** The requesting window's own state: a pair this window does not hold is an unknown row. */
  readonly state: Pick<WorkspaceStateStore, 'getQueue' | 'getHistoryMap'>;
  /** The session sweep's age setting, as the sweep normalizes it, read at request time. */
  readonly maxAgeMs: () => number;
  readonly now?: () => Date;
  readonly store?: FailureRecordStore;
}

export interface FailureRecordAnswerer {
  /** Never throws: a failure of any step is the `internal-error` answer, with one warning of a code. */
  answer(request: ReadFailureRecordRequest): Promise<ReadFailureRecordResponse>;
}

/**
 * Whether history holds an entry for `runId` whose terminal status is `failed`. History keeps one
 * entry per Run and terminal status, so a Run that failed and was then resumed to completion has both,
 * until the per-queue cap evicts the older (research R11).
 */
function historyHoldsFailedEntry(
  state: FailureRecordAnswererDeps['state'],
  queueId: string,
  runId: string
): boolean {
  const entries: readonly unknown[] = state.getHistoryMap()[queueId] ?? [];
  return entries.some((entry) => {
    const candidate = entry as { runId?: unknown; terminalStatus?: unknown };
    return candidate.runId === runId && candidate.terminalStatus === 'failed';
  });
}

export function createFailureRecordAnswerer(deps: FailureRecordAnswererDeps): FailureRecordAnswerer {
  const store = deps.store ?? new FailureRecordStore({ workspaceRoot: deps.workspaceRoot, logger: deps.logger });
  const now = deps.now ?? (() => new Date());

  return {
    async answer(request: ReadFailureRecordRequest): Promise<ReadFailureRecordResponse> {
      try {
        const row = deps.state.getQueue(request.queueId).requests.find((candidate) => candidate.id === request.taskId) ?? null;
        // A row with no Run has nothing on disk to find, so no directory is listed for it.
        const hasRun = row !== null && row.runId !== null;
        const newest: ReadNewestOutcome = hasRun ? await store.readNewest(row.runId as string) : { outcome: 'none' };
        return decideFailureRecordAnswer({
          queueId: request.queueId,
          taskId: request.taskId,
          row,
          newest,
          historyHasFailedEntry: hasRun && historyHoldsFailedEntry(deps.state, request.queueId, row.runId as string),
          maxAgeMs: deps.maxAgeMs(),
          nowMs: now().getTime()
        });
      } catch (error) {
        try {
          deps.logger.warn('failure-record: answer failed', { errorCode: historyErrorCode(error) });
        } catch {
          // A sink that throws must not turn a read into an unhandled rejection.
        }
        return { outcome: 'failure', reason: 'internal-error' };
      }
    }
  };
}
