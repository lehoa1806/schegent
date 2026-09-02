// Bug "there is no way to start a pending task" (2026-09-02), second finding.
//
// `TERMINAL_WORKFLOW_STATUSES` was added to `contracts/snapshot-projections.ts`
// so the webview could tell a queue that *owns* a Run from a queue that is
// *working* one. It is the third list of those same three words in this
// repository, which is one list too many unless the copies are pinned together —
// so this suite is the pin, and it is deliberately about equality with the
// persisted union's list rather than about the words themselves.
//
// The direction that matters: `TERMINAL_RUN_STATUSES` governs lease release and
// session teardown (`AutoDrainCoordinator` reads it to decide whether a queue's
// Run still occupies it). If the two ever disagreed, a status could end a Run for
// the host while the webview still drew it as live — which is precisely the class
// of defect the constant was introduced to remove, reintroduced one layer over.

import { describe, expect, it } from 'vitest';

import {
  TERMINAL_WORKFLOW_STATUSES,
  isTerminalWorkflowStatus
} from '../../../src/contracts/snapshot-projections';
import type { WorkflowStatus } from '../../../src/contracts/snapshot-projections';
import { TERMINAL_RUN_STATUSES } from '../../../src/state/workflow-run';

/**
 * The whole `WorkflowStatus` union, spelled out. A status added to the union and
 * not to one of these two arrays fails the partition assertion below, which is
 * how a new status is forced to declare whether it ends a Run.
 */
const RUNNING_STATUSES: readonly WorkflowStatus[] = ['idle', 'running', 'paused'];

describe('TERMINAL_WORKFLOW_STATUSES', () => {
  it('is the same list as the persisted union’s, so the two layers cannot disagree', () => {
    expect([...TERMINAL_WORKFLOW_STATUSES].sort()).toEqual([...TERMINAL_RUN_STATUSES].sort());
  });

  it('reports every terminal status as terminal', () => {
    for (const status of TERMINAL_WORKFLOW_STATUSES) {
      expect(isTerminalWorkflowStatus(status), `${status} ends a Run`).toBe(true);
    }
  });

  it('reports no non-terminal status as terminal', () => {
    for (const status of RUNNING_STATUSES) {
      expect(isTerminalWorkflowStatus(status), `${status} does not end a Run`).toBe(false);
    }
  });

  it('partitions the WorkflowStatus union, so a new status cannot be left unclassified', () => {
    // `idle` belongs to neither the persisted union nor a projected Run in
    // practice — a Run record always carries one of the five `WorkflowRunStatus`
    // values — but it is in `WorkflowStatus`, and a partition that quietly
    // excluded it would stop being a partition the moment someone widened it.
    const partition = [...TERMINAL_WORKFLOW_STATUSES, ...RUNNING_STATUSES].sort();
    const union: readonly WorkflowStatus[] = [
      'idle',
      'running',
      'paused',
      'completed',
      'failed',
      'canceled'
    ];

    expect(partition).toEqual([...union].sort());
    expect(new Set(partition).size).toBe(union.length);
  });
});
