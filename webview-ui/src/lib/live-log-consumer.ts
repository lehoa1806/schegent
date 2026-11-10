// FR-R6-F07 (FR-004, FR-009, FR-011) — how the webview applies one live-log
// batch from the host.
//
// `applyLiveLogBatch` is pure. Given what the consumer has applied so far and
// one batch, it returns the entries to show, the acknowledgement to send and
// the consumer's next state. The store owns the state and the sending.
//
// The rules are the contract's (`live-log-ipc.md`):
//   - a batch number at or below the last applied one is a duplicate: apply
//     nothing and report it;
//   - a `continue` batch past the next number is a gap: ask once for a resync
//     and ignore every `continue` batch until a `resume` or `reset` arrives;
//   - `resume` restarts the sequence; `reset` also clears the applied position,
//     and the view replaces what it shows;
//   - within one generation, an entry at or before the applied `(at, n)` is
//     skipped;
//   - a terminal `tail-ended` entry ends the session and is never acknowledged,
//     even when it arrives out of sequence: the session is over either way.
//
// The module takes its types as types only and value-imports only from
// `src/contracts/`, as `phase-log-window.ts` does.

import { LIVE_LOG_PROTOCOL_VERSION } from '../../../src/contracts/phase-log-bounds.js';
import type { PhaseLogDisplayEntry } from '../../../src/services/phase-log/types.js';
import type { AckPhaseLogTailRequest, PhaseLogBatchPayload } from './messages.js';

/** What the view shows when the host speaks a live-log protocol this view does not. */
export const LIVE_LOG_INCOMPATIBLE_TEXT =
  'This view and the extension use different live-log versions, so new entries are not shown. Reload the window.';

/** A batch as it arrives: the protocol is checked here, so it is any number. */
export type LiveLogBatchInput = Omit<PhaseLogBatchPayload, 'protocol'> & { readonly protocol: number };

export interface LiveLogAppliedPosition {
  readonly generation: string;
  readonly at: number;
  readonly n: number;
}

export interface LiveLogConsumerState {
  /** The last batch applied; 0 before the first, which is the ready ack's number. */
  readonly lastBatchSeq: number;
  readonly position: LiveLogAppliedPosition | null;
  /** A resync was asked for; `continue` batches are ignored until a `resume` or `reset`. */
  readonly awaitingResync: boolean;
}

export type LiveLogAck = Omit<AckPhaseLogTailRequest, 'sessionId'>;

export type LiveLogBatchVerdict =
  | { readonly kind: 'incompatible' }
  | {
      readonly kind: 'ignored';
      readonly state: LiveLogConsumerState;
      readonly ack: LiveLogAck | null;
    }
  | {
      readonly kind: 'apply';
      readonly state: LiveLogConsumerState;
      readonly replace: boolean;
      readonly entries: readonly PhaseLogDisplayEntry[];
      readonly ended: boolean;
      /** The cursor to keep after applying; null when the batch passed no boundary. */
      readonly cursor: string | null;
      readonly ack: LiveLogAck | null;
    };

export const FRESH_CONSUMER_STATE: LiveLogConsumerState = Object.freeze({
  lastBatchSeq: 0,
  position: null,
  awaitingResync: false
});

function isAfter(at: number, n: number, position: LiveLogAppliedPosition): boolean {
  return at > position.at || (at === position.at && n > position.n);
}

/** Decides what one batch does to the view. */
export function applyLiveLogBatch(
  state: LiveLogConsumerState,
  batch: LiveLogBatchInput
): LiveLogBatchVerdict {
  if (batch.protocol !== LIVE_LOG_PROTOCOL_VERSION) return { kind: 'incompatible' };
  const outOfSequence = sequenceVerdict(state, batch);
  if (outOfSequence === null) return applyEntries(state, batch);
  if (!batch.entries.some((item) => item.entry.kind === 'tail-ended')) return outOfSequence;
  return { kind: 'apply', state, replace: false, entries: [], ended: true, cursor: null, ack: null };
}

/** Null when the batch is next in sequence; otherwise the duplicate or gap verdict. */
function sequenceVerdict(
  state: LiveLogConsumerState,
  batch: LiveLogBatchInput
): Extract<LiveLogBatchVerdict, { kind: 'ignored' }> | null {
  if (batch.batchSeq <= state.lastBatchSeq) {
    return { kind: 'ignored', state, ack: { batchSeq: batch.batchSeq, duplicate: true } };
  }
  if (batch.mode !== 'continue') return null;
  if (state.awaitingResync) return { kind: 'ignored', state, ack: null };
  if (batch.batchSeq === state.lastBatchSeq + 1) return null;
  return {
    kind: 'ignored',
    state: { ...state, awaitingResync: true },
    ack: { batchSeq: state.lastBatchSeq, resync: true }
  };
}

function applyEntries(state: LiveLogConsumerState, batch: LiveLogBatchInput): LiveLogBatchVerdict {
  const replace = batch.mode === 'reset';
  const sameStream = !replace && state.position?.generation === batch.generation;
  let position = sameStream ? state.position : null;
  const entries: PhaseLogDisplayEntry[] = [];
  let ended = false;
  for (const item of batch.entries) {
    if (item.entry.kind === 'tail-ended') {
      ended = true;
      continue;
    }
    if (position !== null && !isAfter(item.at, item.n, position)) continue;
    entries.push(item.entry as PhaseLogDisplayEntry);
    position = { generation: batch.generation, at: item.at, n: item.n };
  }
  return {
    kind: 'apply',
    state: { lastBatchSeq: batch.batchSeq, position, awaitingResync: false },
    replace,
    entries,
    ended,
    cursor: batch.toCursor,
    ack: ended ? null : { batchSeq: batch.batchSeq }
  };
}
