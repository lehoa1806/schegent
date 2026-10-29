// ---------------------------------------------------------------------------
// FR-R4-F16 (feature 244, contract A1; research R8) — the pure builder that turns parsed audit lines
// into the compact `CensusLog` (pass 1 of the failed-row census).
//
// Pure. It holds no file, path or clock: the reader feeds it lines and markers, in log order, and
// `finish()` returns the log. Of every entry it keeps only the seven census event types, each reduced
// to the closed fields of data-model §3. It reads no `title`, `description`, `lastError`,
// `lastErrorSummary`, `stateTransition`, actor, `correlationId` or path-bearing key, so none of them
// can reach the result, and memory follows the number of census events, not the number of lines.
//
// A line or entry the census cannot use is never dropped silently: it becomes a `gap` marker in the
// order it was met, and the coverage counts say how many. An unparseable or malformed marker waits
// for the stamp of the next parsed entry, so pass 2 can tell damage before the cutoff (which may hide
// an event it needs) from damage after it (which cannot).
// ---------------------------------------------------------------------------

import type { ParseAuditLineResult } from '../../parser/audit-log-parser';
import { isCompletionProvenance } from '../../contracts/completion-provenance';
import { isFailureCause } from '../../contracts/failure-cause';
import type { CensusEvent, CensusLog, CensusProvenance } from './census-model';

type UnparseableGap = Extract<CensusEvent, { kind: 'gap'; cause: 'unparseable' | 'malformed' }>;

const PROVENANCE_KEY = 'completionProvenance';

