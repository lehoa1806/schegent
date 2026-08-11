// Feature 088 (T014) — which successors are *offered*.
//
// The selector never starts anything (FR-032). It folds the frozen graph and the
// evaluation context into one `RoutingDecision`: what resolved, what matched,
// and what became eligible, in the order the operator will be offered them.
//
// The four properties that matter, and each has a way to go wrong quietly:
//
//   * a default is applied only when nothing explicit matched (FR-027) — the
//     failure mode is a default that fires alongside a matched branch;
//   * every match is preserved as a choice (FR-026) — the failure mode is a
//     selector that picks one and silently drops the rest;
//   * order is priority-ascending then authored (FR-029) — the failure mode is
//     an unprioritized connection jumping ahead of an explicit `priority: 1`;
//   * no match and no default is a *complete* run, not a failed one (FR-028).

import { describe, expect, it } from 'vitest';
import { buildConditionContext } from '../../../src/services/workflow-execution/condition-context';
import { selectNextNodes } from '../../../src/services/workflow-execution/next-node-selector';
import type {
  WorkflowConnection,
  WorkflowDefinition
} from '../../../src/contracts/workflow-definitions';

const CONTEXT = buildConditionContext([
  {
    nodeId: 'n-a',
    status: 'completed',
    outputs: [
      { name: 'verdict', status: 'resolved', reference: 'docs/pass.md' },
      { name: 'absent', status: 'unresolved' }
    ]
  }
]);

function graph(...connections: readonly WorkflowConnection[]): WorkflowDefinition {
  return {
    workflowId: 'wf',
    name: 'W',
    version: 1,
    nodes: [
      { nodeId: 'n-a', pipelineId: 'p' },
      { nodeId: 'n-b', pipelineId: 'p' },
      { nodeId: 'n-c', pipelineId: 'p' },
      { nodeId: 'n-d', pipelineId: 'p' }
    ],
    connections,
    startNodeIds: ['n-a']
  };
}

function edge(to: string, extra: Partial<WorkflowConnection> = {}): WorkflowConnection {
  return {
    from: { nodeId: 'n-a', portId: 'out' },
    to: { nodeId: to, portId: 'in' },
    ...extra
  };
}

const MATCHES: WorkflowConnection['condition'] = {
  left: { source: 'node-output', nodeId: 'n-a', field: 'verdict' },
  operator: 'equals',
  right: 'docs/pass.md'
};

const DOES_NOT_MATCH: WorkflowConnection['condition'] = {
  left: { source: 'node-output', nodeId: 'n-a', field: 'verdict' },
  operator: 'equals',
  right: 'docs/fail.md'
};

const UNRESOLVED: WorkflowConnection['condition'] = {
  left: { source: 'node-output', nodeId: 'n-a', field: 'absent' },
  operator: 'exists'
};

function decide(definition: WorkflowDefinition) {
  return selectNextNodes({
    graph: definition,
    nodeId: 'n-a',
    attemptIndex: 0,
    decidedAt: 1_700_000_000_000,
    context: CONTEXT
  });
}

describe('explicit matches', () => {
  it('offers a connection whose condition matched', () => {
    const decision = decide(graph(edge('n-b', { condition: MATCHES })));
    expect(decision.eligible).toEqual([0]);
    expect(decision.connections).toEqual([{ index: 0, matched: true, isDefault: false }]);
    expect(decision.defaultApplied).toBe(false);
  });

  it('does not offer one whose condition did not match, and records why', () => {
    const decision = decide(graph(edge('n-b', { condition: DOES_NOT_MATCH })));
    expect(decision.eligible).toEqual([]);
    expect(decision.connections).toEqual([{ index: 0, matched: false, isDefault: false }]);
    expect(decision.operands).toEqual([
      {
        source: 'node-output',
        nodeId: 'n-a',
        field: 'verdict',
        resolved: true,
        compared: 'docs/pass.md'
      }
    ]);
  });

  it('offers an unconditional connection, which is not a default', () => {
    const decision = decide(graph(edge('n-b')));
    expect(decision.eligible).toEqual([0]);
    expect(decision.defaultApplied).toBe(false);
    expect(decision.operands).toEqual([]);
  });

  it('ignores connections that leave a different node', () => {
    const decision = decide(
      graph(edge('n-b', { condition: MATCHES }), {
        from: { nodeId: 'n-b', portId: 'out' },
        to: { nodeId: 'n-c', portId: 'in' }
      })
    );
    expect(decision.eligible).toEqual([0]);
    expect(decision.connections.map((outcome) => outcome.index)).toEqual([0]);
  });
});

describe('multiple matches are all preserved (FR-026)', () => {
  it('offers every matching branch rather than picking one', () => {
    const decision = decide(
      graph(
        edge('n-b', { condition: MATCHES }),
        edge('n-c', { condition: MATCHES }),
        edge('n-d', { condition: DOES_NOT_MATCH })
      )
    );
    expect(decision.eligible).toEqual([0, 1]);
  });

  it('records one operand resolution per evaluated condition', () => {
    const decision = decide(
      graph(edge('n-b', { condition: MATCHES }), edge('n-c', { condition: UNRESOLVED }))
    );
    expect(decision.operands).toEqual([
      {
        source: 'node-output',
        nodeId: 'n-a',
        field: 'verdict',
        resolved: true,
        compared: 'docs/pass.md'
      },
      { source: 'node-output', nodeId: 'n-a', field: 'absent', resolved: false }
    ]);
  });
});

