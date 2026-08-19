import type { CMD_RESOLVE_AUDIT_POINTER, CommandBase } from '../sidebar-ipc';

// FR-R3-010 — the read side of `HistoryEntry.auditLogPointer`. A completed Run
// leaves a pointer in its history record; this command is what turns that
// pointer back into evidence the operator can see.
//
// The request names a **Run**, not a pointer and not a timestamp. The pointer
// and the run's `completedAt` both live in host-owned state, and both feed the
// verdict — `completedAt` is what separates "the evidence aged out" from "this
// Run never wrote any". A webview that supplied either could choose its own
// answer, so it supplies neither: the same discipline the phase-log selection
// follows, where the wire carries identifiers and the host resolves everything
// a filesystem read depends on.
export interface ResolveAuditPointerRequest {
  readonly runId: string;
}

export interface ResolveAuditPointerCommand
  extends CommandBase<typeof CMD_RESOLVE_AUDIT_POINTER> {
  readonly payload: ResolveAuditPointerRequest;
}

/**
 * One audit record, as the drill-down presents it.
 *
 * Deliberately **not** the entry's `payload`. A payload carries phase notes,
 * error summaries and other operator-authored text, and the drill-down's job is
 * to answer whether the evidence is still reachable and what it covers — not to
 * replay it. `CMD_OPEN_AUDIT_LOG` already opens the file for an operator who
 * wants the contents.
 *
 * `eventType` is a bare `string` rather than `AuditEventType` because the parser
 * preserves types it does not know (warn-and-preserve), and an archive written
 * by a newer build than the one reading it is exactly the case this drill-down
 * exists for. Narrowing here would drop the rows that matter most.
 */
export interface HistoryEvidenceEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly eventType: string;
  readonly phase: string;
  readonly iteration: number;
  readonly outcome: string;
}

/**
 * The five outcomes the resolver can reach, plus the two only the host can.
 *
 * `evidence-expired` and `no-evidence-recorded` are ordinary answers, not
 * failures, and the webview MUST render them apart from `failure` — an operator
 * told "could not load" goes looking for a bug, and one told "the audit log
 * covering this run has been rotated away" goes looking for the archive. That
 * distinction is the whole point of the outcome existing (T411).
 */
export type ResolveAuditPointerResponse =
  | {
      readonly outcome: 'resolved';
      readonly runId: string;
      readonly entries: readonly HistoryEvidenceEntry[];
      /** More records matched than the response carries. */
      readonly truncated: boolean;
      /** Lines the parser preserved with a warning rather than dropping. */
      readonly parseWarnings: number;
    }
  | { readonly outcome: 'evidence-expired'; readonly runId: string }
  | { readonly outcome: 'no-evidence-recorded'; readonly runId: string }
  /** The record predates the pinned pointer format, or carries none. */
  | { readonly outcome: 'unaddressable' }
  | {
      readonly outcome: 'failure';
      readonly reason: 'unknown-run' | 'corpus-unreadable' | 'internal-error';
    };
