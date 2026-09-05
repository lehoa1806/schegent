import type {
  CMD_READ_PHASE_LOG,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL,
  CommandBase
} from '../sidebar-ipc';
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

export interface ReadPhaseLogCommand extends CommandBase<typeof CMD_READ_PHASE_LOG> {
  readonly payload: ReadPhaseLogRequest;
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
            | 'tail-ended';
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
}

export interface StartPhaseLogTailCommand
  extends CommandBase<typeof CMD_START_PHASE_LOG_TAIL> {
  readonly payload: StartPhaseLogTailRequest;
}

export type StartPhaseLogTailResponse =
  | {
      readonly outcome: 'success';
      readonly sessionId: string;
      readonly mechanism: 'fs.watch' | 'polling';
    }
  | {
      readonly outcome: 'failure';
      readonly reason:
        | 'unknown-tuple'
        | 'not-in-flight'
        | 'permission-denied'
        | 'internal-error';
    };

export interface StopPhaseLogTailRequest {
  readonly sessionId: string;
}

export interface StopPhaseLogTailCommand
  extends CommandBase<typeof CMD_STOP_PHASE_LOG_TAIL> {
  readonly payload: StopPhaseLogTailRequest;
}

export interface StopPhaseLogTailResponse {
  readonly outcome: 'success' | 'failure';
  readonly sessionId: string;
  readonly reason?: 'unknown-session' | 'internal-error';
}
