import type { CMD_ACK, MSG_PHASE_LOG_ENTRY, STATE_SNAPSHOT } from '../sidebar-ipc';

export interface StateSnapshotMessage<S> {
  readonly type: typeof STATE_SNAPSHOT;
  readonly payload: S;
}

export interface CommandAckMessage {
  readonly type: typeof CMD_ACK;
  readonly correlationId: string;
  readonly status: 'accepted' | 'rejected';
  readonly reason?: string;
  readonly result?: unknown;
}

// Live phase-log entries are sanitized and bounded before crossing the IPC
// boundary. Consumers discard entries for superseded tail session IDs.
export interface PhaseLogEntryPushMessage {
  readonly type: typeof MSG_PHASE_LOG_ENTRY;
  readonly payload: {
    readonly tailSessionId: string;
    readonly entrySeq: number;
    readonly entry: {
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
    };
  };
}

export type HostMessage<S> =
  | StateSnapshotMessage<S>
  | CommandAckMessage
  | PhaseLogEntryPushMessage;
