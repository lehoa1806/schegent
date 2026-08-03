/**
 * Pure graph primitives for Workflow validation. No `vscode` import and no knowledge of the
 * Workflow contract: callers project their nodes and connections down to bare identifiers so
 * these routines stay testable in isolation and reusable by the validator, the derived-port
 * reader, and the sidebar projector alike.
 *
 * Algorithms are the textbook ones, chosen because they are proven, linear, and produce the
 * exact defect evidence the spec asks for rather than a yes/no answer:
 *   - `topologicalOrder` — Kahn (1962), which leaves every node it could not order in a
 *     residual, so acyclicity is decided and the offending region is isolated in one pass.
 *   - `stronglyConnectedComponents` — Tarjan (1972), which names *every* member of each cycle
 *     (FR-013) instead of reporting a single back edge.
 *   - `reachableFrom` — multi-source BFS over the allowed starts (FR-014, FR-015).
 *   - `ancestorSets` — forward accumulation over a topological order (FR-023).
 *
 * All are O(V+E) except ancestor accumulation, which is O(V*E) in set-union work and is bounded
 * in practice by the 20-node soft cap (research R3, R4, R5).
 */

/** A directed edge between two node identifiers. Endpoints outside the node list are ignored. */
export interface WorkflowGraphEdge {
  readonly from: string;
  readonly to: string;
}

export interface TopologicalOrderResult {
  /** Nodes in an order where every retained edge points forward. */
  readonly order: readonly string[];
  /**
   * Nodes Kahn could not place, in authored order. Empty exactly when the graph is acyclic;
   * otherwise it contains every cycle member plus everything downstream of one.
   */
  readonly residual: readonly string[];
}

function buildAdjacency(
  nodeIds: readonly string[],
  edges: readonly WorkflowGraphEdge[]
): Map<string, string[]> {
  const present = new Set(nodeIds);
  const adjacency = new Map<string, string[]>();
  for (const nodeId of nodeIds) {
    adjacency.set(nodeId, []);
  }
  for (const edge of edges) {
    if (!present.has(edge.from) || !present.has(edge.to)) {
      continue;
    }
    adjacency.get(edge.from)?.push(edge.to);
  }
  return adjacency;
}

/**
 * Kahn (1962). Deterministic: the ready queue is seeded and extended in authored node order, so
 * the same input always yields the same order — a defect list that reshuffles between renders
 * would be unusable in the builder.
 *
 * A self-edge contributes to its own in-degree and therefore never reaches zero, which is what
 * makes `residual` report a self-looping node without a special case.
 */
export function topologicalOrder(
  nodeIds: readonly string[],
  edges: readonly WorkflowGraphEdge[]
): TopologicalOrderResult {
  const adjacency = buildAdjacency(nodeIds, edges);
  const inDegree = new Map<string, number>();
  for (const nodeId of nodeIds) {
    inDegree.set(nodeId, 0);
  }
  for (const targets of adjacency.values()) {
    for (const target of targets) {
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    }
  }

  const queue = nodeIds.filter((nodeId) => inDegree.get(nodeId) === 0);
  const order: string[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const nodeId = queue[cursor];
    order.push(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) {
      const remaining = (inDegree.get(target) ?? 0) - 1;
      inDegree.set(target, remaining);
      if (remaining === 0) {
        queue.push(target);
      }
    }
  }

  const ordered = new Set(order);
  return { order, residual: nodeIds.filter((nodeId) => !ordered.has(nodeId)) };
}

interface TarjanState {
  readonly adjacency: Map<string, string[]>;
  readonly index: Map<string, number>;
  readonly lowLink: Map<string, number>;
  readonly onStack: Set<string>;
  readonly stack: string[];
  readonly components: string[][];
  readonly selfLooped: ReadonlySet<string>;
  nextIndex: number;
}

interface TarjanFrame {
  readonly nodeId: string;
  cursor: number;
}

function discover(state: TarjanState, nodeId: string): TarjanFrame {
  state.index.set(nodeId, state.nextIndex);
  state.lowLink.set(nodeId, state.nextIndex);
  state.nextIndex += 1;
  state.stack.push(nodeId);
  state.onStack.add(nodeId);
  return { nodeId, cursor: 0 };
}

function relax(state: TarjanState, nodeId: string, candidate: number): void {
  const current = state.lowLink.get(nodeId);
  if (current === undefined || candidate < current) {
    state.lowLink.set(nodeId, candidate);
  }
}

/** Advances one frame by a single neighbour; returns a new frame when it descends. */
function step(state: TarjanState, frame: TarjanFrame): TarjanFrame | null {
  const neighbours = state.adjacency.get(frame.nodeId) ?? [];
  const next = neighbours[frame.cursor];
  frame.cursor += 1;
  if (!state.index.has(next)) {
    return discover(state, next);
  }
  if (state.onStack.has(next)) {
    relax(state, frame.nodeId, state.index.get(next) ?? 0);
  }
  return null;
}

