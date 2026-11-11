/**
 * FR-R6-F15 (F15-A; FR-031, NFR-008) — the bounded history of a review loop.
 *
 * A reviewer or fixer of a later pass is shown how the loop went, not every report of it: the
 * last five passes as counts, how many passes came before them, and where the latest report is.
 * An entry is a pass number, a report reference, a verdict and three counts, so the size of the
 * history does not grow with the number of findings or of passes.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { PHASE_CONTEXT_LIMITS } from '../../contracts/phase-context/context-policy';
import type { LoopHistory, PassOutcome, PassSummary } from '../../contracts/phase-context/review-loop';

function summaryOf({ pass, reportRef, verdict, open, resolved, newFindings }: PassOutcome): PassSummary {
  return { pass, reportRef, verdict, open, resolved, newFindings };
}

/** The history window over the accepted passes of a loop, oldest first. */
export function buildLoopHistory(passes: readonly PassOutcome[]): LoopHistory {
  const kept = passes.slice(-PHASE_CONTEXT_LIMITS.historyPassesMax);
  const last = passes.at(-1);
  return {
    entries: kept.map(summaryOf),
    olderPasses: passes.length - kept.length,
    latestReportRef: last === undefined ? null : last.reportRef,
    blockingCount: last === undefined ? 0 : last.blockingCount
  };
}
