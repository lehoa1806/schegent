// Feature 203 (FR-005, FR-022, D6, V2) — the banner has exactly one definition,
// in the service module that also produces it. The member is produced host-side
// and crosses the boundary as part of the answer, so the boundary states the
// shape by importing it rather than by restating it. The restatement below had
// already drifted: it typed `settingKey` as `string` where the host declares the
// literal `'schegent.logging.verbose'`. Importing resolves that by construction
// — after this the two cannot disagree. Precedent:
// `src/contracts/sidebar-ipc/process-yaml.ts:21`, qualified because two files in
// this tree are named `process-yaml.ts` and both are long enough to hold line 21.
import type { VerboseDiagnosticsBanner } from '../../services/phase-log/types';

export type {
  ReadPhaseLogCommand,
  StartPhaseLogTailCommand,
  AckPhaseLogTailCommand,
  StopPhaseLogTailCommand,
  PhaseLogWireEntry,
  LiveLogBatchEntry,
  LiveLogBatchMode,
  PhaseLogBatchPayload
} from '../generated/sidebar-ipc-types';

// Selection fields are identifiers only. Host-owned snapshot data resolves
// filesystem paths after validation at the IPC boundary.
export interface ReadPhaseLogRequest {
  readonly selection: {
    readonly queueId: string;
    readonly taskId: string;
    readonly pipelineId: string;
    readonly phaseId: string;
    readonly iterationN: number | null;
  };
}

export type ReadPhaseLogResponse =
  | {
      readonly outcome: 'success';
      readonly manifest: {
        readonly iterations: readonly number[];
        readonly selectedIteration: number | null;
        readonly entries: readonly {
          readonly seq: number;
          readonly kind:
            | 'assistant-text'
            | 'tool-use'
            | 'tool-result'
            | 'system'
            | 'result'
            | 'truncated-head'
            | 'tail-ended'
            | 'coverage-gap';
          readonly ts: string | null;
          readonly body: Readonly<Record<string, unknown>>;
          readonly bodyTruncated: Readonly<
            Record<string, { readonly originalLength: number }>
          > | null;
        }[];
        readonly skippedLines: number;
        readonly truncatedCount: number;
        readonly verboseDiagnosticsState: VerboseDiagnosticsBanner;
        readonly isInFlight: boolean;
        // FR-R6-F07 (FR-001) — where a live subscription continues from: the
        // end of the last complete, projector-idle record this read covered.
        // Null when there is no file. Optional so an older manifest still reads.
        readonly cursor?: string | null;
      };
    }
  | {
      readonly outcome: 'failure';
      readonly reason: 'unknown-tuple' | 'permission-denied' | 'internal-error';
    };

export interface StartPhaseLogTailRequest {
  readonly selection: {
    readonly queueId: string;
    readonly taskId: string;
    readonly pipelineId: string;
    readonly phaseId: string;
    readonly iterationN: number;
  };
  /**
   * FR-R6-F07 (NFR-003) — the consumer slot. `dashboard` when absent. Any name
   * other than the two slots is answered with `busy`.
   */
  readonly consumer?: string;
  /** FR-R6-F07 (FR-001, FR-002) — an opaque cursor; never read authority. */
  readonly fromCursor?: string;
}

export type StartPhaseLogTailResponse =
  | {
      readonly outcome: 'success';
      readonly sessionId: string;
      readonly mechanism: 'fs.watch' | 'polling';
      // FR-R6-F07 (FR-001) — delivery begins at `snapshotCutoff`; `nextCursor`
      // is the cursor of the first batch's start. Protocol 1 sets both to the
      // same position.
      readonly snapshotCutoff: string;
      readonly nextCursor: string;
      readonly cursorStatus: PhaseLogCursorStatus;
    }
  | {
      readonly outcome: 'failure';
      readonly reason:
        | 'unknown-tuple'
        | 'not-in-flight'
        | 'permission-denied'
        | 'internal-error'
        | 'busy'
        | 'consumer-unavailable';
    };

/** FR-R6-F07 — what the host made of the start request's `fromCursor`. */
export type PhaseLogCursorStatus = 'accepted' | 'reset' | 'unknown-version' | 'none';

/** FR-R6-F07 (FR-009) — batch credit, gap requests and duplicate reports. */
export interface AckPhaseLogTailRequest {
  readonly sessionId: string;
  /** 0 is the ready ack; n acknowledges batch n and everything before it. */
  readonly batchSeq: number;
  readonly resync?: boolean;
  readonly duplicate?: boolean;
}

export interface AckPhaseLogTailResponse {
  readonly outcome: 'success' | 'failure';
  readonly sessionId: string;
  readonly reason?: 'unknown-session';
}

/** FR-R6-F07 (FR-014) — counts only, each an integer saturating at 2^31-1. */
export interface PhaseLogTailCounters {
  readonly omittedBytes: number;
  readonly omittedRecords: number;
  readonly duplicateBatches: number;
  readonly replayAttempts: number;
  readonly deliveryGaps: number;
  readonly sourceResets: number;
}

export interface StopPhaseLogTailRequest {
  readonly sessionId: string;
}

export interface StopPhaseLogTailResponse {
  readonly outcome: 'success' | 'failure';
  readonly sessionId: string;
  readonly reason?: 'unknown-session' | 'internal-error';
  /** FR-R6-F07 (FR-014) — present on success. */
  readonly counters?: PhaseLogTailCounters;
}
