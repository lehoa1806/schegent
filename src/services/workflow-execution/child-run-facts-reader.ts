// FR-R3-129 (T1489/T1491 wiring, FR-005) — the production `ChildRunFactsReader`.
//
// WHY IT DID NOT EXIST. `recordChildTerminal` in `connected-run-coordinator.ts`
// needs, for a queue item, the child Run's terminal status and its declared
// outputs — the facts every routing condition is evaluated against. Two test
// fixtures supplied that reader; **nothing in `src/` did**, and
// `recordChildTerminal` therefore had no production caller at all. A connected
// Workflow's node could finish and no routing decision was ever appended, so the
// append-only trail that exists to answer *"why was this branch not offered"* was
// empty in every real Run.
//
// WHERE THE FACTS COME FROM, and the order matters. A terminal Run is removed from
// the active map when its queue starts the next task, so the run map alone answers
// only while the Run is still recorded there. History is the durable record and
// carries the terminal status. Both are consulted, run map first, because it is the
// fresher of the two and carries the outputs.
//
// `null` FOR EVERYTHING ELSE, and that is a decision rather than a fallback. A
// non-terminal Run, a queue item with no Run, and a Run this host cannot resolve all
// collapse to `null` — which `recordChildTerminal` turns into `ignored:
// not-terminal` and every condition operand turns into unresolved, hence `false`
// (FR-024). A branch is not taken on a fact nobody has.
import type { WorkflowNodeTerminalStatus } from '../../contracts/workflow-definitions';
import { isWorkflowNodeTerminalStatus } from '../../contracts/workflow-definitions';
import type { RunOutputRecord } from '../../contracts/run-results';
import type { ChildRunFacts, ChildRunFactsReader } from './connected-run-coordinator';

/** The two projections this reader consults, narrowed to what it reads. */
export interface ChildRunFactsSource {
  /** Every Run this host currently holds, by queue id. */
  readonly runsByQueue: () => Readonly<
    Record<string, { readonly featureId: string; readonly status: string; readonly runOutputs?: readonly RunOutputRecord[] } | undefined>
  >;
  /**
   * The durable terminal record, for a Run the active map has already released.
   *
   * `readonly object[]`, because that is what `WorkspaceStateStore.getHistory()`
   * returns: the store is deliberately shape-agnostic about the rows it persists
   * (`PersistedHistoryEntry = object`). The narrowing is this module's job and is
   * done with a guard below, not with a cast at the call site — a cast would make
   * a malformed row a runtime surprise inside a routing decision.
   */
  readonly history: () => readonly object[];
}

interface TerminalHistoryRow {
  readonly featureId: string;
  readonly terminalStatus: string;
  readonly runOutputs?: readonly RunOutputRecord[];
}

/** The three fields this reader needs from a persisted history row. */
function isTerminalHistoryRow(row: object): row is TerminalHistoryRow {
  const candidate = row as Partial<TerminalHistoryRow>;
  return typeof candidate.featureId === 'string' && typeof candidate.terminalStatus === 'string';
}

const facts = (
  status: string,
  outputs: readonly RunOutputRecord[] | undefined
): ChildRunFacts | null =>
  isWorkflowNodeTerminalStatus(status)
    ? { status: status as WorkflowNodeTerminalStatus, outputs: outputs ?? [] }
    : null;

/**
 * Build the reader.
 *
 * A function of two projections rather than of the store, so the routing decision
 * is testable without a workspace — the same shape `judgeBackendContainment` and
 * `resolveCapabilityDecision` take, and for the same reason.
 */
export function makeChildRunFactsReader(source: ChildRunFactsSource): ChildRunFactsReader {
  return (queueItemId: string): ChildRunFacts | null => {
    // The active map first: fresher, and it carries `runOutputs`.
    for (const run of Object.values(source.runsByQueue())) {
      if (run === undefined || run.featureId !== queueItemId) continue;
      return facts(run.status, run.runOutputs);
    }
    // Then the durable record, for a Run whose queue has already moved on.
    for (const row of source.history()) {
      if (!isTerminalHistoryRow(row) || row.featureId !== queueItemId) continue;
      return facts(row.terminalStatus, row.runOutputs);
    }
    return null;
  };
}
