// Feature 086 T014 — which Workflow definition a references-only export writes.
//
// The same two requirements pull against each other one level up, and research
// R11's answer carries over unchanged:
//
//   * FR-014 — export reads the EFFECTIVE catalog, so the bytes are the
//     definition this installation actually runs and not a shadowed layer's copy.
//   * FR-016 — a references-only export MUST NOT require the referenced Pipelines
//     to resolve. A Workflow naming Pipelines this machine does not have is still
//     exportable, graph intact, because references are all the document carries.
//
// `resolveWorkflowCatalog` nulls a row's definition and marks it `invalid` on ANY
// error, and `unknown-pipeline` / `pipeline-invalid` are reference-class. Under
// FR-016's own case the effective catalog is therefore empty, and reading it alone
// would refuse. So: strict first, reference-relaxed second, and the relaxed pass
// runs ONLY when the strict pass came up empty. Relaxing first would let a
// workspace row whose only defect is a missing Pipeline outrank a user row that
// genuinely resolves, and export would emit bytes this installation does not run —
// FR-014 broken in the exact case FR-014 exists for.
//
// Where this differs from `pipeline-export-selection.ts`, and why it has to:
// `placeholderPhase` is identifier-only, because `validatePipelineBindings` reads
// its Phase-catalog argument for exactly one thing — the set of known ids. A
// placeholder PIPELINE cannot be identifier-only, because `validateWorkflowGraph`
// checks `from.portId` against the source node's Pipeline `outputs` and
// `to.portId` against the target's `inputs`. An empty-ported placeholder would
// resolve the node and then fail every endpoint that touches it with
// `unresolved-endpoint` — trading one reference-class defect for another. The
// placeholder is therefore PORT-BEARING, and the ports it needs are derivable from
// the Workflow's own connections: the `from.portId`s where it is the source are
// its outputs, the `to.portId`s where it is the target are its inputs, unioned
// across every node naming the same `pipelineId`.
//
// Port TYPES are chosen so the relaxation suppresses reference-class defects
// without inventing structural ones. When the peer endpoint resolves, the type is
// read back through `WORKFLOW_PORT_COMPATIBILITY` — derived from that one frozen
// table, never restated — so the pair type-checks. When both ends are
// placeholders, the default output type and the first input type it accepts are
// used, which are compatible by construction. One shape is unavoidable rather
// than chosen: a known `local-folder` input is fed only by `file-set`, and
// `file-set → local-folder` always needs a `selection` rule, so a graph that omits
// one is defective under every possible resolution — the placeholder surfaces the
// authored graph's own defect, it does not manufacture one.
//
// A `node-output` condition adds one more obligation: `validateWorkflowGraph`
// skips the structured-output check while the operand node's Pipeline is
// unresolved, so the relaxed pass — where it now resolves — would introduce a
// defect the strict pass never had. The placeholder answers it with a synthetic
// structured output port. Same principle as everything else here: relax the
// reference, invent nothing.
//
// The relaxed resolution feeds serialization and nothing else. It is never
// persisted, never handed to run creation, never shown as authoring state, and
// never used for the self-contained form's inclusion check, which needs the
// Pipelines to resolve for real.

import { resolveWorkflowCatalog, workflowSourceIdentity } from '../../config/workflow-catalog';
import type { WorkflowPipelineContext } from '../../config/workflow-catalog';
import { validateWorkflowDefinition } from '../../config/workflow-definition-validator';
import { WORKFLOW_PORT_COMPATIBILITY } from '../../config/workflow-graph-validator';
import type {
  PipelineDefinition,
  PipelineInputPortType,
  PipelineOutputPortType
} from '../../contracts/pipeline-definitions';
import type {
  WorkflowDefinition,
  WorkflowDefinitionScope
} from '../../contracts/workflow-definitions';

export interface WorkflowExportSelectionInput {
  readonly builtIn: readonly unknown[];
  readonly user: readonly unknown[] | undefined;
  readonly workspace: readonly unknown[] | undefined;
  /** The effective Pipeline catalog and its rows, per the project rule on graph resolution. */
  readonly pipelineCatalog: WorkflowPipelineContext;
  readonly workflowId: string;
}

export type WorkflowExportSelection =
  | {
      readonly outcome: 'selected';
      readonly definition: WorkflowDefinition;
      readonly scope: WorkflowDefinitionScope;
    }
  | { readonly outcome: 'unavailable'; readonly reason: 'does-not-resolve' | 'not-found' };

