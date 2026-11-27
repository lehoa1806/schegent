// FR-R3-129 — the production `ChildRunFactsReader`, which did not exist.
//
// `recordChildTerminal` needs a child Run's terminal status and outputs. Two test
// fixtures supplied that reader and nothing in `src/` did, which is why the
// coordinator had no production caller at all. These cases pin the three answers
// that matter and the one that must stay `null`.
import { describe, expect, it } from 'vitest';

import { makeChildRunFactsReader } from '../../../src/services/workflow-execution/child-run-facts-reader';

const OUTPUT = { kind: 'file', path: 'reports/verdict.md' } as never;

describe('makeChildRunFactsReader (FR-R3-129)', () => {
  it('reads a terminal Run from the active map, with its outputs', () => {
    const read = makeChildRunFactsReader({
      runsByQueue: () => ({
        default: { featureId: 'q-1', status: 'completed', runOutputs: [OUTPUT] }
      }),
      history: () => []
    });
    expect(read('q-1')).toEqual({ status: 'completed', outputs: [OUTPUT] });
  });

  it('falls through to history for a Run the queue has released', () => {
    // A terminal Run leaves the active map when its queue starts the next task, so
    // history is the durable answer. Without this arm a node routed correctly only
    // while its Run happened to still be recorded — a race, not a rule.
    const read = makeChildRunFactsReader({
      runsByQueue: () => ({}),
      history: () => [{ featureId: 'q-2', terminalStatus: 'failed' }]
    });
    expect(read('q-2')).toEqual({ status: 'failed', outputs: [] });
  });

  it('prefers the active map, which is the fresher of the two', () => {
    const read = makeChildRunFactsReader({
      runsByQueue: () => ({ default: { featureId: 'q-3', status: 'completed' } }),
      history: () => [{ featureId: 'q-3', terminalStatus: 'failed' }]
    });
    expect(read('q-3')?.status).toBe('completed');
  });

  it('answers null for a Run that has not reached a terminal state', () => {
    // `running` is not a `WorkflowNodeTerminalStatus`, and the null is load-bearing:
    // `recordChildTerminal` turns it into `ignored: not-terminal`, and every operand
    // naming the node resolves unresolved, hence false (FR-024). A branch is not
    // taken on a fact nobody has.
    const read = makeChildRunFactsReader({
      runsByQueue: () => ({ default: { featureId: 'q-4', status: 'running' } }),
      history: () => []
    });
    expect(read('q-4')).toBeNull();
  });

  it('answers null for an unknown queue item and for a malformed history row', () => {
    const read = makeChildRunFactsReader({
      runsByQueue: () => ({}),
      // The store types history rows as `object` on purpose; a row missing the two
      // fields this reader needs is skipped rather than crashing a routing decision.
      history: () => [{}, { featureId: 'q-5' }, { terminalStatus: 'completed' }]
    });
    expect(read('q-5')).toBeNull();
    expect(read('nothing')).toBeNull();
  });

  it('accepts every terminal status the workflow contract allows, and no other', () => {
    for (const status of ['completed', 'failed', 'canceled']) {
      const read = makeChildRunFactsReader({
        runsByQueue: () => ({ default: { featureId: 'q', status } }),
        history: () => []
      });
      expect(read('q')?.status, status).toBe(status);
    }
    // The double-l spelling is deliberately NOT accepted: the contract records
    // `canceled` as canonical, and silently accepting both would make a condition
    // comparing against `'canceled'` pass or fail depending on which spelling a
    // writer used.
    const cancelled = makeChildRunFactsReader({
      runsByQueue: () => ({ default: { featureId: 'q', status: 'cancelled' } }),
      history: () => []
    });
    expect(cancelled('q')).toBeNull();
  });
});