/**
 * Pops the completed frame. A root (`lowLink === index`) closes a component; only components
 * that are actual cycles are kept, so the trivial single-node SCC every acyclic node forms is
 * discarded unless that node carries a self-edge.
 */
function close(state: TarjanState, frame: TarjanFrame, parent: TarjanFrame | undefined): void {
  if (parent) {
    relax(state, parent.nodeId, state.lowLink.get(frame.nodeId) ?? 0);
  }
  if (state.lowLink.get(frame.nodeId) !== state.index.get(frame.nodeId)) {
    return;
  }
  const component: string[] = [];
  for (;;) {
    const member = state.stack.pop();
    if (member === undefined) {
      break;
    }
    state.onStack.delete(member);
    component.push(member);
    if (member === frame.nodeId) {
      break;
    }
  }
  if (component.length > 1 || state.selfLooped.has(component[0])) {
    state.components.push(component);
  }
}

/**
 * Tarjan (1972), iterative so an operator-authored graph can never overflow the stack. Callers
 * pass the `residual` from {@link topologicalOrder}; passing the full node list is also correct
 * and simply costs a walk over the acyclic part.
 *
 * Every returned component is a real cycle and names every one of its members (FR-013). A
 * self-edge is returned as a cycle of one.
 */
export function stronglyConnectedComponents(
  nodeIds: readonly string[],
  edges: readonly WorkflowGraphEdge[]
): readonly (readonly string[])[] {
  const present = new Set(nodeIds);
  const state: TarjanState = {
    adjacency: buildAdjacency(nodeIds, edges),
    index: new Map(),
    lowLink: new Map(),
    onStack: new Set(),
    stack: [],
    components: [],
    selfLooped: new Set(
      edges.filter((edge) => edge.from === edge.to && present.has(edge.from)).map((edge) => edge.from)
    ),
    nextIndex: 0
  };

  for (const root of nodeIds) {
    if (state.index.has(root)) {
      continue;
    }
    const frames: TarjanFrame[] = [discover(state, root)];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const exhausted = frame.cursor >= (state.adjacency.get(frame.nodeId) ?? []).length;
      if (!exhausted) {
        const descended = step(state, frame);
        if (descended) {
          frames.push(descended);
        }
        continue;
      }
      frames.pop();
      close(state, frame, frames[frames.length - 1]);
    }
  }

  return state.components;
}

/**
 * Multi-source BFS from the allowed starts (FR-014). Every start is in the result by
 * definition, so a start with no incoming connection is never reported unreachable, and a start
 * that is also a connection target is legal rather than a defect (FR-015).
 */
export function reachableFrom(
  startNodeIds: readonly string[],
  edges: readonly WorkflowGraphEdge[]
): ReadonlySet<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.from);
    if (targets) {
      targets.push(edge.to);
      continue;
    }
    adjacency.set(edge.from, [edge.to]);
  }

  const reached = new Set<string>();
  const queue: string[] = [];
  for (const startNodeId of startNodeIds) {
    if (reached.has(startNodeId)) {
      continue;
    }
    reached.add(startNodeId);
    queue.push(startNodeId);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const target of adjacency.get(queue[cursor]) ?? []) {
      if (reached.has(target)) {
        continue;
      }
      reached.add(target);
      queue.push(target);
    }
  }
  return reached;
}

/**
 * `anc[v] = ⋃_{u→v} (anc[u] ∪ {u})`, accumulated forward over a topological order (FR-023).
 *
 * This is any-path ancestry, not dominance: both arms of a diamond appear in the sink's set.
 * Requires an acyclic order — pass {@link TopologicalOrderResult.order}, never a node list that
 * still contains a cycle, or the accumulation is meaningless.
 */
export function ancestorSets(
  order: readonly string[],
  edges: readonly WorkflowGraphEdge[]
): ReadonlyMap<string, ReadonlySet<string>> {
  const adjacency = buildAdjacency(order, edges);
  const ancestors = new Map<string, Set<string>>();
  for (const nodeId of order) {
    ancestors.set(nodeId, new Set());
  }

  for (const nodeId of order) {
    const inherited = ancestors.get(nodeId) ?? new Set<string>();
    for (const target of adjacency.get(nodeId) ?? []) {
      const targetSet = ancestors.get(target);
      if (!targetSet) {
        continue;
      }
      targetSet.add(nodeId);
      for (const ancestor of inherited) {
        targetSet.add(ancestor);
      }
    }
  }
  return ancestors;
}
