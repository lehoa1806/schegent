/**
 * FR-R6-F11 (FR-015, FR-018; research R8) — ends exports an earlier host left `pending`.
 *
 * A pending row older than `EXPORT_STALE_AFTER_MS` cannot belong to a live export: the export
 * clock ends every export within 60 seconds. Such a row has its own two partial names removed,
 * each proven contained in its stored staging directory, and ends `failed` with `host-stopped`.
 * A younger row may belong to another window and is left alone.
 *
 * The names removed are the ones this export would have written: a row whose stored names differ
 * from `partialNames(finalName, exportId)`, or whose staging directory is not absolute, has
 * nothing removed; `removePartials` removes only direct entries of the staging directory, so a
 * final name with a directory part removes nothing either. Such a row, and one whose partials
 * cannot be proven contained, ends `failed` all the same, so the workspace is never held busy,
 * and nothing outside the staging directory is touched.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import * as path from 'node:path';
import { partialNames, removePartials, type ExportFs } from './export-publisher';
import type { ExportStore, PendingExport } from './export-store';
import type { ReportingLogger } from './report-capture';

/** Twice the 60-second export clock (NFR-003). */
export const EXPORT_STALE_AFTER_MS = 120_000;

const RECONCILE_FAILED = 'reporting: reconcile failed';

export interface ReconcileDeps {
  readonly store: ExportStore;
  readonly fs: ExportFs;
  readonly workspaceId: string;
  readonly nowMs: () => number;
  readonly logger?: ReportingLogger;
}

/** True when the row names exactly the partials its own export would have written. */
function ownsItsPartials(row: PendingExport): boolean {
  const expected = partialNames(row.finalName, row.exportId);
  return (
    path.isAbsolute(row.stagingDir) &&
    row.dataPartialName === expected.data &&
    row.manifestPartialName === expected.manifest
  );
}

export async function reconcileExports(deps: ReconcileDeps): Promise<{ readonly reconciled: number }> {
  const now = deps.nowMs();
  let reconciled = 0;
  for (const row of deps.store.pendingRows(deps.workspaceId)) {
    if (now - row.createdMs <= EXPORT_STALE_AFTER_MS) continue;
    const clean =
      ownsItsPartials(row) && (await removePartials(deps.fs, row.stagingDir, [row.dataPartialName, row.manifestPartialName]));
    if (!clean) deps.logger?.warn(RECONCILE_FAILED, { operation: 'reconcileExports', reason: 'partials-not-removed' });
    if (deps.store.finish(row.exportId, 'failed', 'host-stopped', now)) reconciled += 1;
  }
  return { reconciled };
}
