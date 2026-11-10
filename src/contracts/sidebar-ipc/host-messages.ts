import type { CMD_ACK, MSG_PHASE_LOG_BATCH, STATE_SNAPSHOT } from '../sidebar-ipc';
import type { PhaseLogBatchPayload } from './phase-log';
import type { CommandAckOutcome } from '../command-outcome';
import type { SnapshotSyncMeta } from '../snapshot-bounds';

export interface StateSnapshotMessage<S> {
  readonly type: typeof STATE_SNAPSHOT;
  readonly payload: S;
  readonly sync?: SnapshotSyncMeta;
}

export interface CommandAckMessage {
  readonly type: typeof CMD_ACK;
  readonly correlationId: string;
  readonly status: 'accepted' | 'rejected';
  // FR-R3-154 (T1646) — Additive and optional: absent means the route reports
  // only the binary status, which is every route this batch did not touch.
  // Where present, it refines the status rather than contradicting it —
  // `accepted` pairs only with `status: 'accepted'`, and the other three only
  // with `'rejected'` — so a reader that knows nothing about `outcome` still
  // reads the same answer it always did. See `src/contracts/command-outcome.ts`
  // for why a no-op is a rejection here.
  readonly outcome?: CommandAckOutcome;
  readonly reason?: string;
  readonly result?: unknown;
}

// FR-R6-F07 (FR-004, FR-008) — sanitized, budgeted entries with their source
// positions; at most 256 KiB serialized. Consumers drop a superseded session's
// batches and deduplicate entries by position.
export interface PhaseLogBatchPushMessage {
  readonly type: typeof MSG_PHASE_LOG_BATCH;
  readonly payload: PhaseLogBatchPayload;
}

export type HostMessage<S> =
  | StateSnapshotMessage<S>
  | CommandAckMessage
  | PhaseLogBatchPushMessage;
