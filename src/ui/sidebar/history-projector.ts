// Feature 013 — Wave 7 (US7 / T091): history projection extracted from
// state-projector.ts. Pure function; the orchestrator passes in the
// store reference and the helper produces a frozen snapshot copy.
//
// Feature 103 (T007, FR-002): each row is now constructed field by field
// instead of `history.list().slice()`. The slice copied the array, not its
// members, so every `HistoryRecord` field reached the webview — including
// `originalDescription`, a legacy operator string capped at 32,000 characters
// that no consumer reads, plus `descriptionRef`, `descriptionLength`,
// `pipelineId` and `runOutputs`. `tsc` never objected: a value with extra
// properties satisfies a narrower interface everywhere except a fresh object
// literal, which is exactly what a `slice()` is not.
//
// Constructing explicitly is what makes the declared type the whole truth about
// the wire, and it is the only form in which "no undeclared field ships" is a
// property a test can hold rather than a convention.

import type { HistoryStore } from '../../state/history-store';
import type { HistoryEntry } from './snapshot';

export function projectHistory(
  history: Pick<HistoryStore, 'list'> | null
): readonly HistoryEntry[] {
  if (!history) return Object.freeze([]) as readonly HistoryEntry[];
  return Object.freeze(
    history.list().map((record) => ({
      runId: record.runId,
      featureId: record.featureId,
      descriptionPreview: record.descriptionPreview,
      terminalStatus: record.terminalStatus,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      durationMs: record.durationMs,
      lastErrorSummary: record.lastErrorSummary,
      auditLogPointer: record.auditLogPointer,
      queueId: record.queueId,
      // Feature 103 (T031, FR-009/FR-013) — copied off the record and nowhere
      // else. Absent stays absent: this projector holds no catalog reference and
      // must not acquire one, because filling a gap from today's Active version
      // would tell the operator a run froze something it did not (FR-010).
      ...(record.catalogVersion !== undefined ? { catalogVersion: record.catalogVersion } : {}),
      ...(record.origin !== undefined ? { origin: record.origin } : {}),
      // Feature 103 (T052, FR-053) — the length, not the text. The detail states
      // how much of the original the retained preview is; `descriptionRef` and
      // `originalDescription` stay off the wire, which is the whole point of
      // shipping a number instead.
      ...(record.descriptionLength !== undefined
        ? { descriptionLength: record.descriptionLength }
        : {})
    }))
  );
}
