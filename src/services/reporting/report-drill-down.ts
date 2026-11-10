/**
 * FR-R6-F11 (FR-022; contract §5) — drill-down into one root of a live report.
 *
 * The root, its attempts and its frozen definition identity come from the report's snapshot, so
 * a drill-down answers what the report saw. The outcome lineage starts with the run store's
 * status, then lists the distinct attempt outcomes F06 recorded for the root, in code-point order.
 * F06 keeps no root-outcome history, so attempt outcomes stand in for it. The root's usage is read
 * at the report's pinned revision, grouped by backend and model; with no accounting store, or no
 * revision captured, usage is null and an omission says why. No path ever enters the answer.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { reportOk, reportRefused, type ReportResult } from '../../contracts/reporting/report-outcomes';
import type { OutcomeLineageEntry, RootDrillDown } from '../../contracts/reporting/report-rows';
import { compareCodePoints, toAttemptRow, toRootRow } from './report-aggregates';
import type { LiveReport } from './report-snapshots';
import { readUsage, type AccountingPort } from './report-usage';

const NO_USAGE = Object.freeze([Object.freeze({ what: 'usage', reason: 'accounting-unavailable' })]);

function accountingOutcomes(
  accounting: AccountingPort,
  rootId: string,
  revision: number,
  cap: number
): ReportResult<readonly OutcomeLineageEntry[]> {
  const read = readUsage(accounting, { groupBy: ['attemptOutcome'], rootIds: [rootId], asOfRevision: revision }, { cap });
  if (!read.ok) {
    return read;
  }
  const outcomes = read.value.rows
    .map((row) => row.key.attemptOutcome)
    .filter((outcome): outcome is string => typeof outcome === 'string')
    .sort(compareCodePoints);
  return reportOk(outcomes.map((outcome) => Object.freeze({ source: 'accounting' as const, outcome })));
}

/** Drills into `rootId` of `report`; a root the report did not capture is `unknown-root`. */
export function drillIntoRoot(
  report: LiveReport,
  rootId: string,
  accounting: AccountingPort | null,
  cap: number
): ReportResult<RootDrillDown> {
  const root = report.roots.find((candidate) => candidate.rootId === rootId);
  if (root === undefined) {
    return reportRefused('unknown-root');
  }
  const attempts = report.attempts.filter((attempt) => attempt.rootId === rootId);
  const base = {
    reportId: report.reportId,
    root: toRootRow(root, attempts.length),
    attempts: Object.freeze(attempts.map(toAttemptRow)),
    frozenDefinitionId: root.frozenDefinitionId
  };
  const runStore: OutcomeLineageEntry = Object.freeze({ source: 'run-store', outcome: root.status });
  if (accounting === null || report.accountingRevision === null) {
    return reportOk(Object.freeze({ ...base, outcomeLineage: Object.freeze([runStore]), usage: null, omissions: NO_USAGE }));
  }
  const lineage = accountingOutcomes(accounting, rootId, report.accountingRevision, cap);
  if (!lineage.ok) {
    return lineage;
  }
  const usage = readUsage(
    accounting,
    { groupBy: ['backend', 'model'], rootIds: [rootId], asOfRevision: report.accountingRevision },
    { cap }
  );
  if (!usage.ok) {
    return usage;
  }
  return reportOk(
    Object.freeze({
      ...base,
      outcomeLineage: Object.freeze([runStore, ...lineage.value]),
      usage: usage.value.rows,
      omissions: Object.freeze([])
    })
  );
}
