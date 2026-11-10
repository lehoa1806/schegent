// FR-R4-F08 (FR-006, L1) — the phase log's row cap, where both ends can reach it.
//
// WHY IT LIVES HERE
//
// The host's phase-log service has capped one read at 500 rows since feature 020,
// as a private constant. The webview's live tail has to keep to the same number:
// a read that shows 500 rows and a live window that grows past them would be two
// answers to "how many rows may this log show". The webview may value-import only
// from `src/contracts/` (`webview-host-import-direction`), so the number moves
// here rather than being copied, and `queue-bounds.ts` is the precedent for a
// value both ends read.
//
// This module imports nothing, on purpose. It is a leaf.

/**
 * The most rows a phase-log read or the webview's live tail window may show,
 * the `truncated-head` marker included.
 *
 * Two consumers: the host service (`phase-log-service.ts`) applies it as the
 * default cap of one read, and the webview window (`phase-log-window.ts`) keeps
 * one less than this many entries so that its entries plus its marker equal it.
 */
export const PHASE_LOG_MAX_ENTRIES = 500;

// FR-R6-F07 (FR-009, NFR-001..004) — the byte bounds of live-log delivery.
//
// Every buffer between the retained `stream.jsonl` and the visible window has a
// bound in UTF-8 bytes, measured on the serialized form that crosses the
// boundary. They sit here, beside the row cap, because the webview's window
// reads the visible bound and the host reads the rest; one definition for both.

/** Largest partial record the framer retains before it discards to the next newline. */
export const LIVE_LOG_RESIDUAL_MAX_BYTES = 262144;

/** Room an entry leaves for the batch envelope, so one maximal entry always fits a batch. */
export const LIVE_LOG_ENTRY_ENVELOPE_RESERVE_BYTES = 1024;

/** Largest serialized display entry. */
export const LIVE_LOG_ENTRY_MAX_BYTES = 262144 - LIVE_LOG_ENTRY_ENVELOPE_RESERVE_BYTES;

/** Largest serialized batch message, envelope included. */
export const LIVE_LOG_BATCH_MAX_BYTES = 262144;

/** Most serialized bytes posted to one consumer and not yet acknowledged. */
export const LIVE_LOG_PENDING_MAX_BYTES = 1048576;

/** Most serialized bytes the visible window holds, the head marker included. */
export const LIVE_LOG_VISIBLE_MAX_BYTES = 4194304;

/** Most source bytes one replay pass reads; a larger backlog is skipped with a counted gap. */
export const LIVE_LOG_REPLAY_PASS_MAX_BYTES = 8388608;

/** Size of one source read. */
export const LIVE_LOG_READ_CHUNK_BYTES = 262144;

/** Version of the batch protocol; the webview applies nothing from another version. */
export const LIVE_LOG_PROTOCOL_VERSION = 1;

/** Value at which every delivery counter saturates (2^31 - 1). */
export const LIVE_LOG_COUNTER_MAX = 2147483647;

/**
 * FR-R6-F07 (FR-012) — the closed list of reasons a coverage-gap row can carry.
 * Each names a distinct situation with a distinct operator response.
 */
export const LIVE_LOG_COVERAGE_REASONS = Object.freeze([
  'capture-disabled',
  'not-yet-produced',
  'parse-omission',
  'oversized-record',
  'display-truncation',
  'artifact-expired',
  'permission-refused',
  'transport-gap',
  'source-replaced',
  'range-skipped'
] as const);

export type LiveLogCoverageReason = (typeof LIVE_LOG_COVERAGE_REASONS)[number];
