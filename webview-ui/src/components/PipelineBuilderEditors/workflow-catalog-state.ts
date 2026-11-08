// Feature 083 (US1, T037) — Workflow Builder draft state.
//
// Plain TypeScript, no Svelte runes and no DOM, for the same reason as
// `pipeline-catalog-state.ts`: every rule here is a pure function of a draft row
// and is unit-testable without rendering anything.
//
// The host remains authoritative. `validateWorkflowDraft` is advisory — it
// catches the handful of defects worth reporting before a round trip (a
// malformed id, a name the operator never filled in, a graph with no nodes or
// no start). It deliberately does NOT reimplement reachability, cycle
// detection, port type-matching, or condition bounds; those live in
// `src/config/workflow-graph-validator.ts` and the save gate is the only place
// entitled to decide them. Duplicating that logic here would be a second
// source of truth that drifts.
//
// Authored node and connection order is part of the definition's meaning
// (FR-049), so nothing in this module sorts, dedupes, or normalizes either
// list: add appends, edit replaces in place, remove closes the gap.

import { boundaryRefusalText } from '../../lib/boundary-refusal-text';
import {
  DEFAULT_CANDIDATE_ATTEMPTS,
  DEFAULT_CANDIDATE_AVAILABILITY_POLICY,
  DEFAULT_CANDIDATE_BLOCK_DISPATCHES,
  DEFAULT_MONITORING_WINDOW_MS,
  MAX_CANDIDATES_PER_BLOCK,
  MIN_CANDIDATES_PER_BLOCK,
  WORKFLOW_NODE_TERMINAL_STATUSES,
  type CandidateAvailabilityPolicy,
  type CandidateBlockControl,
  type CandidateDefinition,
  type CandidateRetryPolicy,
  type PipelineExecutionDefaults,
  type PortablePhaseDefinition,
  type PortablePipelineDefinition,
  type PortableWorkflowDefinition,
  type WorkflowBinding,
  type WorkflowCatalogFieldErrorProjection,
  type WorkflowCatalogSourceProjection,
  type WorkflowCondition,
  type WorkflowConditionLiteral,
  type WorkflowConditionOperand,
  type WorkflowConditionOperator,
  type WorkflowConnection,
  type WorkflowDecisionResults,
  type WorkflowInputPort,
  type WorkflowNode,
  type WorkflowOutputPort
} from '../../lib/snapshot-types';
import type { SaveWorkflowRow } from '../../lib/definition-rows';
import type { MutableWorkflow } from './types';

export type WorkflowNodeTarget =
  | string
  | { readonly kind: 'phase'; readonly phaseId: string }
  | { readonly kind: 'workflow'; readonly workflowId: string }
  | { readonly kind: 'pipeline'; readonly pipelineId: string };

export const MAX_WORKFLOW_NESTING_DEPTH = 8;

export interface ChildWorkflowPreviewNode {
  readonly nodeId: string;
  readonly label: string;
  readonly kind: 'phase' | 'workflow' | 'pipeline';
  readonly targetId: string;
  readonly children: readonly ChildWorkflowPreviewNode[];
  readonly truncatedReason?: 'cycle' | 'max-depth' | 'missing';
}

export interface ChildWorkflowPreview {
  readonly nodes: readonly ChildWorkflowPreviewNode[];
  readonly truncatedReason?: 'cycle' | 'max-depth' | 'missing';
}

/**
 * Shared with the Pipeline and Phase families on purpose — a Workflow id is
 * spelled the same way, and the host reuses one pattern across all three so
 * they cannot drift.
 */
export const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const WORKFLOW_NAME_MAX_LEN = 80;
export const WORKFLOW_DESCRIPTION_MAX_LEN = 1024;
export const WORKFLOW_LABEL_MAX_LEN = 80;

/** Advisory, webview-side defect. Shaped like the host's field error minus the id. */
export interface WorkflowDraftError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/**
 * Where a defect belongs in the Builder. A node or connection defect anchors to
 * its row so the operator sees it beside the control that produced it; anything
 * unrecognized or out of range anchors to the Workflow so it is never dropped.
 */
export type WorkflowErrorAnchor =
  | { readonly kind: 'field'; readonly field: string }
  | { readonly kind: 'node'; readonly index: number }
  | { readonly kind: 'node-list' }
  | { readonly kind: 'connection'; readonly index: number }
  | { readonly kind: 'connection-list' }
  | { readonly kind: 'starts' }
  | { readonly kind: 'workflow' };

/** Matches the host's own bound so a hostile row cannot flood the panel. */
export const MAX_VISIBLE_FIELD_ERRORS = 5;
export const FIELD_ERROR_MESSAGE_MAX_LEN = 160;

const SCALAR_FIELDS: ReadonlySet<string> = new Set([
  'workflowId',
  'name',
  'description',
  'version'
]);

/** `nodes[3]`, `connections[12].to`, `startNodeIds[0]` — index and remainder. */
const INDEXED_PATH = /^([A-Za-z]+)\[(\d+)\](?:\..*)?$/;

/**
 * Project one host record into an editable row.
 *
 * A record that failed to parse has `definition: null`, and its authored
 * scalars survive only in `display`. Falling back to those keeps what the
 * operator typed on screen next to the defect that rejected it; an empty row
 * would silently discard it.
 */
export function sourceRecordToMutableWorkflow(
  record: WorkflowCatalogSourceProjection
): MutableWorkflow {
  const definition = record.definition;
  const display = record.display;
  return {
    workflowId: definition?.workflowId ?? readDisplayString(display, 'workflowId') ?? record.workflowId,
    name: definition?.name ?? readDisplayString(display, 'name') ?? '',
    ...(definition?.description !== undefined ? { description: definition.description } : {}),
    version: definition?.version ?? readDisplayNumber(display, 'version') ?? 1,
    ...(definition?.inputs !== undefined ? { inputs: definition.inputs.map((port) => ({ ...port })) } : {}),
    ...(definition?.outputs !== undefined ? { outputs: definition.outputs.map((port) => ({ ...port })) } : {}),
    nodes: (definition?.nodes ?? []).map(copyNode),
    connections: (definition?.connections ?? []).map(copyConnection),
    ...(definition?.bindings !== undefined ? { bindings: definition.bindings.map(copyBinding) } : {}),
    startNodeIds: [...(definition?.startNodeIds ?? [])],
    ...(definition?.executionDefaults !== undefined
      ? { executionDefaults: { ...definition.executionDefaults } }
      : {}),
    ...(definition?.recommendedNext !== undefined
      ? { recommendedNext: [...definition.recommendedNext] }
      : {}),
    ...(definition?.control !== undefined
      ? { control: copyCandidateBlockControl(definition.control) }
      : {}),
    ...(definition?.decisionResults !== undefined
      ? { decisionResults: copyDecisionResults(definition.decisionResults) }
      : {}),
    sourceKey: record.key,
    sourceStatus: record.status,
    sourceErrors: record.errors,
    persisted: true,
    derivedInputs: record.derivedInputs,
    derivedOutputs: record.derivedOutputs
  };
}

/**
 * Reduce a draft to the authored contract fields. Nothing projection-only —
 * source status, derived ports, defect list — may ride back to the host,
 * and a blank description is omitted rather than persisted as an empty string.
 */
export function toSaveWorkflowRow(workflow: MutableWorkflow): SaveWorkflowRow {
  const description = workflow.description?.trim();
  const hasExecutionDefaults =
    workflow.executionDefaults !== undefined &&
    Object.values(workflow.executionDefaults).some((v) => v !== undefined && v !== '');
  return {
    workflowId: workflow.workflowId,
    name: workflow.name,
    ...(description ? { description } : {}),
    version: workflow.version,
    ...(workflow.inputs && workflow.inputs.length > 0
      ? { inputs: workflow.inputs.map((port) => ({ ...port })) }
      : {}),
    ...(workflow.outputs && workflow.outputs.length > 0
      ? { outputs: workflow.outputs.map((port) => ({ ...port })) }
      : {}),
    nodes: workflow.nodes.map(copyNode),
    connections: workflow.connections.map(copyConnection),
    ...(workflow.bindings && workflow.bindings.length > 0
      ? { bindings: workflow.bindings.map(copyBinding) }
      : {}),
    startNodeIds: [...workflow.startNodeIds],
    ...(hasExecutionDefaults ? { executionDefaults: { ...workflow.executionDefaults } } : {}),
    ...(workflow.recommendedNext && workflow.recommendedNext.length > 0
      ? { recommendedNext: [...workflow.recommendedNext] }
      : {}),
    ...(workflow.control !== undefined
      ? { control: copyCandidateBlockControl(workflow.control) }
      : {}),
    ...(workflow.decisionResults !== undefined
      ? { decisionResults: copyDecisionResults(workflow.decisionResults) }
      : {})
  };
}