/** Methods the reader calls, in log order. */
export interface CensusLogBuilder {
  /** One parsed line: an entry, or a null entry with or without a warning. */
  line(result: ParseAuditLineResult): void;
  /** One cut record met. */
  cut(): void;
  /** One line of the cut file: a cut record when `valid`, an unparseable line otherwise. */
  cutFileLine(valid: boolean): void;
  /** One line the reader could not parse, such as one the framer cut at its limit. */
  unparseable(): void;
  /** One segment of the chain that could not be opened or read. */
  unreadableSegment(): void;
  /** One archive or live log read to its end. */
  segmentRead(): void;
  /** Names beside the log that were counted and never opened. */
  unrecognizedNames(count: number): void;
  finish(): CensusLog;
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function provenanceOf(payload: Record<string, unknown>): CensusProvenance {
  if (!Object.prototype.hasOwnProperty.call(payload, PROVENANCE_KEY)) return 'absent';
  const value = payload[PROVENANCE_KEY];
  if (value === null) return 'null';
  return isCompletionProvenance(value) ? 'attested' : 'absent';
}

export function createCensusLogBuilder(): CensusLogBuilder {
  const events: CensusEvent[] = [];
  /** Indexes of unparseable or malformed markers still waiting for the next parsed entry's stamp. */
  let openGaps: number[] = [];
  let segmentsRead = 0;
  let unreadableSegments = 0;
  let cutRecords = 0;
  let unparseableLines = 0;
  let malformedCensusEntries = 0;
  let backwardsStamps = 0;
  let oldestStampMs: number | null = null;
  let newestStampMs: number | null = null;
  let unrecognized = 0;
  let firstProvenanceRemovalMs: number | null = null;
  let previousStampMs: number | null = null;

  const nextSeq = (): number => events.length;

  const pushGap = (cause: UnparseableGap['cause']): void => {
    openGaps.push(events.length);
    events.push({ kind: 'gap', seq: nextSeq(), cause, nextStampMs: null });
  };

  const unparseable = (): void => {
    unparseableLines += 1;
    pushGap('unparseable');
  };

  const malformed = (): void => {
    unparseableLines += 1;
    malformedCensusEntries += 1;
    pushGap('malformed');
  };

  const fillOpenGaps = (stampMs: number): void => {
    for (const index of openGaps) {
      const gap = events[index] as UnparseableGap;
      events[index] = { ...gap, nextStampMs: stampMs };
    }
    openGaps = [];
  };

  const cut = (): void => {
    cutRecords += 1;
    events.push({ kind: 'gap', seq: nextSeq(), cause: 'cut' });
  };

  /** One census event from `payload`, or `false` when the entry lacks a field the event needs. */
  const addCensusEvent = (eventType: string, stampMs: number, payload: Record<string, unknown>): boolean => {
    const seq = nextSeq();
    switch (eventType) {
      case 'task-execution-ended': {
        const taskId = stringField(payload, 'taskId');
        const runId = stringField(payload, 'runId');
        const terminalStatus = stringField(payload, 'terminalStatus');
        if (taskId === null || runId === null || terminalStatus === null) return false;
        const failureCause = payload.failureCause;
        events.push({
          kind: 'ended',
          seq,
          stampMs,
          runId,
          taskId,
          failed: terminalStatus === 'failed',
          cause: isFailureCause(failureCause) ? failureCause : 'not-recorded'
        });
        return true;
      }
      case 'task-execution-started': {
        const taskId = stringField(payload, 'taskId');
        const runId = stringField(payload, 'runId');
        const queueId = stringField(payload, 'queueId');
        const isResume = payload.isResume;
        if (taskId === null || runId === null || queueId === null || typeof isResume !== 'boolean') {
          return false;
        }
        events.push({ kind: 'started', seq, stampMs, runId, taskId, queueId, isResume });
        return true;
      }
      case 'task-removed': {
        const taskId = stringField(payload, 'taskId');
        const queueId = payload.queueId;
        if (taskId === null) return false;
        if (queueId !== undefined && queueId !== null && typeof queueId !== 'string') return false;
        if (firstProvenanceRemovalMs === null && Object.prototype.hasOwnProperty.call(payload, PROVENANCE_KEY)) {
          firstProvenanceRemovalMs = stampMs;
        }
        events.push({
          kind: 'removed',
          seq,
          stampMs,
          taskId,
          queueId: typeof queueId === 'string' ? queueId : null,
          runId: stringField(payload, 'runId'),
          priorStatus: stringField(payload, 'priorStatus'),
          provenance: provenanceOf(payload)
        });
        return true;
      }
      case 'task-moved': {
        const taskId = stringField(payload, 'taskId');
        const toQueueId = stringField(payload, 'queueId');
        if (taskId === null || toQueueId === null) return false;
        events.push({ kind: 'moved', seq, stampMs, taskId, toQueueId });
        return true;
      }
      case 'queue-deleted':
      case 'queue-cleared': {
        const queueId = stringField(payload, 'queueId');
        if (queueId === null) return false;
        events.push({ kind: eventType, seq, stampMs, queueId });
        return true;
      }
      case 'queue-cleared-all':
        events.push({ kind: 'queue-cleared-all', seq, stampMs });
        return true;
      default:
        return true;
    }
  };

  return {
    line(result) {
      const { entry } = result;
      if (entry === null) {
        if (result.warning !== undefined) unparseable();
        return;
      }
      const stampMs = Date.parse(entry.timestamp);
      if (!Number.isFinite(stampMs)) {
        unparseable();
        return;
      }
      oldestStampMs = oldestStampMs === null ? stampMs : Math.min(oldestStampMs, stampMs);
      newestStampMs = newestStampMs === null ? stampMs : Math.max(newestStampMs, stampMs);
      if (previousStampMs !== null && stampMs < previousStampMs) backwardsStamps += 1;
      previousStampMs = stampMs;
      fillOpenGaps(stampMs);
      if (!addCensusEvent(entry.eventType, stampMs, entry.payload)) malformed();
    },
    cut,
    cutFileLine(valid) {
      if (valid) cut();
      else unparseable();
    },
    unparseable,
    unreadableSegment() {
      unreadableSegments += 1;
      events.push({ kind: 'gap', seq: nextSeq(), cause: 'unreadable-segment' });
    },
    segmentRead() {
      segmentsRead += 1;
    },
    unrecognizedNames(count) {
      unrecognized += count;
    },
    finish() {
      return {
        events: [...events],
        segmentsRead,
        unreadableSegments,
        cutRecords,
        unparseableLines,
        malformedCensusEntries,
        backwardsStamps,
        oldestStampMs,
        newestStampMs,
        unrecognizedNames: unrecognized,
        firstProvenanceRemovalMs
      };
    }
  };
}
