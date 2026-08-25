import type { CMD_RESOLVE_HISTORY_DESCRIPTION, CommandBase } from '../sidebar-ipc';

// FR-R3-071 (feature 152) — the sidebar's half of history description replay.
//
// FR-R3-010 moved the full sanitized description out of the memento into a
// sidecar, and the history projection deliberately carries only the 80-char
// preview so a snapshot cannot grow with operator text. That is correct for a
// LIST. It is wrong for the one surface that submits a description back: the
// "Repeat this run" panel seeded its launcher from the preview, so an operator
// repeating a run replayed a truncation — the same defect the two host replay
// commands had, on the surface they actually use.
//
// So the wire carries an identifier and the host resolves, exactly as
// `CMD_RESOLVE_AUDIT_POINTER` does for evidence: the webview names a run, the
// host reads the sidecar through the single description resolver, and the
// answer comes back on the ack. Read-only — it MUST stay out of
// `MUTATING_COMMANDS`, and it takes no primacy gate, because reading a
// completed Run's own description is not a mutation and a secondary window is
// entitled to it.
//
// No filesystem path crosses this boundary. The response carries the sanitized
// TEXT the recorder wrote — sanitize-once (FR-029): it is already redacted at
// `buildHistoryEntry` and must not be re-sanitized here or in the renderer.
export interface ResolveHistoryDescriptionRequest {
  readonly runId: string;
}

export interface ResolveHistoryDescriptionCommand
  extends CommandBase<typeof CMD_RESOLVE_HISTORY_DESCRIPTION> {
  readonly payload: ResolveHistoryDescriptionRequest;
}

/**
 * The four resolver outcomes, plus the failure arm the boundary needs.
 *
 * `resolved` and `legacy` both carry the authored description and are the two
 * the panel prefills from — they are kept apart rather than merged because the
 * pair is what tells an operator (and a later reader of this contract) whether
 * the sidecar answered or the entry predates it, which is the distinction
 * FR-R3-010's migration is judged by.
 *
 * `missing` and `unreadable` are ANSWERS, not refusals: the description was
 * swept, never written, or could not be read. The panel keeps its existing
 * preview-plus-extent-note behaviour for both, which is already honest. They
 * ack as `accepted` for the same reason the evidence drill-down's three
 * no-evidence arms do — putting a true answer through the webview's error path
 * is the conflation that makes "the file aged out" read as "something broke".
 */
export type ResolveHistoryDescriptionResponse =
  | { readonly outcome: 'resolved'; readonly runId: string; readonly description: string }
  | { readonly outcome: 'legacy'; readonly runId: string; readonly description: string }
  | { readonly outcome: 'missing'; readonly runId: string }
  | { readonly outcome: 'unreadable'; readonly runId: string }
  | { readonly outcome: 'failure'; readonly reason: 'unknown-run' | 'internal-error' };
