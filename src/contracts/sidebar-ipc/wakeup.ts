import type {
  CMD_READ_WAKEUP_SESSION_LOG,
  CMD_REVEAL_WAKEUP_SESSION_LOG,
  CommandBase
} from '../sidebar-ipc';

// The host validates the correlation identifier against its invocation log
// before composing a host-owned session path.
export interface ReadWakeupSessionLogCommand
  extends CommandBase<typeof CMD_READ_WAKEUP_SESSION_LOG> {
  readonly payload: { readonly correlationId: string };
}

export interface ReadWakeupSessionLogResponseSuccess {
  readonly status: 'success';
  readonly correlationId: string;
  readonly capturedAtMs: number;
  readonly trigger: 'scheduled' | 'manual';
  readonly model: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly fullBlockBytesOnDisk: number;
}

export interface ReadWakeupSessionLogResponseRejected {
  readonly status: 'rejected';
  readonly reason:
    | 'not-primary-host'
    | 'invalid-correlation-id'
    | 'unknown-correlation-id'
    | 'session-log-unavailable'
    | 'unknown-error';
}

export type ReadWakeupSessionLogResponse =
  | ReadWakeupSessionLogResponseSuccess
  | ReadWakeupSessionLogResponseRejected;

export interface RevealWakeupSessionLogCommand
  extends CommandBase<typeof CMD_REVEAL_WAKEUP_SESSION_LOG> {
  readonly payload?: Record<string, never>;
}

export interface RevealWakeupSessionLogResponseSuccess {
  readonly status: 'success';
}

export interface RevealWakeupSessionLogResponseRejected {
  readonly status: 'rejected';
  readonly reason:
    | 'not-primary-host'
    | 'session-log-unavailable'
    | 'reveal-failed'
    | 'unknown-error';
}

export type RevealWakeupSessionLogResponse =
  | RevealWakeupSessionLogResponseSuccess
  | RevealWakeupSessionLogResponseRejected;
