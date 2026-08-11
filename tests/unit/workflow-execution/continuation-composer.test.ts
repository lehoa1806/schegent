// Feature 088 (T025) — the prefill draft, pinned.
//
// Added by the T051 quickstart walk, which found the derivation shipped with no
// suite: Scenario 6's "the composer opens with the bound reference already
// filled in" and "an output of a node that has not completed is not offered as
// bindable" had no headless coverage at all. The webview side covers rendering
// a prefill it is handed; nothing covered deciding what that prefill is.
//
// Every assertion here is about a *skip*. `composeContinuationPrefill` never
// raises and never blocks the composer — a binding with nothing behind it
// contributes no value, and the operator gets an empty field. So the way this
// can be wrong is by filling a port it should have left alone, which is what the
// negative cases below measure.
//
// The rule it fills by is deliberately `resolveOperand`'s, not its own: a
// binding that could read what a condition cannot would be a second definition
// of "available output". Each negative case is therefore stated as a fact the
// condition side also refuses — see `condition-context.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  buildConditionContext,
  type NodeAttemptFacts
} from '../../../src/services/workflow-execution/condition-context';
import { composeContinuationPrefill } from '../../../src/services/workflow-execution/continuation-composer';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import type { WorkflowRunPipeline } from '../../../src/state/workflow-run';

/** `n-triage` completed and produced one of its two declared outputs. */
const TRIAGE_COMPLETED: NodeAttemptFacts = {
  nodeId: 'n-triage',
  status: 'completed',
  outputs: [
    { name: 'verdict', status: 'resolved', reference: 'reports/verdict.md' },
    { name: 'notes', status: 'unresolved' }
  ]
};

/** `n-build` ran and failed, so nothing it produced is bindable. */
const BUILD_FAILED: NodeAttemptFacts = {
  nodeId: 'n-build',
  status: 'failed',
  outputs: [{ name: 'artifact', status: 'resolved', reference: 'dist/app.tgz' }]
};

/** The destination's frozen Pipeline: two ports, so a fill and a skip are distinguishable. */
const SHIP: WorkflowRunPipeline = {
  id: 'ship-flow',
  name: 'Ship Flow',
  phases: [],
  inputs: [
    { portId: 'plan', label: 'Plan', type: 'text', required: true },
    { portId: 'context', label: 'Context', type: 'text' }
  ],
  outputs: [{ portId: 'receipt', label: 'Receipt', type: 'markdown' }]
};

/**
 * Connections into `n-ship`, by index:
 *
 *   0  n-triage.verdict  → plan      resolved, and the one the offer ranked first
 *   1  n-triage.notes    → context   declared but unresolved
 *   2  n-build.artifact  → context   resolved, but its node did not complete
 *   3  n-triage.missing  → context   an output the Pipeline never declared
 *   4  n-absent.out      → context   a node with no recorded attempt
 *   5  n-triage.verdict  → unknown   a port the frozen Pipeline does not declare
 *   6  n-triage.verdict  → plan      a second binding for an already-filled port
 *   7  n-triage.verdict  → plan      into a different node entirely
 */
const GRAPH: WorkflowDefinition = {
  workflowId: 'release',
  name: 'Release',
  version: 1,
  nodes: [
    { nodeId: 'n-triage', pipelineId: 'triage-flow' },
    { nodeId: 'n-build', pipelineId: 'build-flow' },
    { nodeId: 'n-ship', pipelineId: 'ship-flow' },
    { nodeId: 'n-other', pipelineId: 'ship-flow' }
  ],
  connections: [
    { from: { nodeId: 'n-triage', portId: 'verdict' }, to: { nodeId: 'n-ship', portId: 'plan' } },
    { from: { nodeId: 'n-triage', portId: 'notes' }, to: { nodeId: 'n-ship', portId: 'context' } },
    { from: { nodeId: 'n-build', portId: 'artifact' }, to: { nodeId: 'n-ship', portId: 'context' } },
    { from: { nodeId: 'n-triage', portId: 'missing' }, to: { nodeId: 'n-ship', portId: 'context' } },
    { from: { nodeId: 'n-absent', portId: 'out' }, to: { nodeId: 'n-ship', portId: 'context' } },
    { from: { nodeId: 'n-triage', portId: 'verdict' }, to: { nodeId: 'n-ship', portId: 'unknown' } },
    { from: { nodeId: 'n-triage', portId: 'verdict' }, to: { nodeId: 'n-ship', portId: 'plan' } },
    { from: { nodeId: 'n-triage', portId: 'verdict' }, to: { nodeId: 'n-other', portId: 'plan' } }
  ],
  startNodeIds: ['n-triage']
};