/** Drafts created in this webview so far; only ever incremented, never reset. */
let draftSequence = 0;

/**
 * A source key for a draft, distinct from every other draft's and every stored record's.
 *
 * The editor files a draft, its edits and its undo history under `sourceKey`, and the id is the
 * one thing the operator can still change: rename the first draft and the id it was born with is
 * free again, so a key derived from that id would be handed out twice. The sequence number
 * identifies the draft instead. Stored records are keyed `<workflowId>::<index>`, so a key that
 * does not end in `::<number>` cannot equal one.
 */
function nextDraftSourceKey(workflowId: string): string {
  draftSequence += 1;
  return `${workflowId}::draft-${draftSequence}`;
}

/** A blank draft, with an id no row in the catalog already uses. */
export function makeNewWorkflowDraft(
  takenIds: readonly string[]
): MutableWorkflow {
  const workflowId = freeIdentifier('new-workflow', takenIds);
  return {
    workflowId,
    name: 'New Workflow',
    version: 1,
    nodes: [],
    connections: [],
    startNodeIds: [],
    sourceKey: nextDraftSourceKey(workflowId),
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: false,
    derivedInputs: [],
    derivedOutputs: []
  };
}

/** A copy of `source` under a free id, unsaved. */
export function makeDuplicateWorkflowDraft(
  source: MutableWorkflow,
  takenIds: readonly string[]
): MutableWorkflow {
  const workflowId = freeIdentifier(`${source.workflowId}-copy`, takenIds);
  return {
    ...source,
    workflowId,
    name: `${source.name} (copy)`.slice(0, WORKFLOW_NAME_MAX_LEN),
    ...(source.inputs ? { inputs: source.inputs.map((port) => ({ ...port })) } : {}),
    ...(source.outputs ? { outputs: source.outputs.map((port) => ({ ...port })) } : {}),
    nodes: source.nodes.map(copyNode),
    connections: source.connections.map(copyConnection),
    ...(source.bindings ? { bindings: source.bindings.map(copyBinding) } : {}),
    startNodeIds: [...source.startNodeIds],
    ...(source.executionDefaults ? { executionDefaults: { ...source.executionDefaults } } : {}),
    ...(source.recommendedNext ? { recommendedNext: [...source.recommendedNext] } : {}),
    ...(source.control ? { control: copyCandidateBlockControl(source.control) } : {}),
    ...(source.decisionResults ? { decisionResults: copyDecisionResults(source.decisionResults) } : {}),
    sourceKey: nextDraftSourceKey(workflowId),
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: false,
    // Host-derived, and no host has seen this row. Inheriting the source's
    // ports would go stale the first time the copy's graph is edited.
    derivedInputs: [],
    derivedOutputs: []
  };
}

/** Append a node. Appends, never inserts: authored order is the operator's. */
export function addWorkflowNode(workflow: MutableWorkflow, node: WorkflowNode): MutableWorkflow {
  return { ...workflow, nodes: [...workflow.nodes, copyNode(node)] };
}

/** Replace one node in place. An out-of-range index is a no-op. */
export function updateWorkflowNode(
  workflow: MutableWorkflow,
  index: number,
  patch: Partial<WorkflowNode>
): MutableWorkflow {
  if (!inRange(index, workflow.nodes.length)) return workflow;
  const nodes = workflow.nodes.map((node, i) =>
    i === index ? copyNode({ ...node, ...patch }) : node
  );
  return { ...workflow, nodes };
}

/**
 * Drop a node, and with it every connection and allowed start that named it.
 * Leaving a dangling endpoint behind would send the host a graph the operator
 * never authored and get the whole layer rejected on a defect they cannot see.
 */
export function removeWorkflowNode(workflow: MutableWorkflow, index: number): MutableWorkflow {
  if (!inRange(index, workflow.nodes.length)) return workflow;
  const removedId = workflow.nodes[index].nodeId;
  const nextBindings = workflow.bindings?.filter((binding) => {
    if (binding.nodeId === removedId) return false;
    if (binding.kind === 'input' && binding.source.from === 'node-output' && binding.source.nodeId === removedId) {
      return false;
    }
    return true;
  });
  return {
    ...workflow,
    nodes: workflow.nodes.filter((_, i) => i !== index),
    connections: workflow.connections.filter(
      (edge) => edge.from.nodeId !== removedId && edge.to.nodeId !== removedId
    ),
    ...(nextBindings !== undefined ? { bindings: nextBindings } : {}),
    startNodeIds: workflow.startNodeIds.filter((nodeId) => nodeId !== removedId)
  };
}

/** Append a connection at the end of the authored list. */
export function addWorkflowConnection(
  workflow: MutableWorkflow,
  connection: WorkflowConnection
): MutableWorkflow {
  return { ...workflow, connections: [...workflow.connections, copyConnection(connection)] };
}

/** Replace one connection in place. An out-of-range index is a no-op. */
export function updateWorkflowConnection(
  workflow: MutableWorkflow,
  index: number,
  patch: Partial<WorkflowConnection>
): MutableWorkflow {
  if (!inRange(index, workflow.connections.length)) return workflow;
  const connections = workflow.connections.map((edge, i) =>
    i === index ? copyConnection({ ...edge, ...patch }) : edge
  );
  return { ...workflow, connections };
}

/** Remove one connection by position, closing the gap. */
export function removeWorkflowConnection(
  workflow: MutableWorkflow,
  index: number
): MutableWorkflow {
  if (!inRange(index, workflow.connections.length)) return workflow;
  return { ...workflow, connections: workflow.connections.filter((_, i) => i !== index) };
}

/** Add or drop one allowed start, preserving the order the operator picked. */
export function toggleWorkflowStartNode(
  workflow: MutableWorkflow,
  nodeId: string
): MutableWorkflow {
  const startNodeIds = workflow.startNodeIds.includes(nodeId)
    ? workflow.startNodeIds.filter((entry) => entry !== nodeId)
    : [...workflow.startNodeIds, nodeId];
  return { ...workflow, startNodeIds };
}

// Feature 083 (US5, T056) — authoring the graph as two ordered lists.
//
// Reorder moves a row and nothing else. Unlike a Pipeline binding, which
// addresses its Phase by position and so has to be remapped on every reorder
// (see the hard rule in CLAUDE.md), a Workflow connection addresses its node by
// `nodeId`. Moving a node therefore cannot invalidate an endpoint, and there is
// no remap step here to forget — the absence is the design (FR-043).

/** Move one node `delta` places. Out-of-range on either end is a no-op. */
export function moveWorkflowNode(
  workflow: MutableWorkflow,
  index: number,
  delta: number
): MutableWorkflow {
  const nodes = movedWithin(workflow.nodes, index, delta);
  return nodes === null ? workflow : { ...workflow, nodes };
}

/** Move one connection `delta` places; the authored order is the tie-break. */
export function moveWorkflowConnection(
  workflow: MutableWorkflow,
  index: number,
  delta: number
): MutableWorkflow {
  const connections = movedWithin(workflow.connections, index, delta);
  return connections === null ? workflow : { ...workflow, connections };
}

/**
 * A node bound to `pipelineId`, under an id no node in this Workflow uses.
 *
 * The id is assigned here and never edited afterwards. It is pure identity —
 * connections and starts address it, and the operator names the node through
 * `label` instead. Letting it be retyped would mean cascading a rename through
 * every endpoint and start on each keystroke, for no gain the label does not
 * already give (FR-043).
 */