describe('the default connection (FR-027)', () => {
  it('applies only when nothing explicit matched', () => {
    const decision = decide(
      graph(edge('n-b', { condition: DOES_NOT_MATCH }), edge('n-c', { isDefault: true }))
    );
    expect(decision.eligible).toEqual([1]);
    expect(decision.defaultApplied).toBe(true);
    expect(decision.connections).toEqual([
      { index: 0, matched: false, isDefault: false },
      { index: 1, matched: true, isDefault: true }
    ]);
  });

  it('stays unapplied when an explicit condition matched', () => {
    const decision = decide(
      graph(edge('n-b', { condition: MATCHES }), edge('n-c', { isDefault: true }))
    );
    expect(decision.eligible).toEqual([0]);
    expect(decision.defaultApplied).toBe(false);
    expect(decision.connections).toEqual([
      { index: 0, matched: true, isDefault: false },
      { index: 1, matched: false, isDefault: true }
    ]);
  });

  it('stays unapplied when an unconditional connection is present', () => {
    const decision = decide(graph(edge('n-b'), edge('n-c', { isDefault: true })));
    expect(decision.eligible).toEqual([0]);
    expect(decision.defaultApplied).toBe(false);
  });

  it('is not applied when its own condition does not match', () => {
    const decision = decide(
      graph(
        edge('n-b', { condition: DOES_NOT_MATCH }),
        edge('n-c', { isDefault: true, condition: DOES_NOT_MATCH })
      )
    );
    expect(decision.eligible).toEqual([]);
    expect(decision.defaultApplied).toBe(false);
  });

  it('is considered last regardless of where it was authored', () => {
    const decision = decide(
      graph(edge('n-c', { isDefault: true }), edge('n-b', { condition: DOES_NOT_MATCH }))
    );
    expect(decision.eligible).toEqual([0]);
    expect(decision.defaultApplied).toBe(true);
  });
});

describe('offer order is priority then authored (FR-029)', () => {
  it('orders ascending by priority', () => {
    const decision = decide(
      graph(
        edge('n-b', { condition: MATCHES, priority: 5 }),
        edge('n-c', { condition: MATCHES, priority: 1 }),
        edge('n-d', { condition: MATCHES, priority: 3 })
      )
    );
    expect(decision.eligible).toEqual([1, 2, 0]);
  });

  it('breaks a priority tie by authored order', () => {
    const decision = decide(
      graph(
        edge('n-b', { condition: MATCHES, priority: 2 }),
        edge('n-c', { condition: MATCHES, priority: 2 })
      )
    );
    expect(decision.eligible).toEqual([0, 1]);
  });

  it('offers an unprioritized connection after every explicit priority', () => {
    // The alternative reading — treat absent as 0 — would push an unset
    // connection ahead of one the operator explicitly marked `priority: 1`,
    // which is the opposite of what marking it meant.
    const decision = decide(
      graph(
        edge('n-b', { condition: MATCHES }),
        edge('n-c', { condition: MATCHES, priority: 1 }),
        edge('n-d', { condition: MATCHES })
      )
    );
    expect(decision.eligible).toEqual([1, 0, 2]);
  });

  it('leaves the recorded outcomes in authored order, whatever the offer order', () => {
    // `connections` explains the evaluation; `eligible` is the offer. Reordering
    // the explanation would make an index in a defect report ambiguous.
    const decision = decide(
      graph(
        edge('n-b', { condition: MATCHES, priority: 9 }),
        edge('n-c', { condition: MATCHES, priority: 1 })
      )
    );
    expect(decision.connections.map((outcome) => outcome.index)).toEqual([0, 1]);
  });
});

describe('no match and no default (FR-028)', () => {
  it('offers nothing, without failing anything', () => {
    const decision = decide(graph(edge('n-b', { condition: DOES_NOT_MATCH })));
    expect(decision.eligible).toEqual([]);
    expect(decision.defaultApplied).toBe(false);
  });

  it('offers nothing when the node has no outgoing connections at all', () => {
    const decision = decide(graph());
    expect(decision).toEqual({
      nodeId: 'n-a',
      attemptIndex: 0,
      decidedAt: 1_700_000_000_000,
      operands: [],
      connections: [],
      defaultApplied: false,
      eligible: []
    });
  });
});

describe('the decision is a bounded record (FR-030, FR-066)', () => {
  it('carries the identity of the node and attempt it decided for', () => {
    const decision = decide(graph(edge('n-b', { condition: MATCHES })));
    expect(decision.nodeId).toBe('n-a');
    expect(decision.attemptIndex).toBe(0);
    expect(decision.decidedAt).toBe(1_700_000_000_000);
  });

  it('carries no destination node, port, or label — only connection indices', () => {
    const decision = decide(graph(edge('n-b', { condition: MATCHES })));
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain('n-b');
    expect(serialized).not.toContain('portId');
  });

  it('is frozen, so a caller cannot append to it after the fact', () => {
    const decision = decide(graph(edge('n-b', { condition: MATCHES })));
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.eligible)).toBe(true);
  });
});