const CONTEXT = buildConditionContext([TRIAGE_COMPLETED, BUILD_FAILED]);

/** Compose for `n-ship`, offered via the given connection indices in offer order. */
function prefillVia(...viaConnections: readonly number[]) {
  return composeContinuationPrefill({
    graph: GRAPH,
    pipeline: SHIP,
    nodeId: 'n-ship',
    viaConnections,
    context: CONTEXT
  });
}

describe('the prefill fills from a resolved binding (FR-035, FR-036)', () => {
  it('carries the bound output reference into the destination port', () => {
    const { request } = prefillVia(0);
    expect(request.inputs).toEqual([
      { portId: 'plan', type: 'text', value: 'reports/verdict.md' }
    ]);
  });

  it('says which connection and which source output filled each port', () => {
    expect(prefillVia(0).prefilled).toEqual([
      { portId: 'plan', connectionIndex: 0, sourceNodeId: 'n-triage', sourceOutput: 'verdict' }
    ]);
  });

  it('addresses the destination Pipeline and leaves the session material empty (FR-038)', () => {
    const { request } = prefillVia(0);
    expect(request.pipelineId).toBe('ship-flow');
    // Supplemental material and output targets are the operator's to name; a
    // guessed target would be a write to a location nobody chose.
    expect(request.supplemental).toEqual([]);
    expect(request.outputs).toEqual([]);
  });

  it('carries the recorded reference, never anything read from behind it', () => {
    // The value IS the workspace-relative reference the source run recorded. If
    // this ever became document content, the composer would be doing I/O.
    expect(prefillVia(0).request.inputs[0]!.value).toBe('reports/verdict.md');
  });
});

describe('a binding with nothing behind it is skipped, not raised (FR-037)', () => {
  it('offers no value from a node that has not completed', () => {
    // `n-build` failed. Its output resolved, and it is still not bindable —
    // the same answer `resolveOperand` gives a condition.
    const { request, prefilled } = prefillVia(2);
    expect(request.inputs).toEqual([]);
    expect(prefilled).toEqual([]);
  });

  it('offers no value from an output the run never produced', () => {
    expect(prefillVia(1).request.inputs).toEqual([]);
  });

  it('offers no value from an output the source never declared', () => {
    expect(prefillVia(3).request.inputs).toEqual([]);
  });

  it('offers no value from a node with no recorded attempt', () => {
    expect(prefillVia(4).request.inputs).toEqual([]);
  });

  it('skips a destination port the frozen Pipeline does not declare', () => {
    expect(prefillVia(5).request.inputs).toEqual([]);
  });

  it('ignores a connection that leads somewhere else', () => {
    expect(prefillVia(7).request.inputs).toEqual([]);
  });

  it('ignores an index the frozen graph does not hold', () => {
    expect(prefillVia(99).request.inputs).toEqual([]);
  });

  it('leaves the other bindings fillable — one unresolved operand blocks nothing', () => {
    // Every skip above, offered together with the one binding that resolves.
    const { request } = prefillVia(1, 2, 3, 4, 5, 0);
    expect(request.inputs).toEqual([
      { portId: 'plan', type: 'text', value: 'reports/verdict.md' }
    ]);
  });
});

describe('first binding wins for a port offered twice', () => {
  it('keeps the earlier connection rather than the later one', () => {
    // Both resolve to the same value here; what is being pinned is that exactly
    // one entry is produced and it names the connection offered first.
    const { request, prefilled } = prefillVia(6, 0);
    expect(request.inputs).toHaveLength(1);
    expect(prefilled).toEqual([
      { portId: 'plan', connectionIndex: 6, sourceNodeId: 'n-triage', sourceOutput: 'verdict' }
    ]);
  });
});

describe('the prefill is a draft (FR-039)', () => {
  it('composes without touching the run, the graph, or the Pipeline it read', () => {
    const graphBefore = JSON.stringify(GRAPH);
    const pipelineBefore = JSON.stringify(SHIP);
    prefillVia(0, 1, 2, 3, 4, 5, 6, 7);
    expect(JSON.stringify(GRAPH)).toBe(graphBefore);
    expect(JSON.stringify(SHIP)).toBe(pipelineBefore);
  });

  it('is recomputable — the same offer composes the same draft', () => {
    // Nothing is persisted between calls, so nothing can be stale. What starts a
    // run is the request the operator submits, validated like any other.
    expect(prefillVia(0)).toEqual(prefillVia(0));
  });
});