/** The output type a placeholder writes when nothing on the far end constrains it. */
const DEFAULT_OUTPUT_TYPE: PipelineOutputPortType = 'markdown';

/** The synthetic port name a `node-output` condition's operand Pipeline needs. */
const STRUCTURED_PORT_ID = 'structured-output';

const COMPATIBILITY_ENTRIES = Object.entries(WORKFLOW_PORT_COMPATIBILITY) as readonly [
  PipelineOutputPortType,
  readonly PipelineInputPortType[]
][];

/**
 * The reverse of the compatibility table: one output type that feeds each input
 * type. Derived rather than restated, so the two can never disagree. Where more
 * than one output feeds an input, the table's own declaration order decides.
 */
const OUTPUT_TYPE_FEEDING: ReadonlyMap<PipelineInputPortType, PipelineOutputPortType> = (() => {
  const feeding = new Map<PipelineInputPortType, PipelineOutputPortType>();
  for (const [output, inputs] of COMPATIBILITY_ENTRIES) {
    for (const input of inputs) if (!feeding.has(input)) feeding.set(input, output);
  }
  return feeding;
})();

/**
 * The output types a `node-output` condition can read a field from — the ones the
 * compatibility table maps to the `pipeline-output` input type.
 */
const STRUCTURED_OUTPUT_TYPES: ReadonlySet<PipelineOutputPortType> = new Set(
  COMPATIBILITY_ENTRIES.filter(([, inputs]) => inputs.includes('pipeline-output')).map(
    ([output]) => output
  )
);

/** The ports one absent Pipeline must declare for this Workflow's graph to check. */
interface PlaceholderNeed {
  readonly inputs: Map<string, PipelineInputPortType>;
  readonly outputs: Map<string, PipelineOutputPortType>;
  /** A `node-output` condition reads a field from a node on this Pipeline. */
  structured: boolean;
}

function needFor(needs: Map<string, PlaceholderNeed>, pipelineId: string): PlaceholderNeed {
  const existing = needs.get(pipelineId);
  if (existing) return existing;
  const created: PlaceholderNeed = { inputs: new Map(), outputs: new Map(), structured: false };
  needs.set(pipelineId, created);
  return created;
}

/**
 * Record what one Workflow definition needs from the Pipelines it names but the
 * effective catalog does not hold.
 *
 * Nodes are walked before connections because a node may take part in no
 * connection at all and still name an absent Pipeline; the node walk is what
 * guarantees every unresolved reference gets a slot. A port already recorded is
 * left alone, so authored order decides a disagreement — a single output feeding
 * two inputs of different types is unsatisfiable by any real Pipeline, and the
 * defect that follows is the graph's own.
 */
function deriveNeeds(
  definition: WorkflowDefinition,
  known: ReadonlyMap<string, PipelineDefinition>,
  needs: Map<string, PlaceholderNeed>
): void {
  const nodePipelines = new Map(definition.nodes.map((node) => [node.nodeId, node.pipelineId]));
  const absentPipelineOf = (nodeId: string): string | null => {
    const pipelineId = nodePipelines.get(nodeId);
    return pipelineId !== undefined && !known.has(pipelineId) ? pipelineId : null;
  };
  const knownPipelineOf = (nodeId: string): PipelineDefinition | undefined => {
    const pipelineId = nodePipelines.get(nodeId);
    return pipelineId === undefined ? undefined : known.get(pipelineId);
  };

  for (const pipelineId of nodePipelines.values()) {
    if (!known.has(pipelineId)) needFor(needs, pipelineId);
  }

  for (const connection of definition.connections) {
    const absentSource = absentPipelineOf(connection.from.nodeId);
    if (absentSource !== null) {
      const outputs = needFor(needs, absentSource).outputs;
      if (!outputs.has(connection.from.portId)) {
        const peer = knownPipelineOf(connection.to.nodeId)?.inputs.find(
          (port) => port.portId === connection.to.portId
        );
        const type = peer ? OUTPUT_TYPE_FEEDING.get(peer.type) : undefined;
        outputs.set(connection.from.portId, type ?? DEFAULT_OUTPUT_TYPE);
      }
    }

    const absentTarget = absentPipelineOf(connection.to.nodeId);
    if (absentTarget !== null) {
      const inputs = needFor(needs, absentTarget).inputs;
      if (!inputs.has(connection.to.portId)) {
        const peer = knownPipelineOf(connection.from.nodeId)?.outputs.find(
          (port) => port.portId === connection.from.portId
        );
        const outputType = peer?.type ?? DEFAULT_OUTPUT_TYPE;
        inputs.set(connection.to.portId, WORKFLOW_PORT_COMPATIBILITY[outputType][0]);
      }
    }

    if (connection.condition?.left.source === 'node-output') {
      const absentOperand = absentPipelineOf(connection.condition.left.nodeId);
      if (absentOperand !== null) needFor(needs, absentOperand).structured = true;
    }
  }
}

