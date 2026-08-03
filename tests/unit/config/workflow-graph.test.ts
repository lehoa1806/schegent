import { describe, expect, it } from 'vitest';
import {
  ancestorSets,
  reachableFrom,
  stronglyConnectedComponents,
  topologicalOrder,
  type WorkflowGraphEdge
} from '../../../src/config/workflow-graph';

const edge = (from: string, to: string): WorkflowGraphEdge => ({ from, to });

const sorted = (values: Iterable<string>): string[] => [...values].sort();

describe('topologicalOrder — Kahn 1962', () => {
  it('orders a chain so every edge points forward', () => {
    const nodes = ['a', 'b', 'c'];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const { order, residual } = topologicalOrder(nodes, edges);

    expect(order).toEqual(['a', 'b', 'c']);
    expect(residual).toEqual([]);
  });

  it('orders a diamond with both middles after the source and before the sink', () => {
    const nodes = ['a', 'b', 'c', 'd'];
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')];
    const { order, residual } = topologicalOrder(nodes, edges);

    expect(residual).toEqual([]);
    expect(order).toHaveLength(4);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('emits authored order for a graph with no edges', () => {
    const { order, residual } = topologicalOrder(['c', 'a', 'b'], []);
    expect(order).toEqual(['c', 'a', 'b']);
    expect(residual).toEqual([]);
  });

  it('leaves the cyclic part in the residual and the acyclic prefix in the order', () => {
    const nodes = ['start', 'a', 'b', 'tail'];
    const edges = [edge('start', 'a'), edge('a', 'b'), edge('b', 'a'), edge('b', 'tail')];
    const { order, residual } = topologicalOrder(nodes, edges);

    expect(order).toEqual(['start']);
    expect(sorted(residual)).toEqual(['a', 'b', 'tail']);
  });

  it('treats a self-edge as unorderable and keeps that node in the residual', () => {
    const { order, residual } = topologicalOrder(['a', 'b'], [edge('a', 'a'), edge('b', 'a')]);
    expect(order).toEqual(['b']);
    expect(residual).toEqual(['a']);
  });

  it('ignores an edge naming a node outside the node list', () => {
    const { order, residual } = topologicalOrder(['a', 'b'], [edge('a', 'ghost'), edge('a', 'b')]);
    expect(order).toEqual(['a', 'b']);
    expect(residual).toEqual([]);
  });

  it('is stable: the same input always yields the same order', () => {
    const nodes = ['a', 'b', 'c', 'd'];
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')];
    const first = topologicalOrder(nodes, edges).order;
    const second = topologicalOrder(nodes, edges).order;
    expect(second).toEqual(first);
  });
});

describe('stronglyConnectedComponents — Tarjan 1972 (FR-013)', () => {
  it('names both members of a two-cycle', () => {
    const components = stronglyConnectedComponents(['a', 'b'], [edge('a', 'b'), edge('b', 'a')]);
    expect(components).toHaveLength(1);
    expect(sorted(components[0])).toEqual(['a', 'b']);
  });

  it('names all three members of a three-cycle', () => {
    const components = stronglyConnectedComponents(
      ['a', 'b', 'c'],
      [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
    );
    expect(components).toHaveLength(1);
    expect(sorted(components[0])).toEqual(['a', 'b', 'c']);
  });

  it('reports two disjoint cycles separately, each with every member', () => {
    const components = stronglyConnectedComponents(
      ['a', 'b', 'x', 'y', 'z'],
      [edge('a', 'b'), edge('b', 'a'), edge('x', 'y'), edge('y', 'z'), edge('z', 'x')]
    );
    expect(components).toHaveLength(2);
    const bySize = [...components].sort((left, right) => left.length - right.length);
    expect(sorted(bySize[0])).toEqual(['a', 'b']);
    expect(sorted(bySize[1])).toEqual(['x', 'y', 'z']);
  });

  it('reports a self-loop as a cycle of one (Edge Cases)', () => {
    const components = stronglyConnectedComponents(['a', 'b'], [edge('a', 'a'), edge('a', 'b')]);
    expect(components).toHaveLength(1);
    expect(components[0]).toEqual(['a']);
  });

  it('reports nothing for an acyclic graph, including a diamond', () => {
    expect(
      stronglyConnectedComponents(
        ['a', 'b', 'c', 'd'],
        [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]
      )
    ).toEqual([]);
  });

  it('does not report a single node with no self-edge as a component', () => {
    // A trivial SCC is every node; only actual cycles are defects.
    expect(stronglyConnectedComponents(['a', 'b'], [edge('a', 'b')])).toEqual([]);
  });

  it('reports a cycle that hangs off an acyclic prefix', () => {
    const components = stronglyConnectedComponents(
      ['start', 'a', 'b'],
      [edge('start', 'a'), edge('a', 'b'), edge('b', 'a')]
    );
    expect(components).toHaveLength(1);
    expect(sorted(components[0])).toEqual(['a', 'b']);
  });
});

describe('reachableFrom — multi-source BFS (FR-014, FR-015)', () => {
  it('reaches every node downstream of a single start', () => {
    const reached = reachableFrom(['a'], [edge('a', 'b'), edge('b', 'c')]);
    expect(sorted(reached)).toEqual(['a', 'b', 'c']);
  });

  it('treats every allowed start as reachable from itself', () => {
    // A start with no incoming connection must never be reported unreachable.
    const reached = reachableFrom(['a', 'island'], [edge('a', 'b')]);
    expect(sorted(reached)).toEqual(['a', 'b', 'island']);
  });

  it('unions the reachable sets of several starts', () => {
    const reached = reachableFrom(['a', 'x'], [edge('a', 'b'), edge('x', 'y'), edge('y', 'b')]);
    expect(sorted(reached)).toEqual(['a', 'b', 'x', 'y']);
  });

  it('accepts a start that is also the target of an incoming connection', () => {
    // Legal: an operator may resume a graph part-way through.
    const reached = reachableFrom(['b'], [edge('a', 'b'), edge('b', 'c')]);
    expect(sorted(reached)).toEqual(['b', 'c']);
    expect(reached.has('a')).toBe(false);
  });

  it('omits a node no start can reach', () => {
    const reached = reachableFrom(['a'], [edge('a', 'b'), edge('orphan', 'b')]);
    expect(reached.has('orphan')).toBe(false);
  });

  it('terminates on a cyclic graph', () => {
    const reached = reachableFrom(['a'], [edge('a', 'b'), edge('b', 'a'), edge('b', 'c')]);
    expect(sorted(reached)).toEqual(['a', 'b', 'c']);
  });

  it('returns only the starts when there are no edges', () => {
    expect(sorted(reachableFrom(['a', 'b'], []))).toEqual(['a', 'b']);
  });
});

describe('ancestorSets — anc[v] = union over u->v of (anc[u] + u) (FR-023)', () => {
  it('accumulates transitively along a chain', () => {
    const order = ['a', 'b', 'c'];
    const ancestors = ancestorSets(order, [edge('a', 'b'), edge('b', 'c')]);

    expect(sorted(ancestors.get('a') ?? [])).toEqual([]);
    expect(sorted(ancestors.get('b') ?? [])).toEqual(['a']);
    expect(sorted(ancestors.get('c') ?? [])).toEqual(['a', 'b']);
  });

  it('unions both arms of a diamond at the sink', () => {
    const order = ['a', 'b', 'c', 'd'];
    const ancestors = ancestorSets(order, [
      edge('a', 'b'),
      edge('a', 'c'),
      edge('b', 'd'),
      edge('c', 'd')
    ]);

    expect(sorted(ancestors.get('b') ?? [])).toEqual(['a']);
    expect(sorted(ancestors.get('c') ?? [])).toEqual(['a']);
    // Union, not intersection: ancestry is any-path reachability, not dominance.
    expect(sorted(ancestors.get('d') ?? [])).toEqual(['a', 'b', 'c']);
  });

  it('gives a node with no incoming edge an empty ancestor set', () => {
    const ancestors = ancestorSets(['a', 'b'], [edge('a', 'b')]);
    expect(ancestors.get('a')?.size).toBe(0);
  });

  it('never lists a node as its own ancestor in an acyclic graph', () => {
    const order = ['a', 'b', 'c', 'd'];
    const ancestors = ancestorSets(order, [
      edge('a', 'b'),
      edge('a', 'c'),
      edge('b', 'd'),
      edge('c', 'd')
    ]);
    for (const [nodeId, set] of ancestors) {
      expect(set.has(nodeId)).toBe(false);
    }
  });

  it('populates an entry for every node in the supplied order', () => {
    const ancestors = ancestorSets(['a', 'b', 'c'], [edge('a', 'b')]);
    expect(sorted(ancestors.keys())).toEqual(['a', 'b', 'c']);
  });

  it('ignores an edge whose endpoint is outside the supplied order', () => {
    // The caller only passes an order for an acyclic graph; residual nodes are excluded.
    const ancestors = ancestorSets(['a', 'b'], [edge('a', 'b'), edge('ghost', 'b')]);
    expect(sorted(ancestors.get('b') ?? [])).toEqual(['a']);
  });
});
