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