export function makeWorkflowNodeDraft(
  workflow: MutableWorkflow,
  target: WorkflowNodeTarget
): WorkflowNode {
  const nodeId = freeIdentifier('node', workflow.nodes.map((node) => node.nodeId));
  if (typeof target === 'string') {
    return { nodeId, pipelineId: target };
  }
  if (target.kind === 'phase') {
    return { nodeId, kind: 'phase', phaseId: target.phaseId };
  }
  if (target.kind === 'workflow') {
    return { nodeId, kind: 'workflow', workflowId: target.workflowId };
  }
  return { nodeId, pipelineId: target.pipelineId };
}

/**
 * Append a node that runs `target` — what the Actions palette does.
 *
 * The FIRST node of an empty Workflow is also marked a start. `startNodeIds` must
 * be non-empty (FR-015) and a lone node that starts nothing is reachable from
 * nothing, so without this the very first thing the operator adds is immediately
 * two defects they have to go and find the toggle for.
 *
 * Only when the Workflow was empty. A later node is not auto-started: once a
 * graph exists, which nodes may begin it is a decision the operator has already
 * made, and quietly adding to it would change how the Workflow runs.
 */
export function appendWorkflowNode(
  workflow: MutableWorkflow,
  target: WorkflowNodeTarget
): MutableWorkflow {
  const first = workflow.nodes.length === 0;
  const node = makeWorkflowNodeDraft(workflow, target);
  const appended = addWorkflowNode(workflow, node);
  return first ? toggleWorkflowStartNode(appended, node.nodeId) : appended;
}

function buildDefaultEndpoint(
  node: WorkflowNode,
  pipelines: readonly PortablePipelineDefinition[],
  direction: 'in' | 'out',
  workflows: readonly Pick<PortableWorkflowDefinition, 'workflowId' | 'inputs' | 'outputs'>[] = []
): { readonly nodeId: string; readonly portId?: string } {
  if (node.kind === 'phase' || node.phaseId !== undefined) {
    return { nodeId: node.nodeId };
  }
  const ports = workflowPortIds(node, pipelines, direction, workflows);
  if (node.kind === 'workflow' || node.workflowId !== undefined) {
    return ports[0] ? { nodeId: node.nodeId, portId: ports[0] } : { nodeId: node.nodeId };
  }
  return { nodeId: node.nodeId, portId: ports[0] ?? '' };
}

/**
 * Append a node and wire it downstream of `sourceNodeId` — the canvas `+` that
 * sits on the edge between two cards.
 */
export function insertWorkflowNodeAfter(
  workflow: MutableWorkflow,
  sourceNodeId: string,
  target: WorkflowNodeTarget,
  pipelines: readonly PortablePipelineDefinition[],
  workflows: readonly Pick<PortableWorkflowDefinition, 'workflowId' | 'inputs' | 'outputs'>[] = []
): MutableWorkflow {
  const source = workflow.nodes.find((node) => node.nodeId === sourceNodeId);
  if (!source) return workflow;
  const node = makeWorkflowNodeDraft(workflow, target);
  return addWorkflowConnection(addWorkflowNode(workflow, node), {
    from: buildDefaultEndpoint(source, pipelines, 'out', workflows),
    to: buildDefaultEndpoint(node, pipelines, 'in', workflows)
  });
}

/**
 * Put a new node ON an existing connection — the canvas `+` that sits between
 * two cards, which splices rather than forks.
 */
export function spliceWorkflowNodeIntoConnection(
  workflow: MutableWorkflow,
  index: number,
  target: WorkflowNodeTarget,
  pipelines: readonly PortablePipelineDefinition[],
  workflows: readonly Pick<PortableWorkflowDefinition, 'workflowId' | 'inputs' | 'outputs'>[] = []
): MutableWorkflow {
  if (!inRange(index, workflow.connections.length)) return workflow;
  const connection = workflow.connections[index];
  if (connection.from.nodeId === connection.to.nodeId) return workflow;
  const node = makeWorkflowNodeDraft(workflow, target);
  const inserted = addWorkflowNode(workflow, node);
  const rerouted = updateWorkflowConnection(inserted, index, {
    to: buildDefaultEndpoint(node, pipelines, 'in', workflows)
  });
  return addWorkflowConnection(rerouted, {
    from: buildDefaultEndpoint(node, pipelines, 'out', workflows),
    to: {
      nodeId: connection.to.nodeId,
      ...(connection.to.portId !== undefined ? { portId: connection.to.portId } : {}),
      ...(connection.to.kind !== undefined ? { kind: connection.to.kind } : {})
    }
  });
}

/**
 * Another outgoing arm on `sourceNodeId`, which is how a split is authored.
 */
export function addWorkflowBranch(
  workflow: MutableWorkflow,
  sourceNodeId: string,
  pipelines: readonly PortablePipelineDefinition[],
  workflows: readonly Pick<PortableWorkflowDefinition, 'workflowId' | 'inputs' | 'outputs'>[] = []
): MutableWorkflow {
  const source = workflow.nodes.find((node) => node.nodeId === sourceNodeId);
  if (!source) return workflow;
  const outgoing = workflow.connections.filter((edge) => edge.from.nodeId === sourceNodeId);
  // Any node but the source, so the seed is not a self-edge when one exists.
  const target = workflow.nodes.find((node) => node.nodeId !== sourceNodeId) ?? source;
  const fallback = outgoing.length > 0 && !outgoing.some((edge) => edge.isDefault === true);
  return addWorkflowConnection(workflow, {
    from: buildDefaultEndpoint(source, pipelines, 'out', workflows),
    to: buildDefaultEndpoint(target, pipelines, 'in', workflows),
    ...(fallback ? { isDefault: true } : {})
  });
}

/**
 * Point one end of a connection at a different node or port.
 */
export function retargetWorkflowConnection(
  workflow: MutableWorkflow,
  index: number,
  end: 'from' | 'to',
  patch: { readonly nodeId?: string; readonly portId?: string; readonly kind?: 'node' | 'return' },
  pipelines: readonly PortablePipelineDefinition[],
  workflows: readonly Pick<PortableWorkflowDefinition, 'workflowId' | 'inputs' | 'outputs'>[] = []
): MutableWorkflow {
  if (!inRange(index, workflow.connections.length)) return workflow;
  const current = workflow.connections[index][end];
  if (patch.nodeId !== undefined && patch.nodeId !== current.nodeId) {
    const node = workflow.nodes.find((entry) => entry.nodeId === patch.nodeId);
    const direction = end === 'from' ? 'out' : 'in';
    const nextEndpoint = node
      ? buildDefaultEndpoint(node, pipelines, direction, workflows)
      : { nodeId: patch.nodeId, portId: '' };
    return updateWorkflowConnection(workflow, index, { [end]: nextEndpoint });
  }
  if (patch.portId !== undefined || patch.kind !== undefined) {
    const nextPortId = patch.portId !== undefined ? patch.portId : current.portId;
    const nextKind = end === 'to' ? (patch.kind ?? (current as { kind?: 'node' | 'return' }).kind) : undefined;
    return updateWorkflowConnection(workflow, index, {
      [end]: {
        nodeId: current.nodeId,
        ...(nextPortId !== undefined && nextPortId !== '' ? { portId: nextPortId } : nextPortId === '' && workflow.nodes.find((n) => n.nodeId === current.nodeId)?.pipelineId !== undefined ? { portId: '' } : {}),
        ...(nextKind !== undefined ? { kind: nextKind } : {})
      }
    });
  }
  return workflow;
}

/**
 * The ports a node offers, read from its child Workflow or Pipeline declaration.
 */
