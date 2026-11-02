// FR-R4-F04 (G1) — the caller `HistoryDescriptionStore.reconcile` never had.
//
// WHAT WAS WRONG. FR-R3-111 wrote the orphan sweep for `.schegent/history/`: a grace period so a description
// still being written is never taken, and a cap on removals per activation. It wrote tests for it, and no
// production code called it. The retention inventory (`retention-disclosure.ts`) told the operator these files
// are removed once they are old and unreferenced, at most 200 per activation, and no activation did. Each
// orphan is up to 32,000 characters of operator-authored text.
//
// WHAT THIS ADDS. The one decision `reconcile` leaves to its caller: which descriptions are still referenced.
// It is read from the RAW persisted rows, not from the normalised history list. The list drops a row it cannot
// normalise (no feature id, say), and a sweep that took its answer from the list would delete the description
// of a row that is still stored. A row protects its file by `runId`, by the legacy `id` field, or by the run id
// its `descriptionRef` names; keeping a file is the safe way to be wrong here, so every one of them counts.
//
// FAIL-SOFT. A sweep that cannot tell what is referenced removes nothing and says so by code, never by the
// caught message (which can name a path).

import type { SanitizedLogger } from '../../lib/logger';
import { historyErrorCode } from './error-code';
import { HistoryDescriptionStore, runIdFromDescriptionFile } from './history-description-store';

/** The prefix `historyDescriptionRef` writes, POSIX-separated on every platform. */
const DESCRIPTION_REF_PREFIX = '.schegent/history/';

export interface HistoryDescriptionSweepDeps {
  readonly workspaceRoot: string;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
  /**
   * The persisted map as `WorkspaceStateStore.getHistoryMap()` returns it, read when the sweep starts.
   * Rows are `unknown` because the memento is operator-editable: only the array-ness of a partition is
   * checked on the way in.
   */
  readonly historyMap: () => Readonly<Record<string, readonly unknown[]>>;
  readonly nowMs: number;
}

export type HistoryDescriptionSweepResult = Awaited<ReturnType<HistoryDescriptionStore['reconcile']>>;

/** Every run id a persisted row can be taken to refer to. */
function referencedRunIds(historyMap: Readonly<Record<string, readonly unknown[]>>): ReadonlySet<string> {
  const referenced = new Set<string>();
  for (const rows of Object.values(historyMap)) {
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const fields = row as { runId?: unknown; id?: unknown; descriptionRef?: unknown };
      if (typeof fields.runId === 'string') referenced.add(fields.runId);
      if (typeof fields.id === 'string') referenced.add(fields.id);
      if (typeof fields.descriptionRef === 'string' && fields.descriptionRef.startsWith(DESCRIPTION_REF_PREFIX)) {
        const named = runIdFromDescriptionFile(fields.descriptionRef.slice(DESCRIPTION_REF_PREFIX.length));
        if (named !== null) referenced.add(named);
      }
    }
  }
  return referenced;
}

/**
 * Remove the history descriptions no stored row refers to, once they are past the grace period, at most
 * `HISTORY_SWEEP_MAX_REMOVALS` per call. Returns what was done, or `null` when the sweep could not tell what
 * is referenced and so removed nothing.
 */
export async function sweepHistoryDescriptions(
  deps: HistoryDescriptionSweepDeps
): Promise<HistoryDescriptionSweepResult | null> {
  try {
    const store = new HistoryDescriptionStore({ workspaceRoot: deps.workspaceRoot, logger: deps.logger });
    const result = await store.reconcile({
      referenced: referencedRunIds(deps.historyMap()),
      nowMs: deps.nowMs
    });
    if (result.swept > 0) {
      deps.logger.info(`history-description-sweep: removed ${result.swept} orphaned description file(s)`);
    }
    return result;
  } catch (error) {
    deps.logger.warn('history-description-sweep: the sweep did not run', { errorCode: historyErrorCode(error) });
    return null;
  }
}
