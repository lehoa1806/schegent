// ---------------------------------------------------------------------------
// FR-R4-F16 (feature 244, contract M1) — "Schegent: Report Failed-Row Exits": counts how each failed
// row was resolved, from the audit chain and the queue state, and opens the result as an unsaved
// Markdown document.
//
// READ-ONLY, BY CONSTRUCTION. The command receives ports and no more: it can read the clock, the queue
// state, the policy default and the extension version, read the audit chain through the census reader,
// and hand text to `openReport`. It is given no audit writer, queue manager, controller or lock, so it
// cannot append, start work or reach the network (FR-017). It takes no lease and checks no primacy, so
// two windows may run it at once. It imports no `vscode`; `ui-wiring.ts` builds the ports.
//
// ORDER. The cutoff is taken first and the queue state and policy default are read in the same
// synchronous turn, so no queue write can land between them in this window (research R7). The chain is
// read after: the cutoff is what places each audit entry against the snapshot.
//
// ERRORS. Steps 1 to 4 cannot reject: the reader never throws and the census and the report are pure.
// Only opening the document can fail, and then the operator gets one fixed message and the log gets one
// warning with the error's code or name, never its message (hard rule 22).
// ---------------------------------------------------------------------------

import type { QueueFailurePolicy } from '../contracts/queue-failure-policy';
import type { SanitizedLogger } from '../lib/logger';
import { readCensusLog } from '../services/failed-row-census/census-reader';
import { renderCensusReport } from '../services/failed-row-census/census-report';
import { toQueueSnapshot } from '../services/failed-row-census/census-snapshot';
import { runFailedRowCensus } from '../services/failed-row-census/failed-row-census';
import type { QueueStateMap } from '../state/queue-state-migrator';
import type { Notifier } from '../ui/notifications';

export const REPORT_FAILED_ROW_EXITS_COMMAND = 'schegent.reportFailedRowExits';

const OPEN_FAILED_MESSAGE = 'Schegent: could not open the failed-row report.';
const ERROR_NAME_UNKNOWN = 'unknown';

export interface ReportFailedRowExitsDeps {
  readonly workspaceRoot: string;
  readonly now: () => number;
  readonly readQueueStates: () => QueueStateMap;
  readonly readPolicyDefault: () => QueueFailurePolicy;
  readonly extensionVersion: () => string;
  readonly openReport: (markdown: string) => Promise<void>;
  readonly logger: SanitizedLogger;
  readonly notifier: Notifier;
}

/** The error's code when it has a string one, else its name, else a fixed word. Never its message. */
function errorCodeOrName(err: unknown): string {
  if (err === null || typeof err !== 'object') return ERROR_NAME_UNKNOWN;
  const { code, name } = err as { code?: unknown; name?: unknown };
  if (typeof code === 'string') return code;
  return typeof name === 'string' ? name : ERROR_NAME_UNKNOWN;
}

/** Counts how failed rows were resolved and opens the report. Resolves whether or not it could open. */
export async function runReportFailedRowExits(deps: ReportFailedRowExitsDeps): Promise<void> {
  // One synchronous turn: the cutoff, then the snapshot it applies to.
  const cutoffMs = deps.now();
  const snapshot = toQueueSnapshot(deps.readQueueStates(), deps.readPolicyDefault(), cutoffMs);
  const log = await readCensusLog(deps.workspaceRoot, deps.logger);
  const markdown = renderCensusReport(runFailedRowCensus(log, snapshot), {
    cutoffMs,
    extensionVersion: deps.extensionVersion(),
    snapshot
  });
  try {
    await deps.openReport(markdown);
  } catch (err) {
    deps.notifier.error(OPEN_FAILED_MESSAGE);
    deps.logger.warn('failed-row report: could not open the report', { code: errorCodeOrName(err) });
  }
}