export function workflowPortIds(
  node: WorkflowNode | undefined,
  pipelines: readonly PortablePipelineDefinition[],
  direction: 'in' | 'out',
  workflows: readonly Pick<PortableWorkflowDefinition, 'workflowId' | 'inputs' | 'outputs'>[] = []
): readonly string[] {
  if (node?.workflowId !== undefined) {
    const child = workflows.find((entry) => entry.workflowId === node.workflowId);
    if (!child) return [];
    const ports = direction === 'in' ? child.inputs : child.outputs;
    return Array.isArray(ports) ? ports.map((port) => port.portId) : [];
  }
  const pipeline = pipelines.find((entry) => entry.pipelineId === node?.pipelineId);
  if (!pipeline) return [];
  const ports = direction === 'in' ? pipeline.inputs : pipeline.outputs;
  return Array.isArray(ports) ? ports.map((port) => port.portId) : [];
}

/** Defects bucketed by the row that has to show them; indexes align with the lists. */
export interface AnchoredWorkflowDefects {
  readonly byNode: readonly (readonly WorkflowDraftError[])[];
  readonly byConnection: readonly (readonly WorkflowDraftError[])[];
  /** Everything anchored to a scalar field, a whole list, the starts, or nowhere. */
  readonly rest: readonly WorkflowDraftError[];
}

/**
 * Sort defects into the rows that own them (FR-044). Nothing is dropped: a
 * defect whose anchor is not a row lands in `rest`, so a code this build does
 * not recognize still reaches the operator rather than vanishing.
 */
export function anchorWorkflowDefects(
  errors: readonly (WorkflowDraftError | WorkflowCatalogFieldErrorProjection)[],
  workflow: MutableWorkflow
): AnchoredWorkflowDefects {
  const byNode: WorkflowDraftError[][] = workflow.nodes.map(() => []);
  const byConnection: WorkflowDraftError[][] = workflow.connections.map(() => []);
  const rest: WorkflowDraftError[] = [];

  for (const error of errors) {
    const anchor = workflowErrorAnchor(error, workflow);
    const entry = { field: error.field, code: error.code, message: error.message };
    if (anchor.kind === 'node') byNode[anchor.index].push(entry);
    else if (anchor.kind === 'connection') byConnection[anchor.index].push(entry);
    else rest.push(entry);
  }

  return { byNode, byConnection, rest };
}

