import type {
  CMD_READ_PHASE_LOG,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL,
  CommandBase
} from '../sidebar-ipc';

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
        readonly verboseDiagnosticsState:
          | { readonly kind: 'enabled-with-sessions' }
          | { readonly kind: 'enabled-no-sessions-for-tuple' }
          | { readonly kind: 'disabled-no-sessions'; readonly settingKey: string };
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
