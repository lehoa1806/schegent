// FR-R4-F05 (FR-025) — how long, and how many, command outcomes the host keeps so
// that a repeat of the same correlation id gets the same answer.
//
// WHY ONE MODULE. The host's replay cache (`MutationCommandExecutor`) and the
// webview's intent ledger (`webview-ui/src/lib/intent-ledger.ts`) protect the
// same thing from two sides: an operator who repeats a slow action. The host
// side only helps while it still remembers the first outcome, and the webview
// side must stop reusing an identity once the host has forgotten it, or a retry
// would be sent under an id the host treats as new while the operator believes
// it is the old one. Two literals could drift apart; one constant pair cannot.
//
// WHAT IT IS NOT. This is risk reduction, not exactly-once delivery. A host
// restart, a webview reload or a different panel starts a new action, and so
// does either bound below. `docs/reference/api-and-cli.md` says so beside the
// webview boundary table.
//
// This module imports nothing, on purpose. It is a leaf, and the webview bundle
// may import it the way `metrics-ipc.ts` imports a host contract.

/**
 * One hour — how long the host remembers a command's first outcome, and how long
 * the webview reuses an identity, both measured from the first send. Repeat
 * protection ends here (FR-025): a repeat after it is a new action.
 */
export const ACK_RETENTION_MS = 60 * 60 * 1000;

/**
 * The most outcomes the host keeps at once; the oldest is dropped first. Repeat
 * protection ends for an outcome that falls out at this bound before
 * `ACK_RETENTION_MS` elapses (FR-025). Gated reads count toward it, because each
 * is remembered with its result.
 */
export const ACK_RETENTION_MAX_ENTRIES = 1_000;