/** `null` when the move would leave the list, so the caller can no-op cleanly. */
function movedWithin<T>(items: readonly T[], index: number, delta: number): T[] | null {
  const target = index + delta;
  if (!inRange(index, items.length) || !inRange(target, items.length)) return null;
  const next = [...items];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

// Feature 083 (US4, T048) — condition authoring.
//
// A condition is structured data, never an expression string (FR-021). Every
// choice that decides its meaning is a closed set, so the Builder can offer each
// one as a select and there is no text field an expression could be composed in.
// The only free text left is the value being compared against, which FR-024
// bounds to a literal.
//
// The coercions below exist because switching operator or operand source can
// leave a right operand the host would reject — an `in` with no values, an
// `exists` that still carries one, a run status of `high`. Fixing that up here
// keeps the draft authorable instead of putting a defect on screen the operator
// did not cause. This is authoring convenience, not validation: the save gate
// still decides, and none of the graph rules are reimplemented (see the header).

/**
 * The operand sources a condition may read. The contract expresses these as a
 * discriminated union rather than a list, so `satisfies` is what ties the two
 * together: a renamed member fails to compile here.
 */
export const WORKFLOW_CONDITION_OPERAND_SOURCES = [
  'node-output',
  'node-status'
] as const satisfies readonly WorkflowConditionOperand['source'][];
export type WorkflowConditionOperandSource =
  (typeof WORKFLOW_CONDITION_OPERAND_SOURCES)[number];

/** `exists` takes no right operand, `in` takes a list, the rest take one literal. */
export type WorkflowConditionRightArity = 'none' | 'one' | 'list';

export function conditionRightArity(operator: WorkflowConditionOperator): WorkflowConditionRightArity {
  if (operator === 'exists') return 'none';
  if (operator === 'in') return 'list';
  return 'one';
}

/** A field-level edit to a condition. Values are edited through the helpers below. */
export interface WorkflowConditionPatch {
  readonly source?: WorkflowConditionOperandSource;
  readonly nodeId?: string;
  readonly field?: string;
  readonly operator?: WorkflowConditionOperator;
}

/**
 * The condition a newly conditional connection starts from.
 *
 * `node-status` deliberately: a `node-output` operand additionally requires the
 * named node's Pipeline to declare a structured output port and a field within
 * it, so that default would be rejected the moment it appeared. A completed-run
 * check is authorable against any node.
 */
export function makeWorkflowCondition(nodeId: string): WorkflowCondition {
  return { left: { source: 'node-status', nodeId }, operator: 'equals', right: 'completed' };
}

/** The right operand as a list, whatever form it was authored in. */
export function conditionValues(
  condition: WorkflowCondition
): readonly WorkflowConditionLiteral[] {
  const right = condition.right;
  if (right === undefined) return [];
  return isLiteralList(right) ? right : [right];
}

/**
 * Patch one connection's condition. A connection that carries none is left
 * alone: enabling and clearing go through `updateWorkflowConnection`, so this
 * function never has to invent an operand out of nothing.
 */
export function updateWorkflowCondition(
  workflow: MutableWorkflow,
  index: number,
  patch: WorkflowConditionPatch
): MutableWorkflow {
  const current = conditionAt(workflow, index);
  if (current === null) return workflow;

  let left = current.left;
  if (patch.source !== undefined && patch.source !== left.source) {
    left =
      patch.source === 'node-output'
        ? { source: 'node-output', nodeId: left.nodeId, field: '' }
        : { source: 'node-status', nodeId: left.nodeId };
  }
  if (patch.nodeId !== undefined) left = { ...left, nodeId: patch.nodeId };
  // A `node-status` operand has no field, so the patch has nowhere to land.
  if (patch.field !== undefined && left.source === 'node-output') {
    left = { ...left, field: patch.field };
  }

  const operator = patch.operator ?? current.operator;
  return writeCondition(workflow, index, left, operator, current.right);
}

/** Replace one authored value. Index 0 addresses the single slot of a scalar operator. */
export function updateWorkflowConditionValue(
  workflow: MutableWorkflow,
  index: number,
  valueIndex: number,
  value: WorkflowConditionLiteral
): MutableWorkflow {
  const current = conditionAt(workflow, index);
  if (current === null) return workflow;
  const values = conditionValues(current);
  if (!inRange(valueIndex, values.length)) return workflow;
  const next = values.map((entry, i) => (i === valueIndex ? value : entry));
  return writeCondition(workflow, index, current.left, current.operator, next);
}

/** Append an empty slot to an `in` list. A no-op for any other operator. */
export function addWorkflowConditionValue(
  workflow: MutableWorkflow,
  index: number
): MutableWorkflow {
  const current = conditionAt(workflow, index);
  if (current === null || conditionRightArity(current.operator) !== 'list') return workflow;
  const next = [...conditionValues(current), seedLiteral(current.left.source)];
  return writeCondition(workflow, index, current.left, current.operator, next);
}

/** Drop one value from an `in` list, never the last: an empty list is rejected. */
export function removeWorkflowConditionValue(
  workflow: MutableWorkflow,
  index: number,
  valueIndex: number
): MutableWorkflow {
  const current = conditionAt(workflow, index);
  if (current === null || conditionRightArity(current.operator) !== 'list') return workflow;
  const values = conditionValues(current);
  if (!inRange(valueIndex, values.length) || values.length <= 1) return workflow;
  const next = values.filter((_, i) => i !== valueIndex);
  return writeCondition(workflow, index, current.left, current.operator, next);
}

/**
 * Read one typed value as the literal it is: the text as typed, unchanged.
 *
 * FR-R4-F07 (FR-027; TA5) -- v1 operands are text (a node status, or the location reference an output
 * is recorded as), and the evaluator compares only values of the same type. A number or a boolean under
 * `equals` can therefore never match, and the host now refuses it. This used to read `true` and `false`
 * as booleans and a plain decimal as a number, which made `equals 5` the easiest thing to author and a
 * condition that could never hold; the cost of that rule was that the string `"5"` was not authorable at
 * all. Both are fixed by keeping what is typed. The declared type stays `WorkflowConditionLiteral`, so no
 * caller changes, and a stored numeric or boolean literal still loads and is shown as its text
 * (`formatWorkflowConditionLiteral`), where the host's defect asks the operator to repair it.
 */
export function parseWorkflowConditionLiteral(text: string): WorkflowConditionLiteral {
  return text;
}

/**
 * A branch `priority` as the control spells it, or `undefined` for "unset".
 *
 * Blank means unset rather than zero, and that distinction is load-bearing: the
 * offer order treats an absent priority as *last*, while `0` would put the arm
 * first. Anything that is not a whole number also comes back `undefined` — the
 * host reports `invalid-range` for a bad one, and inventing a number the operator
 * did not type would author an ordering they never chose.
 */
export function parseWorkflowPriority(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : undefined;
}

/** The inverse: what the value control shows for an authored literal. */
export function formatWorkflowConditionLiteral(
  value: WorkflowConditionLiteral | undefined
): string {
  return value === undefined ? '' : String(value);
}

/**
 * Decide where one defect belongs. Handles the whole field-path vocabulary the
 * host emits, and falls back to the Workflow level for anything it does not
 * recognize or that addresses a row this draft no longer has — an error with
 * nowhere of its own to land stays visible rather than disappearing.
 */
export function workflowErrorAnchor(
  error: WorkflowDraftError | WorkflowCatalogFieldErrorProjection,
  workflow: MutableWorkflow
): WorkflowErrorAnchor {
  const field = error.field;
  if (SCALAR_FIELDS.has(field)) return { kind: 'field', field };
  if (field === 'nodes') return { kind: 'node-list' };
  if (field === 'connections') return { kind: 'connection-list' };
  if (field === 'startNodeIds' || field.startsWith('startNodeIds[')) return { kind: 'starts' };

  const match = INDEXED_PATH.exec(field);
  if (match) {
    const index = Number(match[2]);
    if (match[1] === 'nodes' && inRange(index, workflow.nodes.length)) {
      return { kind: 'node', index };
    }
    if (match[1] === 'connections' && inRange(index, workflow.connections.length)) {
      return { kind: 'connection', index };
    }
  }
  return { kind: 'workflow' };
}

/** Cap the visible defect list and each message, reporting what was hidden. */
export interface BoundedFieldErrors {
  readonly visible: readonly WorkflowDraftError[];
  readonly hiddenCount: number;
}

export function boundFieldErrors(
  errors: readonly (WorkflowDraftError | WorkflowCatalogFieldErrorProjection)[]
): BoundedFieldErrors {
  const visible = errors.slice(0, MAX_VISIBLE_FIELD_ERRORS).map((error) => ({
    field: error.field,
    code: error.code,
    message: truncate(error.message, FIELD_ERROR_MESSAGE_MAX_LEN)
  }));
  return { visible, hiddenCount: Math.max(0, errors.length - visible.length) };
}

/**
 * Advisory pre-save checks. Everything here is cheap, local, and unambiguous;
 * the graph rules the host owns are deliberately absent (see the module header).
 *
 * @param takenIds Identifiers already used in the catalog. A persisted row
 *                 keeping its own id is not colliding with itself, so the
 *                 uniqueness check applies to drafts only.
 */
export function validateWorkflowDraft(
  workflow: MutableWorkflow,
  takenIds: readonly string[]
): readonly WorkflowDraftError[] {
  const errors: WorkflowDraftError[] = [];

  if (!WORKFLOW_ID_PATTERN.test(workflow.workflowId)) {
    errors.push({
      field: 'workflowId',
      code: 'invalid-pattern',
      message: 'Use lower-case letters, digits, and hyphens, starting with a letter (max 64).'
    });
  } else if (!workflow.persisted && takenIds.includes(workflow.workflowId)) {
    errors.push({
      field: 'workflowId',
      code: 'duplicate-id',
      message: `A Workflow named "${workflow.workflowId}" already exists.`
    });
  }

  if (workflow.name.trim().length === 0) {
    errors.push({ field: 'name', code: 'required', message: 'Name is required.' });
  } else if (workflow.name.length > WORKFLOW_NAME_MAX_LEN) {
    errors.push({
      field: 'name',
      code: 'too-long',
      message: `Name must be ${WORKFLOW_NAME_MAX_LEN} characters or fewer.`
    });
  }

  if ((workflow.description?.length ?? 0) > WORKFLOW_DESCRIPTION_MAX_LEN) {
    errors.push({
      field: 'description',
      code: 'too-long',
      message: `Description must be ${WORKFLOW_DESCRIPTION_MAX_LEN} characters or fewer.`
    });
  }

  if (workflow.nodes.length === 0) {
    errors.push({
      field: 'nodes',
      code: 'non-empty-required',
      message: 'A Workflow needs at least one step.'
    });
  }

  const seen = new Set<string>();
  workflow.nodes.forEach((node, index) => {
    if (seen.has(node.nodeId)) {
      errors.push({
        field: `nodes[${index}].nodeId`,
        code: 'duplicate-node-id',
        message: `Node id "${node.nodeId}" is already used in this Workflow.`
      });
    }
    seen.add(node.nodeId);
    if (node.label !== undefined && node.label.length > WORKFLOW_LABEL_MAX_LEN) {
      errors.push({
        field: `nodes[${index}].label`,
        code: 'too-long',
        message: `Label must be ${WORKFLOW_LABEL_MAX_LEN} characters or fewer.`
      });
    }
  });

  errors.push(...portLabelErrors('inputs', workflow.inputs ?? []));
  errors.push(...portLabelErrors('outputs', workflow.outputs ?? []));

  if (workflow.startNodeIds.length === 0 && workflow.nodes.length > 0) {
    errors.push({
      field: 'startNodeIds',
      code: 'invalid-start-set',
      message: 'Choose at least one node the Workflow may start from.'
    });
  }

  return errors;
}

/**
 * A declared public port needs a label of 1 to `WORKFLOW_LABEL_MAX_LEN` characters once trimmed;
 * the host enforces the same bound at Publish. The input has no length limit of its own, so a
 * label cleared or over-typed here would otherwise save as a draft that cannot be published.
 */
function portLabelErrors(
  side: 'inputs' | 'outputs',
  ports: readonly { readonly label: string }[]
): readonly WorkflowDraftError[] {
  const errors: WorkflowDraftError[] = [];
  ports.forEach((port, index) => {
    const length = port.label.trim().length;
    if (length === 0) {
      errors.push({
        field: `${side}[${index}].label`,
        code: 'required',
        message: 'Port label is required.'
      });
    } else if (length > WORKFLOW_LABEL_MAX_LEN) {
      errors.push({
        field: `${side}[${index}].label`,
        code: 'too-long',
        message: `Port label must be ${WORKFLOW_LABEL_MAX_LEN} characters or fewer.`
      });
    }
  });
  return errors;
}

/** Dirty compares the save shape only: a status badge changing is not an edit. */
export function isWorkflowDirty(
  workflow: MutableWorkflow,
  baseline: MutableWorkflow | null
): boolean {
  if (baseline === null) return true;
  return JSON.stringify(toSaveWorkflowRow(workflow)) !== JSON.stringify(toSaveWorkflowRow(baseline));
}

/**
 * The host's `workflow-validation` payload as it arrives over IPC. Every field
 * is optional because this crossed a boundary: a host on an older or newer
 * bundle may omit any of them, and a missing `total` just means "however many
 * were sent".
 */
interface WorkflowSaveRejectionResult {
  readonly errors?: readonly {
    readonly workflowId?: string;
    readonly field?: string;
    readonly code?: string;
    readonly message?: string;
  }[];
  readonly total?: number;
  readonly ancestryChecksSuppressed?: boolean;
}

/**
 * Turn a host rejection into one line the operator can act on. A reason this function has no
 * sentence for goes through the shared boundary text (FR-R4-F05, FR-014): a code-shaped reason
 * is still named, inside a fixed sentence, because a reason this build does not know about is
 * still information, but free text and the bare dispatch-failure code are not shown.
 */
export function formatWorkflowSaveRejection(
  reason: string,
  result: WorkflowSaveRejectionResult | undefined
): string {
  if (reason === 'stale-catalog') {
    return 'This Workflow layer changed since you started editing. Refresh to take the current version, or reapply your edits on top of it.';
  }
  if (reason !== 'workflow-validation') return boundaryRefusalText(reason);

  const errors = result?.errors ?? [];
  const shown = errors.slice(0, MAX_VISIBLE_FIELD_ERRORS);
  const total = result?.total ?? errors.length;
  const hidden = Math.max(0, total - shown.length);
  const lines = shown.map((error) =>
    error.field ? `${error.field}: ${error.message ?? ''}`.trim() : (error.message ?? '')
  );
  if (hidden > 0) lines.push(`+${hidden} more`);
  if (result?.ancestryChecksSuppressed) {
    lines.push(
      'The graph has a cycle, so the check that a condition reads only an earlier node was not run. Cut the cycle and save again to see any remaining condition defects.'
    );
  }
  return lines.length > 0 ? lines.join('\n') : reason;
}

/**
 * A node label is optional, but one that is present must have content: the host refuses an
 * authored label whose trimmed text is empty. The Label input patches on every keystroke, so
 * clearing it arrives here as `''`; dropping the field returns the node to "no label authored"
 * (the placeholder shows its id) instead of storing a value that cannot publish. The text is kept
 * as typed otherwise, so the space between two words survives while the operator is still typing.
 */
function copyNode(node: WorkflowNode): WorkflowNode {
  return {
    nodeId: node.nodeId,
    ...(node.kind !== undefined ? { kind: node.kind } : {}),
    ...(node.phaseId !== undefined ? { phaseId: node.phaseId } : {}),
    ...(node.workflowId !== undefined ? { workflowId: node.workflowId } : {}),
    ...(node.pipelineId !== undefined ? { pipelineId: node.pipelineId } : {}),
    ...(node.label !== undefined && node.label.trim().length > 0 ? { label: node.label } : {})
  };
}

function copyBinding(binding: WorkflowBinding): WorkflowBinding {
  if (binding.kind === 'input') {
    return {
      kind: 'input',
      nodeId: binding.nodeId,
      inputKey: binding.inputKey,
      ...(binding.type !== undefined ? { type: binding.type } : {}),
      ...(binding.required !== undefined ? { required: binding.required } : {}),
      source:
        binding.source.from === 'workflow-input'
          ? { from: 'workflow-input', portId: binding.source.portId }
          : { from: 'node-output', nodeId: binding.source.nodeId, portId: binding.source.portId },
      ...(binding.selection !== undefined ? { selection: binding.selection } : {})
    };
  }
  return {
    kind: 'output',
    nodeId: binding.nodeId,
    portId: binding.portId,
    ...(binding.outputKey !== undefined ? { outputKey: binding.outputKey } : {}),
    ...(binding.sourcePortId !== undefined ? { sourcePortId: binding.sourcePortId } : {}),
    ...(binding.type !== undefined ? { type: binding.type } : {}),
    ...(binding.label !== undefined ? { label: binding.label } : {}),
    ...(binding.selection !== undefined ? { selection: binding.selection } : {})
  };
}

export function addWorkflowInputPort(
  workflow: MutableWorkflow,
  port?: Partial<WorkflowInputPort>
): MutableWorkflow {
  const existing = workflow.inputs ?? [];
  const portId = port?.portId ?? freeIdentifier('input', existing.map((p) => p.portId));
  const next: WorkflowInputPort = {
    portId,
    label: port?.label ?? 'Input',
    type: port?.type ?? 'text',
    ...(port?.required !== undefined ? { required: port.required } : { required: true }),
    ...(port?.description !== undefined ? { description: port.description } : {})
  };
  return { ...workflow, inputs: [...existing, next] };
}

export function updateWorkflowInputPort(
  workflow: MutableWorkflow,
  index: number,
  patch: Partial<WorkflowInputPort>
): MutableWorkflow {
  const existing = workflow.inputs ?? [];
  if (!inRange(index, existing.length)) return workflow;
  const inputs = existing.map((port, i) => (i === index ? { ...port, ...patch } : port));
  return { ...workflow, inputs };
}

export function removeWorkflowInputPort(
  workflow: MutableWorkflow,
  index: number
): MutableWorkflow {
  const existing = workflow.inputs ?? [];
  if (!inRange(index, existing.length)) return workflow;
  return { ...workflow, inputs: existing.filter((_, i) => i !== index) };
}

export function addWorkflowOutputPort(
  workflow: MutableWorkflow,
  port?: Partial<WorkflowOutputPort>
): MutableWorkflow {
  const existing = workflow.outputs ?? [];
  const portId = port?.portId ?? freeIdentifier('output', existing.map((p) => p.portId));
  const next: WorkflowOutputPort = {
    portId,
    label: port?.label ?? 'Output',
    type: port?.type ?? 'markdown',
    ...(port?.required !== undefined ? { required: port.required } : { required: true }),
    ...(port?.description !== undefined ? { description: port.description } : {})
  };
  return { ...workflow, outputs: [...existing, next] };
}

export function updateWorkflowOutputPort(
  workflow: MutableWorkflow,
  index: number,
  patch: Partial<WorkflowOutputPort>
): MutableWorkflow {
  const existing = workflow.outputs ?? [];
  if (!inRange(index, existing.length)) return workflow;
  const outputs = existing.map((port, i) => (i === index ? { ...port, ...patch } : port));
  return { ...workflow, outputs };
}

export function removeWorkflowOutputPort(
  workflow: MutableWorkflow,
  index: number
): MutableWorkflow {
  const existing = workflow.outputs ?? [];
  if (!inRange(index, existing.length)) return workflow;
  return { ...workflow, outputs: existing.filter((_, i) => i !== index) };
}

export function addWorkflowBinding(
  workflow: MutableWorkflow,
  binding: WorkflowBinding
): MutableWorkflow {
  const existing = workflow.bindings ?? [];
  return { ...workflow, bindings: [...existing, copyBinding(binding)] };
}

export function updateWorkflowBinding(
  workflow: MutableWorkflow,
  index: number,
  binding: WorkflowBinding
): MutableWorkflow {
  const existing = workflow.bindings ?? [];
  if (!inRange(index, existing.length)) return workflow;
  const bindings = existing.map((entry, i) => (i === index ? copyBinding(binding) : entry));
  return { ...workflow, bindings };
}

export function removeWorkflowBinding(
  workflow: MutableWorkflow,
  index: number
): MutableWorkflow {
  const existing = workflow.bindings ?? [];
  if (!inRange(index, existing.length)) return workflow;
  return { ...workflow, bindings: existing.filter((_, i) => i !== index) };
}

export function updateWorkflowExecutionDefaults(
  workflow: MutableWorkflow,
  patch: Partial<PipelineExecutionDefaults>
): MutableWorkflow {
  const next: PipelineExecutionDefaults = {
    ...(workflow.executionDefaults ?? {}),
    ...patch
  };
  return { ...workflow, executionDefaults: next };
}

export function updateWorkflowRecommendedNext(
  workflow: MutableWorkflow,
  recommendedNext: readonly string[]
): MutableWorkflow {
  return { ...workflow, recommendedNext: [...recommendedNext] };
}

export function dependentWorkflowsForPhase(
  phaseId: string,
  workflows: readonly { readonly workflowId: string; readonly name: string; readonly nodes: readonly WorkflowNode[] }[]
): readonly { readonly workflowId: string; readonly name: string }[] {
  return workflows
    .filter((wf) => wf.nodes.some((node) => node.phaseId === phaseId))
    .map((wf) => ({ workflowId: wf.workflowId, name: wf.name }));
}

export function dependentWorkflowsForWorkflow(
  workflowId: string,
  workflows: readonly { readonly workflowId: string; readonly name: string; readonly nodes: readonly WorkflowNode[] }[]
): readonly { readonly workflowId: string; readonly name: string }[] {
  return workflows
    .filter(
      (wf) =>
        wf.workflowId !== workflowId &&
        wf.nodes.some((node) => node.workflowId === workflowId)
    )
    .map((wf) => ({ workflowId: wf.workflowId, name: wf.name }));
}

export function buildChildWorkflowPreview(
  workflowId: string,
  workflows: readonly { readonly workflowId: string; readonly name?: string; readonly nodes: readonly WorkflowNode[] }[],
  ancestorIds: readonly string[] = [],
  depth = 1
): ChildWorkflowPreview {
  if (ancestorIds.includes(workflowId)) {
    return { nodes: [], truncatedReason: 'cycle' };
  }
  if (depth > MAX_WORKFLOW_NESTING_DEPTH) {
    return { nodes: [], truncatedReason: 'max-depth' };
  }
  const target = workflows.find((wf) => wf.workflowId === workflowId);
  if (!target) {
    return { nodes: [], truncatedReason: 'missing' };
  }
  const nextAncestors = [...ancestorIds, workflowId];
  const nodes: ChildWorkflowPreviewNode[] = target.nodes.map((node) => {
    const label = node.label?.trim() || node.nodeId;
    if (node.workflowId !== undefined) {
      const nested = buildChildWorkflowPreview(node.workflowId, workflows, nextAncestors, depth + 1);
      return {
        nodeId: node.nodeId,
        label,
        kind: 'workflow',
        targetId: node.workflowId,
        children: nested.nodes,
        ...(nested.truncatedReason !== undefined ? { truncatedReason: nested.truncatedReason } : {})
      };
    }
    if (node.phaseId !== undefined) {
      return {
        nodeId: node.nodeId,
        label,
        kind: 'phase',
        targetId: node.phaseId,
        children: []
      };
    }
    return {
      nodeId: node.nodeId,
      label,
      kind: 'pipeline',
      targetId: node.pipelineId ?? '',
      children: []
    };
  });
  return { nodes };
}

export type { PortablePhaseDefinition };

export function copyCandidateBlockControl(control: CandidateBlockControl): CandidateBlockControl {
  return {
    version: 1,
    kind: 'candidate-block',
    candidates: control.candidates.map((c) => ({
      candidateId: c.candidateId,
      nodeId: c.nodeId,
      ...(c.priority !== undefined ? { priority: c.priority } : {}),
      ...(c.maxAttempts !== undefined ? { maxAttempts: c.maxAttempts } : {}),
      ...(c.retry !== undefined ? { retry: { ...c.retry } } : {}),
      ...(c.allowUnverifiedTrial !== undefined ? { allowUnverifiedTrial: c.allowUnverifiedTrial } : {})
    })),
    ...(control.availabilityPolicy !== undefined ? { availabilityPolicy: control.availabilityPolicy } : {}),
    ...(control.maxDispatches !== undefined ? { maxDispatches: control.maxDispatches } : {}),
    ...(control.monitoringWindowMs !== undefined ? { monitoringWindowMs: control.monitoringWindowMs } : {}),
    ...(control.budget !== undefined ? { budget: { ...control.budget } } : {})
  };
}

export function copyDecisionResults(dr: WorkflowDecisionResults): WorkflowDecisionResults {
  return {
    version: 1,
    fields: dr.fields.map((f) => ({ ...f })),
    bindings: dr.bindings.map((b) => ({
      fieldId: b.fieldId,
      source: { ...b.source }
    }))
  };
}

/**
 * FR-R5-F32 (F32-T02) — Enable candidate-block control on a Workflow draft,
 * seeding 1..8 candidate rows from its existing Phase nodes (or creating one if empty).
 */
export function enableCandidateBlockControl(
  workflow: MutableWorkflow,
  defaultPhaseId = 'phase-1'
): MutableWorkflow {
  if (workflow.control !== undefined) return workflow;
  let nodes = [...workflow.nodes];
  if (nodes.length === 0) {
    nodes = [{ nodeId: 'cand-node-1', kind: 'phase', phaseId: defaultPhaseId }];
  }
  const phaseNodes = nodes.filter((n) => n.kind === 'phase' || n.phaseId !== undefined).slice(0, MAX_CANDIDATES_PER_BLOCK);
  const candidates: CandidateDefinition[] = (phaseNodes.length > 0 ? phaseNodes : [nodes[0]!]).map((n, idx) => ({
    candidateId: freeIdentifier(`candidate-${idx + 1}`, []),
    nodeId: n.nodeId,
    priority: idx + 1,
    maxAttempts: DEFAULT_CANDIDATE_ATTEMPTS,
    allowUnverifiedTrial: false
  }));
  return {
    ...workflow,
    nodes,
    startNodeIds: candidates.map((c) => c.nodeId),
    control: {
      version: 1,
      kind: 'candidate-block',
      candidates,
      availabilityPolicy: DEFAULT_CANDIDATE_AVAILABILITY_POLICY,
      maxDispatches: DEFAULT_CANDIDATE_BLOCK_DISPATCHES,
      monitoringWindowMs: DEFAULT_MONITORING_WINDOW_MS
    }
  };
}

export function disableCandidateBlockControl(workflow: MutableWorkflow): MutableWorkflow {
  if (workflow.control === undefined) return workflow;
  const { control: _removed, ...rest } = workflow;
  return rest;
}

/**
 * Add a candidate row (up to MAX_CANDIDATES_PER_BLOCK = 8) using stable IDs,
 * creating and binding a Phase node when no unbound Phase node exists.
 */
export function addCandidateRow(
  workflow: MutableWorkflow,
  phaseId = 'phase-1'
): MutableWorkflow {
  const control = workflow.control;
  if (!control || control.candidates.length >= MAX_CANDIDATES_PER_BLOCK) return workflow;
  const takenCandidateIds = control.candidates.map((c) => c.candidateId);
  const candidateId = freeIdentifier(`candidate-${control.candidates.length + 1}`, takenCandidateIds);
  const boundNodeIds = new Set(control.candidates.map((c) => c.nodeId));
  const unboundPhaseNode = workflow.nodes.find(
    (n) => (n.kind === 'phase' || n.phaseId !== undefined) && !boundNodeIds.has(n.nodeId)
  );
  let nodes = workflow.nodes;
  let targetNodeId: string;
  if (unboundPhaseNode) {
    targetNodeId = unboundPhaseNode.nodeId;
  } else {
    const takenNodeIds = workflow.nodes.map((n) => n.nodeId);
    targetNodeId = freeIdentifier(`cand-node-${control.candidates.length + 1}`, takenNodeIds);
    nodes = [...workflow.nodes, { nodeId: targetNodeId, kind: 'phase', phaseId }];
  }
  const nextCandidate: CandidateDefinition = {
    candidateId,
    nodeId: targetNodeId,
    priority: control.candidates.length + 1,
    maxAttempts: DEFAULT_CANDIDATE_ATTEMPTS,
    allowUnverifiedTrial: false
  };
  const nextCandidates = [...control.candidates, nextCandidate];
  const nextStarts = Array.from(new Set([...workflow.startNodeIds, targetNodeId]));
  return {
    ...workflow,
    nodes,
    startNodeIds: nextStarts,
    control: {
      ...control,
      candidates: nextCandidates
    }
  };
}

/**
 * Remove a candidate row while keeping at least MIN_CANDIDATES_PER_BLOCK = 1.
 */
export function removeCandidateRow(
  workflow: MutableWorkflow,
  index: number
): MutableWorkflow {
  const control = workflow.control;
  if (!control || control.candidates.length <= MIN_CANDIDATES_PER_BLOCK) return workflow;
  if (!inRange(index, control.candidates.length)) return workflow;
  const removed = control.candidates[index]!;
  const nextCandidates = control.candidates.filter((_, i) => i !== index);
  const nextNodes = workflow.nodes.filter((n) => n.nodeId !== removed.nodeId);
  const nextStarts = workflow.startNodeIds.filter((id) => id !== removed.nodeId);
  return {
    ...workflow,
    nodes: nextNodes.length > 0 ? nextNodes : workflow.nodes,
    startNodeIds: nextStarts.length > 0 ? nextStarts : nextCandidates.map((c) => c.nodeId),
    control: {
      ...control,
      candidates: nextCandidates
    }
  };
}

/**
 * Reorder a candidate row by `delta` (-1 or +1) while preserving each row's stable `candidateId`.
 */
export function moveCandidateRow(
  workflow: MutableWorkflow,
  index: number,
  delta: number
): MutableWorkflow {
  const control = workflow.control;
  if (!control) return workflow;
  const targetIndex = index + delta;
  if (!inRange(index, control.candidates.length) || !inRange(targetIndex, control.candidates.length)) {
    return workflow;
  }
  const nextCandidates = [...control.candidates];
  const [moved] = nextCandidates.splice(index, 1);
  nextCandidates.splice(targetIndex, 0, moved);
  return {
    ...workflow,
    control: {
      ...control,
      candidates: nextCandidates
    }
  };
}

export interface CandidateRowPatch {
  readonly candidateId?: string;
  readonly nodeId?: string;
  readonly phaseId?: string;
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly retry?: CandidateRetryPolicy;
  readonly allowUnverifiedTrial?: boolean;
}

/**
 * Update one candidate row and/or its bound Phase node target without duplicating Phase fields.
 */
export function updateCandidateRow(
  workflow: MutableWorkflow,
  index: number,
  patch: CandidateRowPatch
): MutableWorkflow {
  const control = workflow.control;
  if (!control || !inRange(index, control.candidates.length)) return workflow;
  const current = control.candidates[index]!;
  const targetNodeId = patch.nodeId ?? current.nodeId;
  let nodes = workflow.nodes;
  if (patch.phaseId !== undefined) {
    nodes = workflow.nodes.map((n) =>
      n.nodeId === targetNodeId
        ? { ...n, kind: 'phase' as const, phaseId: patch.phaseId, workflowId: undefined, pipelineId: undefined }
        : n
    );
  }
  const updated: CandidateDefinition = {
    candidateId: patch.candidateId ?? current.candidateId,
    nodeId: targetNodeId,
    ...(patch.priority !== undefined
      ? { priority: patch.priority }
      : current.priority !== undefined
        ? { priority: current.priority }
        : {}),
    ...(patch.maxAttempts !== undefined
      ? { maxAttempts: patch.maxAttempts }
      : current.maxAttempts !== undefined
        ? { maxAttempts: current.maxAttempts }
        : {}),
    ...(patch.retry !== undefined
      ? { retry: { ...patch.retry } }
      : current.retry !== undefined
        ? { retry: { ...current.retry } }
        : {}),
    ...(patch.allowUnverifiedTrial !== undefined
      ? { allowUnverifiedTrial: patch.allowUnverifiedTrial }
      : current.allowUnverifiedTrial !== undefined
        ? { allowUnverifiedTrial: current.allowUnverifiedTrial }
        : {})
  };
  const nextCandidates = control.candidates.map((c, i) => (i === index ? updated : c));
  return {
    ...workflow,
    nodes,
    control: {
      ...control,
      candidates: nextCandidates
    }
  };
}

export interface CandidateBlockPolicyPatch {
  readonly availabilityPolicy?: CandidateAvailabilityPolicy;
  readonly maxDispatches?: number;
  readonly monitoringWindowMs?: number;
  readonly maxMicrousd?: number | undefined;
}

export function updateCandidateBlockPolicy(
  workflow: MutableWorkflow,
  patch: CandidateBlockPolicyPatch
): MutableWorkflow {
  const control = workflow.control;
  if (!control) return workflow;
  const nextBudget =
    'maxMicrousd' in patch
      ? patch.maxMicrousd !== undefined
        ? ({ mode: 'strict-usd' as const, limitMicrousd: patch.maxMicrousd })
        : ({ mode: 'count-only' as const })
      : control.budget;
  const { budget: _oldBudget, ...restControl } = control;
  return {
    ...workflow,
    control: {
      ...restControl,
      ...(patch.availabilityPolicy !== undefined ? { availabilityPolicy: patch.availabilityPolicy } : {}),
      ...(patch.maxDispatches !== undefined ? { maxDispatches: patch.maxDispatches } : {}),
      ...(patch.monitoringWindowMs !== undefined ? { monitoringWindowMs: patch.monitoringWindowMs } : {}),
      ...(nextBudget !== undefined ? { budget: nextBudget } : {})
    }
  };
}

function copyConnection(connection: WorkflowConnection): WorkflowConnection {
  return {
    from: {
      nodeId: connection.from.nodeId,
      ...(connection.from.portId !== undefined ? { portId: connection.from.portId } : {})
    },
    to: {
      nodeId: connection.to.nodeId,
      ...(connection.to.portId !== undefined ? { portId: connection.to.portId } : {}),
      ...(connection.to.kind !== undefined ? { kind: connection.to.kind } : {})
    },
    ...(connection.handoff !== undefined ? { handoff: connection.handoff } : {}),
    ...(connection.condition !== undefined
      ? {
        condition:
          'left' in connection.condition
            ? {
              left: { ...connection.condition.left },
              operator: connection.condition.operator,
              ...(connection.condition.right !== undefined
                ? {
                  right: Array.isArray(connection.condition.right)
                    ? [...connection.condition.right]
                    : connection.condition.right
                }
                : {})
            }
            : structuredClone(connection.condition)
      }
      : {}),
    ...(connection.priority !== undefined ? { priority: connection.priority } : {}),
    ...(connection.isDefault !== undefined ? { isDefault: connection.isDefault } : {}),
    ...(connection.selection !== undefined ? { selection: connection.selection } : {})
  };
}

function inRange(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

/** The condition on connection `index`, or null when there is no such condition. */
function conditionAt(workflow: MutableWorkflow, index: number): WorkflowCondition | null {
  if (!inRange(index, workflow.connections.length)) return null;
  const condition = workflow.connections[index].condition;
  return condition !== undefined && 'left' in condition ? condition : null;
}

/** Write a condition back with its right operand reconciled to operator and source. */
function writeCondition(
  workflow: MutableWorkflow,
  index: number,
  left: WorkflowConditionOperand,
  operator: WorkflowConditionOperator,
  right: WorkflowCondition['right']
): MutableWorkflow {
  const reconciled = reconcileRight(right, operator, left.source);
  return updateWorkflowConnection(workflow, index, {
    condition: { left, operator, ...(reconciled !== undefined ? { right: reconciled } : {}) }
  });
}

/**
 * Fit the right operand to the operator's arity and the operand's source. A
 * `node-status` comparison may only name a terminal status, and neither an
 * `exists` with a value nor an `in` without one is a shape the host accepts.
 */
function reconcileRight(
  right: WorkflowCondition['right'],
  operator: WorkflowConditionOperator,
  source: WorkflowConditionOperandSource
): WorkflowCondition['right'] {
  const arity = conditionRightArity(operator);
  if (arity === 'none') return undefined;
  const authored = right === undefined ? [] : isLiteralList(right) ? right : [right];
  const values = authored.filter(
    (value) => source !== 'node-status' || isTerminalStatus(value)
  );
  if (arity === 'list') return values.length > 0 ? values : [seedLiteral(source)];
  return values.length > 0 ? values[0] : seedLiteral(source);
}

/**
 * `Array.isArray` alone does not narrow a `readonly` array out of a union, so
 * the guard is spelled explicitly rather than inlined at each call.
 */
function isLiteralList(
  right: WorkflowCondition['right']
): right is readonly WorkflowConditionLiteral[] {
  return Array.isArray(right);
}

/** What an unset slot holds: the only always-valid run status, or empty text. */
function seedLiteral(source: WorkflowConditionOperandSource): WorkflowConditionLiteral {
  return source === 'node-status' ? WORKFLOW_NODE_TERMINAL_STATUSES[0] : '';
}

function isTerminalStatus(value: WorkflowConditionLiteral): boolean {
  return (
    typeof value === 'string' &&
    (WORKFLOW_NODE_TERMINAL_STATUSES as readonly string[]).includes(value)
  );
}

function freeIdentifier(base: string, takenIds: readonly string[]): string {
  const taken = new Set(takenIds);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

function readDisplayString(
  display: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const value = display[key];
  return typeof value === 'string' ? value : undefined;
}

function readDisplayNumber(
  display: Readonly<Record<string, unknown>>,
  key: string
): number | undefined {
  const value = display[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
