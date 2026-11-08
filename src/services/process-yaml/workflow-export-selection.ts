// Feature 086 T014 / Feature 263 (FR-R5-F04) — which Workflow definition a
// references-only export writes.
//
// Two requirements pull against each other:
//   * Export reads the EFFECTIVE catalog so the bytes match what this installation runs.
//   * A references-only export MUST NOT require referenced Phases or child Workflows to
//     resolve in the catalog — a Workflow naming Phases or child Workflows this machine
//     does not hold is still exportable, graph intact, because references are all the
//     document carries.
//
// `selectWorkflowForExport` runs a strict catalog resolution pass first, and only when the
// target Workflow is not effective in the strict pass does it run a reference-relaxed pass
// with synthetic Phase and child Workflow placeholders derived from the target Workflow's
// own references. Structural or intra-workflow graph defects on the target Workflow still
// fail the relaxed pass and return `does-not-resolve`.

import { resolveWorkflowCatalog, workflowSourceIdentity } from '../../config/workflow-catalog';
import type { WorkflowPhaseContext } from '../../config/workflow-catalog';
import { validateWorkflowDefinition } from '../../config/workflow-definition-validator';
import { WORKFLOW_PORT_COMPATIBILITY } from '../../config/workflow-graph-validator';
import type {
  PipelineInputPortType,
  PipelineOutputPortType
} from '../../contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../contracts/process-definitions';
import { isTypedCondition } from '../../contracts/decision-results';
import type {
  WorkflowDefinition,
  WorkflowInputPort,
  WorkflowOutputPort
} from '../../contracts/workflow-definitions';

export interface WorkflowExportSelectionInput {
  /** The stored Workflow rows, at every status. */
  readonly rows: readonly unknown[] | undefined;
  /** The effective Phase catalog and its rows. */
  readonly phaseCatalog?: WorkflowPhaseContext;
  readonly workflowId: string;
}

export type WorkflowExportSelection =
  | { readonly outcome: 'selected'; readonly definition: WorkflowDefinition }
  | { readonly outcome: 'unavailable'; readonly reason: 'does-not-resolve' | 'not-found' };

const DEFAULT_OUTPUT_TYPE: PipelineOutputPortType = 'markdown';
const STRUCTURED_PORT_ID = 'structured-output';
const PLACEHOLDER_PHASE_ID = 'placeholder-phase';

const COMPATIBILITY_ENTRIES = Object.entries(WORKFLOW_PORT_COMPATIBILITY) as readonly [
  PipelineOutputPortType,
  readonly PipelineInputPortType[]
][];

const OUTPUT_TYPE_FEEDING: ReadonlyMap<PipelineInputPortType, PipelineOutputPortType> = (() => {
  const feeding = new Map<PipelineInputPortType, PipelineOutputPortType>();
  for (const [output, inputs] of COMPATIBILITY_ENTRIES) {
    for (const input of inputs) if (!feeding.has(input)) feeding.set(input, output);
  }
  return feeding;
})();

const STRUCTURED_OUTPUT_TYPES: ReadonlySet<PipelineOutputPortType> = new Set(
  COMPATIBILITY_ENTRIES.filter(([, inputs]) => inputs.includes('pipeline-output')).map(
    ([output]) => output
  )
);

interface PlaceholderWorkflowNeed {
  readonly inputs: Map<string, PipelineInputPortType>;
  readonly outputs: Map<string, PipelineOutputPortType>;
  structured: boolean;
}

function needFor(
  needs: Map<string, PlaceholderWorkflowNeed>,
  workflowId: string
): PlaceholderWorkflowNeed {
  const existing = needs.get(workflowId);
  if (existing) return existing;
  const created: PlaceholderWorkflowNeed = {
    inputs: new Map(),
    outputs: new Map(),
    structured: false
  };
  needs.set(workflowId, created);
  return created;
}

function placeholderPhase(phaseId: string): PhaseDefinition {
  return {
    phaseId,
    name: phaseId,
    description: 'placeholder',
    version: 1,
    instruction: 'placeholder'
  };
}

