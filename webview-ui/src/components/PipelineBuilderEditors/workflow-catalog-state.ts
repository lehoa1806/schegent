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

import {
  WORKFLOW_NODE_TERMINAL_STATUSES,
  type PortablePipelineDefinition,
  type WorkflowCatalogFieldErrorProjection,
  type WorkflowCatalogSourceProjection,
  type WorkflowCondition,
  type WorkflowConditionLiteral,
  type WorkflowConditionOperand,
  type WorkflowConditionOperator,
  type WorkflowConnection,
  type WorkflowNode
} from '../../lib/snapshot-types';
import type { SaveWorkflowRow } from '../../lib/definition-rows';
import type { MutableWorkflow } from './types';

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
    nodes: (definition?.nodes ?? []).map(copyNode),
    connections: (definition?.connections ?? []).map(copyConnection),
    startNodeIds: [...(definition?.startNodeIds ?? [])],
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
  return {
    workflowId: workflow.workflowId,
    name: workflow.name,
    ...(description ? { description } : {}),
    version: workflow.version,
    nodes: workflow.nodes.map(copyNode),
    connections: workflow.connections.map(copyConnection),
    startNodeIds: [...workflow.startNodeIds]
  };
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
    sourceKey: `${workflowId}::draft`,
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
    nodes: source.nodes.map(copyNode),
    connections: source.connections.map(copyConnection),
    startNodeIds: [...source.startNodeIds],
    sourceKey: `${workflowId}::draft`,
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
  return {
    ...workflow,
    nodes: workflow.nodes.filter((_, i) => i !== index),
    connections: workflow.connections.filter(
      (edge) => edge.from.nodeId !== removedId && edge.to.nodeId !== removedId
    ),
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
  pipelineId: string
): WorkflowNode {
  return {
    nodeId: freeIdentifier('node', workflow.nodes.map((node) => node.nodeId)),
    pipelineId
  };
}

/**
 * A connection seeded from the first two nodes and their first declared ports.
 * A seed the host would reject is still better than an empty row the operator
 * cannot see the shape of; every part of it is editable before save.
 */
export function makeWorkflowConnectionDraft(
  workflow: MutableWorkflow,
  pipelines: readonly PortablePipelineDefinition[]
): WorkflowConnection {
  const from = workflow.nodes[0];
  const to = workflow.nodes[1] ?? workflow.nodes[0];
  return {
    from: { nodeId: from?.nodeId ?? '', portId: workflowPortIds(from, pipelines, 'out')[0] ?? '' },
    to: { nodeId: to?.nodeId ?? '', portId: workflowPortIds(to, pipelines, 'in')[0] ?? '' }
  };
}

/**
 * Point one end of a connection at a different node or port.
 *
 * Changing the node clears the port to that node's first declared one: the old
 * port id belonged to the old node's Pipeline, and silently keeping it is how a
 * retarget produces a defect the operator did not author and cannot see the
 * cause of. Changing only the port leaves the node alone.
 */
export function retargetWorkflowConnection(
  workflow: MutableWorkflow,
  index: number,
  end: 'from' | 'to',
  patch: { readonly nodeId?: string; readonly portId?: string },
  pipelines: readonly PortablePipelineDefinition[]
): MutableWorkflow {
  if (!inRange(index, workflow.connections.length)) return workflow;
  const current = workflow.connections[index][end];
  if (patch.nodeId !== undefined && patch.nodeId !== current.nodeId) {
    const node = workflow.nodes.find((entry) => entry.nodeId === patch.nodeId);
    const direction = end === 'from' ? 'out' : 'in';
    const portId = workflowPortIds(node, pipelines, direction)[0] ?? '';
    return updateWorkflowConnection(workflow, index, { [end]: { nodeId: patch.nodeId, portId } });
  }
  if (patch.portId !== undefined) {
    return updateWorkflowConnection(workflow, index, {
      [end]: { nodeId: current.nodeId, portId: patch.portId }
    });
  }
  return workflow;
}

/**
 * The ports a node offers, read from its Pipeline's declaration. An endpoint
 * the Builder cannot offer is one the operator cannot author by mistake, which
 * is why these back selects rather than text fields. An unknown Pipeline
 * yields none, so the row shows the defect instead of an inviting empty select.
 */
export function workflowPortIds(
  node: WorkflowNode | undefined,
  pipelines: readonly PortablePipelineDefinition[],
  direction: 'in' | 'out'
): readonly string[] {
  const pipeline = pipelines.find((entry) => entry.pipelineId === node?.pipelineId);
  if (!pipeline) return [];
  // The declaration crossed an IPC boundary: a host on an older bundle may omit
  // either list entirely, and an offered-nothing select beats a render crash.
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
 * Read one typed value as the literal it spells: `true`/`false` are booleans and
 * a plain decimal is a number, so a comparison against either means what the
 * operator wrote. Everything else is kept verbatim.
 *
 * The trade-off is deliberate and one-directional — the *strings* `"5"` and
 * `"true"` are not authorable through this control, while numeric and boolean
 * comparisons would otherwise be impossible to author at all. The pattern is
 * narrow on purpose: `0x10`, `007`, and `TRUE` stay text rather than being
 * silently reinterpreted.
 */
const DECIMAL_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function parseWorkflowConditionLiteral(text: string): WorkflowConditionLiteral {
  const trimmed = text.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (DECIMAL_LITERAL.test(trimmed)) return Number(trimmed);
  return text;
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
      message: 'A Workflow needs at least one Pipeline node.'
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
  });

  if (workflow.startNodeIds.length === 0 && workflow.nodes.length > 0) {
    errors.push({
      field: 'startNodeIds',
      code: 'invalid-start-set',
      message: 'Choose at least one node the Workflow may start from.'
    });
  }

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
 * Turn a host rejection into one line the operator can act on. An unrecognized
 * reason passes through verbatim rather than being flattened into a generic
 * message — a reason this build does not know about is still information.
 */
export function formatWorkflowSaveRejection(
  reason: string,
  result: WorkflowSaveRejectionResult | undefined
): string {
  if (reason === 'stale-catalog') {
    return 'This Workflow layer changed since you started editing. Refresh to take the current version, or reapply your edits on top of it.';
  }
  if (reason !== 'workflow-validation') return reason;

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

function copyNode(node: WorkflowNode): WorkflowNode {
  return {
    nodeId: node.nodeId,
    pipelineId: node.pipelineId,
    ...(node.label !== undefined ? { label: node.label } : {})
  };
}

function copyConnection(connection: WorkflowConnection): WorkflowConnection {
  return {
    from: { nodeId: connection.from.nodeId, portId: connection.from.portId },
    to: { nodeId: connection.to.nodeId, portId: connection.to.portId },
    ...(connection.condition !== undefined
      ? {
          condition: {
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
  return workflow.connections[index].condition ?? null;
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