/**
 * One stand-in Pipeline: the identifier the Workflow named, the ports its graph
 * addresses, and nothing else. It exists for the length of one resolution pass.
 */
function placeholderPipeline(pipelineId: string, need: PlaceholderNeed): PipelineDefinition {
  const outputs = [...need.outputs].map(([portId, type]) => ({ portId, label: portId, type }));

  if (need.structured && !outputs.some((port) => STRUCTURED_OUTPUT_TYPES.has(port.type))) {
    let portId = STRUCTURED_PORT_ID;
    let suffix = 1;
    while (outputs.some((port) => port.portId === portId)) {
      portId = `${STRUCTURED_PORT_ID}-${suffix}`;
      suffix += 1;
    }
    outputs.push({ portId, label: portId, type: 'structured-data' });
  }

  return {
    pipelineId,
    name: pipelineId,
    version: 1,
    phaseIds: [],
    inputs: [...need.inputs].map(([portId, type]) => ({ portId, label: portId, type })),
    outputs,
    bindings: [],
    recommendedNext: []
  };
}

/**
 * The stand-ins the target Workflow's own rows call for.
 *
 * Every layer is scanned by the same identity and structural parse the resolver
 * performs — `validateWorkflowDefinition` with no options, exactly as `parseLayer`
 * calls it, so the two readings of one row can never disagree. A row whose
 * structure does not parse contributes nothing; its defects are not reference-class
 * and the relaxed pass would not save it.
 */
function placeholderPipelines(
  input: WorkflowExportSelectionInput
): readonly PipelineDefinition[] {
  const known = new Map(
    input.pipelineCatalog.effective.map((pipeline) => [pipeline.pipelineId, pipeline])
  );
  const needs = new Map<string, PlaceholderNeed>();

  for (const rows of [input.builtIn, input.user ?? [], input.workspace ?? []]) {
    rows.forEach((row, index) => {
      if (workflowSourceIdentity(row, index) !== input.workflowId) return;
      const parsed = validateWorkflowDefinition(row);
      if (parsed.definition !== null) deriveNeeds(parsed.definition, known, needs);
    });
  }

  return [...needs].map(([pipelineId, need]) => placeholderPipeline(pipelineId, need));
}

/**
 * The definition a references-only Workflow export writes, or why there is none.
 *
 * `does-not-resolve` and `not-found` are told apart by whether any layer holds a
 * row under this identifier at all — an unknown identifier is a different answer
 * from a known one whose defects are structural, and the two are reported
 * separately (FR-023).
 */
export function selectWorkflowForExport(
  input: WorkflowExportSelectionInput
): WorkflowExportSelection {
  const resolve = (pipelineCatalog: WorkflowPipelineContext) =>
    resolveWorkflowCatalog({
      builtIn: input.builtIn,
      user: input.user,
      workspace: input.workspace,
      pipelineCatalog
    });
  const effectiveRow = (records: ReturnType<typeof resolve>['records']) =>
    records.find((row) => row.workflowId === input.workflowId && row.status === 'effective');

  const strict = resolve(input.pipelineCatalog);
  let selected = effectiveRow(strict.records);

  if (!selected?.definition) {
    const placeholders = placeholderPipelines(input);
    if (placeholders.length > 0) {
      selected = effectiveRow(
        resolve({
          effective: [...input.pipelineCatalog.effective, ...placeholders],
          records: input.pipelineCatalog.records
        }).records
      );
    }
  }

  if (selected?.definition) {
    return { outcome: 'selected', definition: selected.definition, scope: selected.scope };
  }

  return {
    outcome: 'unavailable',
    reason: strict.records.some((row) => row.workflowId === input.workflowId)
      ? 'does-not-resolve'
      : 'not-found'
  };
}