function deriveNeeds(
  definition: WorkflowDefinition,
  knownPhases: ReadonlySet<string>,
  knownWorkflows: ReadonlyMap<string, WorkflowDefinition>,
  missingPhases: Set<string>,
  workflowNeeds: Map<string, PlaceholderWorkflowNeed>
): void {
  const nodeWorkflows = new Map<string, string>();
  for (const node of definition.nodes) {
    if (node.phaseId !== undefined && !knownPhases.has(node.phaseId)) {
      missingPhases.add(node.phaseId);
    }
    if (node.workflowId !== undefined) {
      nodeWorkflows.set(node.nodeId, node.workflowId);
      if (node.workflowId !== definition.workflowId && !knownWorkflows.has(node.workflowId)) {
        needFor(workflowNeeds, node.workflowId);
        missingPhases.add(PLACEHOLDER_PHASE_ID);
      }
    }
  }

  const absentWorkflowOf = (nodeId: string): string | null => {
    const wfId = nodeWorkflows.get(nodeId);
    return wfId !== undefined && wfId !== definition.workflowId && !knownWorkflows.has(wfId)
      ? wfId
      : null;
  };
  const knownWorkflowOf = (nodeId: string): WorkflowDefinition | undefined => {
    const wfId = nodeWorkflows.get(nodeId);
    return wfId === undefined ? undefined : knownWorkflows.get(wfId);
  };

  for (const connection of definition.connections) {
    const absentSource = absentWorkflowOf(connection.from.nodeId);
    if (absentSource !== null && connection.from.portId !== undefined) {
      const outputs = needFor(workflowNeeds, absentSource).outputs;
      if (!outputs.has(connection.from.portId)) {
        const peer = knownWorkflowOf(connection.to.nodeId)?.inputs?.find(
          (port) => port.portId === connection.to.portId
        );
        const type = peer ? OUTPUT_TYPE_FEEDING.get(peer.type) : undefined;
        outputs.set(connection.from.portId, type ?? DEFAULT_OUTPUT_TYPE);
      }
    }

    const absentTarget = absentWorkflowOf(connection.to.nodeId);
    if (absentTarget !== null && connection.to.portId !== undefined) {
      const inputs = needFor(workflowNeeds, absentTarget).inputs;
      if (!inputs.has(connection.to.portId)) {
        const peer = knownWorkflowOf(connection.from.nodeId)?.outputs?.find(
          (port) => port.portId === connection.from.portId
        );
        const outputType = peer?.type ?? DEFAULT_OUTPUT_TYPE;
        inputs.set(connection.to.portId, WORKFLOW_PORT_COMPATIBILITY[outputType][0]);
      }
    }

    if (
      connection.condition !== undefined &&
      !isTypedCondition(connection.condition) &&
      connection.condition.left.source === 'node-output'
    ) {
      const absentOperand = absentWorkflowOf(connection.condition.left.nodeId);
      if (absentOperand !== null) needFor(workflowNeeds, absentOperand).structured = true;
    }
  }

  const declaredInputs = new Map((definition.inputs ?? []).map((p) => [p.portId, p]));
  const declaredOutputs = new Map((definition.outputs ?? []).map((p) => [p.portId, p]));

  for (const binding of definition.bindings ?? []) {
    if (binding.kind === 'input') {
      const absentTarget = absentWorkflowOf(binding.nodeId);
      if (absentTarget !== null) {
        const inputs = needFor(workflowNeeds, absentTarget).inputs;
        if (!inputs.has(binding.inputKey)) {
          let inferredType: PipelineInputPortType = 'text';
          if (binding.type !== undefined) {
            inferredType = binding.type;
          } else if (binding.source.from === 'workflow-input') {
            const wfIn = declaredInputs.get(binding.source.portId);
            if (wfIn !== undefined) {
              inferredType =
                wfIn.type === 'source-list' && binding.selection !== undefined
                  ? 'source'
                  : wfIn.type;
            }
          } else {
            const peer = knownWorkflowOf(binding.source.nodeId)?.outputs?.find(
              (port) => port.portId === binding.source.portId
            );
            const outputType = peer?.type ?? DEFAULT_OUTPUT_TYPE;
            inferredType = WORKFLOW_PORT_COMPATIBILITY[outputType][0];
          }
          inputs.set(binding.inputKey, inferredType);
        }
      }

      if (binding.source.from === 'node-output') {
        const absentSource = absentWorkflowOf(binding.source.nodeId);
        if (absentSource !== null) {
          const outputs = needFor(workflowNeeds, absentSource).outputs;
          if (!outputs.has(binding.source.portId)) {
            const peer = knownWorkflowOf(binding.nodeId)?.inputs?.find(
              (port) => port.portId === binding.inputKey
            );
            const targetType = peer?.type ?? binding.type;
            const outType = targetType ? OUTPUT_TYPE_FEEDING.get(targetType) : undefined;
            outputs.set(binding.source.portId, outType ?? DEFAULT_OUTPUT_TYPE);
          }
        }
      }
    } else {
      const absentSource = absentWorkflowOf(binding.nodeId);
      if (absentSource !== null) {
        const outputs = needFor(workflowNeeds, absentSource).outputs;
        const sourcePortId = binding.sourcePortId ?? binding.outputKey ?? binding.portId;
        if (!outputs.has(sourcePortId)) {
          const wfOut = declaredOutputs.get(binding.portId);
          outputs.set(sourcePortId, wfOut?.type ?? binding.type ?? DEFAULT_OUTPUT_TYPE);
        }
      }
    }
  }
}

