// The render-cost workloads (FR-R4-F08, contract E: E4; research R23).
//
// `snapshot-render-cost.visual.spec.ts` publishes each of these into the built dashboard and times
// how long the webview takes to apply it. The Playwright process cannot import the real projector
// (its trust resolver imports `vscode`), so these are fixture payloads whose counts match the host
// workloads that `tests/perf/webview-snapshot-cost.test.ts` projects, and the spec records each
// payload's own bytes beside the host's so a reader can see whether they agree.
//
//   - idle: one empty default queue, no Run, no history;
//   - active: one executing Run, an audit tail of 50 and a debug tail of 200;
//   - large-history: the active workload on 20 queues, with 2,000 history entries over 20 live
//     partitions and 20 deleted queues' partitions at 50 entries each;
//   - large-history-2x: the same with 60 deleted partitions, 4,000 entries.
//
// Built from the exports of `workflow-snapshot.ts` without editing it, so the visual suite's
// screenshots are unaffected. The History route renders at most `HISTORY_RENDER_BOUND` rows however
// many entries the snapshot carries (`webview-ui/src/lib/history-rows.ts`), so each workload also
// exports the row count the DOM must show and the count the route says it matched.

import type { WorkflowSnapshot } from '../../../src/ui/sidebar/snapshot';
import { workflowSnapshot } from './workflow-snapshot';

/**
 * The History route's fixed render bound. Restated, not imported: the Playwright process reaches
 * the webview's sources as types only. The spec fails if the route says otherwise (it reads the
 * route's own "N of M runs" count), so a change to the bound cannot pass unnoticed.
 */
export const HISTORY_RENDER_BOUND = 200;

export type CostWorkloadName = 'idle' | 'active' | 'large-history' | 'large-history-2x';

export interface CostWorkload {
  readonly name: CostWorkloadName;
  readonly snapshot: WorkflowSnapshot;
  /** `snapshot.history.length`. */
  readonly historyEntries: number;
  /** What the History route says it matched: the entries, plus a Run still in flight. */
  readonly expectedMatched: number;
  /** The History rows the DOM must show: the matched count, bounded. */
  readonly expectedHistoryRows: number;
  readonly queues: number;
  readonly auditTail: number;
  readonly debugTail: number;
}

const AUDIT_TAIL = 50;
const DEBUG_TAIL = 200;
const LIVE_QUEUES = 20;
const HISTORY_PER_PARTITION = 50;
const DELETED_PARTITIONS_LARGE = 20;
const DELETED_PARTITIONS_LARGE_2X = 60;
const EPOCH_MS = Date.parse('2026-08-01T09:00:00.000Z');

const baseQueue = workflowSnapshot.queues[0];

function queueId(index: number): string {
  return index === 0 ? 'default' : `0000${index.toString(16).padStart(4, '0')}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

/** A queue with nothing running and nothing pending. */
function emptyQueue(index: number): WorkflowSnapshot['queues'][number] {
  return {
    ...baseQueue,
    queueId: queueId(index),
    name: index === 0 ? 'Default' : `Queue ${index}`,
    position: index,
    lifecycle: 'active-empty',
    inFlightRun: null,
    phases: [],
    pendingCount: 0,
    tasks: []
  };
}

function auditTail(count: number): WorkflowSnapshot['auditTail'] {
  const template = workflowSnapshot.auditTail[0];
  return Array.from({ length: count }, (_, index) => ({
    ...template,
    id: `cost-audit-${index}`,
    timestamp: new Date(EPOCH_MS + index * 1_000).toISOString(),
    summary: `synthetic audit event ${index} with a moderately verbose summary line`
  }));
}

function debugTail(count: number): WorkflowSnapshot['debugLogTail'] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    timestamp: new Date(EPOCH_MS + index * 1_000).toISOString(),
    level: 'INFO' as const,
    message: `measured debug line ${index}`
  }));
}

function history(partitions: number): WorkflowSnapshot['history'] {
  const entries: WorkflowSnapshot['history'][number][] = [];
  for (let partition = 0; partition < partitions; partition += 1) {
    // The live partitions are the registered queues; the rest belong to queues that were deleted.
    const owner = queueId(partition < LIVE_QUEUES ? partition : 1_000 + partition);
    for (let index = 0; index < HISTORY_PER_PARTITION; index += 1) {
      const at = EPOCH_MS - (partition * HISTORY_PER_PARTITION + index + 1) * 60_000;
      entries.push({
        runId: `cost-run-${partition}-${index}`,
        featureId: `cost-feature-${partition}-${index}`,
        descriptionPreview: `history entry ${index} of partition ${partition}, with a realistic preview line`,
        terminalStatus: 'completed',
        startedAt: new Date(at).toISOString(),
        completedAt: new Date(at + 30_000).toISOString(),
        durationMs: 30_000,
        lastErrorSummary: null,
        auditLogPointer: `runId:cost-run-${partition}-${index}`,
        queueId: owner
      });
    }
  }
  return entries;
}

function workload(
  name: CostWorkloadName,
  snapshot: WorkflowSnapshot,
  expectedMatched: number
): CostWorkload {
  return {
    name,
    snapshot,
    historyEntries: snapshot.history.length,
    expectedMatched,
    expectedHistoryRows: Math.min(expectedMatched, HISTORY_RENDER_BOUND),
    queues: snapshot.queues.length,
    auditTail: snapshot.auditTail.length,
    debugTail: snapshot.debugLogTail.length
  };
}

const idleSnapshot: WorkflowSnapshot = {
  ...workflowSnapshot,
  queues: [emptyQueue(0)],
  queue: { ...workflowSnapshot.queue, inFlight: null, pending: [], recent: [], orderedItems: [] },
  monitor: null,
  history: [],
  auditTail: [],
  debugLogTail: []
};

const activeSnapshot: WorkflowSnapshot = {
  ...workflowSnapshot,
  history: [],
  auditTail: auditTail(AUDIT_TAIL),
  debugLogTail: debugTail(DEBUG_TAIL)
};

/** The active workload on 20 queues: the first keeps the executing Run, the rest are empty. */
function largeHistorySnapshot(deletedPartitions: number): WorkflowSnapshot {
  return {
    ...activeSnapshot,
    queues: [baseQueue, ...Array.from({ length: LIVE_QUEUES - 1 }, (_, index) => emptyQueue(index + 1))],
    history: history(LIVE_QUEUES + deletedPartitions)
  };
}

/** The four workloads, in the order they are measured. */
export const COST_WORKLOADS: readonly CostWorkload[] = Object.freeze([
  workload('idle', idleSnapshot, 0),
  // The executing Run is folded into the History list as a row, so one run is "matched".
  workload('active', activeSnapshot, 1),
  workload('large-history', largeHistorySnapshot(DELETED_PARTITIONS_LARGE), (LIVE_QUEUES + DELETED_PARTITIONS_LARGE) * HISTORY_PER_PARTITION + 1),
  workload('large-history-2x', largeHistorySnapshot(DELETED_PARTITIONS_LARGE_2X), (LIVE_QUEUES + DELETED_PARTITIONS_LARGE_2X) * HISTORY_PER_PARTITION + 1)
]);
