// FR-R3-132 (T1502) — the terminal status a history entry records, as a contract.
//
// It was declared in `src/state/history-entry.ts` and restated inline in
// `webview-ui/src/lib/snapshot-types.ts` as `'completed' | 'failed' | 'canceled'`,
// which is one of seven named host unions the mirror had spelled out by hand
// rather than imported. The members happened to match; nothing kept them matching,
// and `QueueSummary.pauseSource` is what that looks like when it stops.
//
// Moved rather than allowlisted. `webview-host-import-direction.test.ts` permits a
// type-only import from a non-contract module on a dated allowlist whose own
// comment says the list is *"expected to shrink as shapes move into
// `contracts/`"* — adding an entry to import a three-member union would have grown
// it in the wrong direction. This is the same argument `FR-R3-110` made when it
// moved two queue identities here instead of allowlisting them.
//
// A terminal status is contract-shaped on the merits too: it is persisted, it
// crosses the IPC boundary, and both sides must agree on what the values are.
export type HistoryTerminalStatus = 'completed' | 'failed' | 'canceled';