function placeholderWorkflow(
  workflowId: string,
  need: PlaceholderWorkflowNeed
): WorkflowDefinition {
  const inputs: WorkflowInputPort[] = [...need.inputs].map(([portId, type]) => ({
    portId,
    label: portId,
    type,
    required: false
  }));
  const outputs: WorkflowOutputPort[] = [...need.outputs].map(([portId, type]) => ({
    portId,
    label: portId,
    type,
    required: false
  }));

  if (need.structured && !outputs.some((port) => STRUCTURED_OUTPUT_TYPES.has(port.type))) {
    let portId = STRUCTURED_PORT_ID;
    let suffix = 1;
    while (outputs.some((port) => port.portId === portId)) {
      portId = `${STRUCTURED_PORT_ID}-${suffix}`;
      suffix += 1;
    }
    outputs.push({ portId, label: portId, type: 'structured-data', required: false });
  }

  return {
    workflowId,
    name: workflowId,
    version: 1,
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(outputs.length > 0 ? { outputs } : {}),
    nodes: [{ nodeId: 'step', kind: 'phase', phaseId: PLACEHOLDER_PHASE_ID }],
    connections: [],
    startNodeIds: ['step']
  };
}

const EMPTY_PHASE_CATALOG: WorkflowPhaseContext = Object.freeze({
  effective: Object.freeze([]),
  records: Object.freeze([])
});

/**
 * The definition a references-only Workflow export writes, or why there is none.
 */
export function selectWorkflowForExport(
  input: WorkflowExportSelectionInput
): WorkflowExportSelection {
  const phaseCatalog = input.phaseCatalog ?? EMPTY_PHASE_CATALOG;
  const effectiveRow = (records: ReturnType<typeof resolveWorkflowCatalog>['records']) =>
    records.find((row) => row.workflowId === input.workflowId && row.status === 'effective');

  const strict = resolveWorkflowCatalog({
    rows: input.rows,
    revision: '',
    phaseCatalog
  });
  let selected = effectiveRow(strict.records);

  if (!selected?.definition) {
    const knownPhases = new Set(phaseCatalog.effective.map((phase) => phase.phaseId));
    const knownWorkflows = new Map(
      strict.effective.map((workflow) => [workflow.workflowId, workflow])
    );
    const missingPhases = new Set<string>();
    const workflowNeeds = new Map<string, PlaceholderWorkflowNeed>();
    const targetRows: unknown[] = [];

    (input.rows ?? []).forEach((row, index) => {
      if (workflowSourceIdentity(row, index) !== input.workflowId) return;
      targetRows.push(row);
      const parsed = validateWorkflowDefinition(row);
      if (parsed.definition !== null) {
        deriveNeeds(
          parsed.definition,
          knownPhases,
          knownWorkflows,
          missingPhases,
          workflowNeeds
        );
      }
    });

    if (missingPhases.size > 0 || workflowNeeds.size > 0) {
      const placeholderPhases = [...missingPhases]
        .filter((phaseId) => !knownPhases.has(phaseId))
        .map(placeholderPhase);
      const placeholderWorkflows = [...workflowNeeds].map(([workflowId, need]) =>
        placeholderWorkflow(workflowId, need)
      );
      const relaxed = resolveWorkflowCatalog({
        rows: [...targetRows, ...strict.effective, ...placeholderWorkflows],
        revision: '',
        phaseCatalog: {
          effective: [...phaseCatalog.effective, ...placeholderPhases],
          records: []
        }
      });
      selected = effectiveRow(relaxed.records);
    }
  }

  if (selected?.definition) {
    return { outcome: 'selected', definition: selected.definition };
  }

  return {
    outcome: 'unavailable',
    reason: strict.records.some((row) => row.workflowId === input.workflowId)
      ? 'does-not-resolve'
      : 'not-found'
  };
}
