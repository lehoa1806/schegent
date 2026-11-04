// Feature 086 / Feature 263 (FR-R5-F04) — `WorkflowYamlDocument` <-> `WorkflowDefinition`, and bytes.
//
// Two separated steps:
//   1. `documentFromWorkflowDefinition` renames `workflowId` -> `metadata.id`, moves the
//      authored body under `spec`, and builds `included` (`workflows`, `phases`) when
//      `inclusion` is supplied.
//   2. `serializeWorkflowDocument` / `emitWorkflowDocumentBody` emit canonical bytes from
//      the closed key-order constants in `yaml-serializer.ts` without reading `Object.keys`.
//
// Three rules make the round trip lossless:
//   * An empty list (`inputs`, `outputs`, `connections`, `bindings`, `recommendedNext`) or
//     an `executionDefaults` mapping with all fields undefined is OMITTED, not written as a
//     childless key. `nodes` and `startNodeIds` are always required and non-empty.
//   * An absent optional stays absent; nothing is defaulted on export (`version` least of all).
//   * A present `false` (`required: false`, `isDefault: false`) is written verbatim.

import type { WorkflowGraphEdge } from '../../config/workflow-graph';
import { stronglyConnectedComponents, topologicalOrder } from '../../config/workflow-graph';
import { PIPELINE_ID_PATTERN } from '../../config/pipeline-definition-validator';
import { validateWorkflowDefinition } from '../../config/workflow-definition-validator';
import type { PhaseDefinition } from '../../contracts/process-definitions';
import type {
  WorkflowBinding,
  WorkflowCondition,
  WorkflowConditionLiteral,
  WorkflowConnection,
  WorkflowDefinition,
  WorkflowInputPort,
  WorkflowNode,
  WorkflowOutputPort
} from '../../contracts/workflow-definitions';
import {
  admitSection,
  declaresSecondRoot,
  echo,
  firstRepeatedDeclaredId,
  hasOwn,
  readIncludedSections,
  standaloneNode
} from './package-reader';
import { documentFromPhaseDefinition } from './phase-yaml-mapper';
import {
  defect,
  findScalar,
  readSection,
  unknownField,
  validatePhaseDocument
} from './phase-yaml-validator';
import type {
  DocumentRefusal,
  DocumentRefusalCode,
  ImportDefect,
  PhaseYamlDocument,
  PhaseYamlDocumentBody,
  ProcessYamlResourceKind,
  WorkflowYamlDocument,
  WorkflowYamlDocumentBody,
  WorkflowYamlIncluded,
  WorkflowYamlSpec,
  YamlMappingNode,
  YamlNode
} from './types';
import {
  PHASE_YAML_API_VERSION,
  PHASE_YAML_INDENT,
  PHASE_YAML_KIND,
  WORKFLOW_YAML_KIND
} from './types';
import { referencedPhaseClosure, referencedWorkflowClosure } from './workflow-export-closure';
import {
  EXECUTION_DEFAULTS_KEY_ORDER,
  WORKFLOW_BINDING_KEY_ORDER,
  WORKFLOW_BINDING_SOURCE_KEY_ORDER,
  WORKFLOW_CONDITION_KEY_ORDER,
  WORKFLOW_CONNECTION_KEY_ORDER,
  WORKFLOW_ENDPOINT_KEY_ORDER,
  WORKFLOW_INCLUDED_KEY_ORDER,
  WORKFLOW_METADATA_KEY_ORDER,
  WORKFLOW_NODE_KEY_ORDER,
  WORKFLOW_OPERAND_KEY_ORDER,
  WORKFLOW_PACKAGE_DOCUMENT_KEY_ORDER,
  WORKFLOW_PORT_KEY_ORDER,
  WORKFLOW_SPEC_KEY_ORDER,
  emitEntry,
  emitKey,
  emitMapping,
  emitMappingSequence,
  emitPhaseDocumentBody,
  emitSequence
} from './yaml-serializer';

/**
 * The resolved dependencies an `include-closure` export supplies (FR-R5-F04).
 */
export interface WorkflowInclusion {
  readonly workflows?: readonly WorkflowDefinition[];
  readonly phases?: readonly PhaseDefinition[];
}

function includedPhaseBodies(
  orderedWorkflows: readonly WorkflowDefinition[],
  phases: readonly PhaseDefinition[] | undefined
): readonly PhaseYamlDocumentBody[] {
  if (phases === undefined || phases.length === 0) return [];
  const byId = new Map(phases.map((phase) => [phase.phaseId, phase]));
  const bodies: PhaseYamlDocumentBody[] = [];
  for (const phaseId of referencedPhaseClosure(orderedWorkflows)) {
    const definition = byId.get(phaseId);
    if (definition === undefined) continue;
    const document = documentFromPhaseDefinition(definition);
    bodies.push({ metadata: document.metadata, spec: document.spec });
  }
  return bodies;
}

function includedSection(
  definition: WorkflowDefinition,
  inclusion: WorkflowInclusion
): WorkflowYamlIncluded | undefined {
  const workflowsById = new Map(
    (inclusion.workflows ?? []).map((workflow) => [workflow.workflowId, workflow])
  );
  const workflowBodies: WorkflowYamlDocumentBody[] = [];
  const orderedWorkflows: WorkflowDefinition[] = [];
  for (const child of referencedWorkflowClosure(definition, workflowsById)) {
    orderedWorkflows.push(child);
    const document = documentFromWorkflowDefinition(child);
    workflowBodies.push({ metadata: document.metadata, spec: document.spec });
  }

  const phaseBodies = includedPhaseBodies([definition, ...orderedWorkflows], inclusion.phases);
  if (workflowBodies.length === 0 && phaseBodies.length === 0) return undefined;
  return {
    ...(workflowBodies.length === 0 ? {} : { workflows: workflowBodies }),
    ...(phaseBodies.length === 0 ? {} : { phases: phaseBodies })
  };
}

/**
 * Turn a catalog Workflow definition into a portable package document.
 */
export function documentFromWorkflowDefinition(
  definition: WorkflowDefinition,
  inclusion?: WorkflowInclusion
): WorkflowYamlDocument {
  const included =
    inclusion === undefined ? undefined : includedSection(definition, inclusion);

  const spec: WorkflowYamlSpec = {
    ...(definition.inputs !== undefined ? { inputs: definition.inputs } : {}),
    ...(definition.outputs !== undefined ? { outputs: definition.outputs } : {}),
    nodes: definition.nodes,
    connections: definition.connections,
    ...(definition.bindings !== undefined ? { bindings: definition.bindings } : {}),
    startNodeIds: definition.startNodeIds,
    ...(definition.executionDefaults !== undefined
      ? { executionDefaults: definition.executionDefaults }
      : {}),
    ...(definition.recommendedNext !== undefined
      ? { recommendedNext: definition.recommendedNext }
      : {})
  };

  return {
    apiVersion: PHASE_YAML_API_VERSION,
    kind: WORKFLOW_YAML_KIND,
    metadata: {
      id: definition.workflowId,
      name: definition.name,
      ...(definition.description !== undefined ? { description: definition.description } : {}),
      version: definition.version
    },
    spec,
    ...(included !== undefined ? { included } : {})
  };
}

function isLiteralList(
  right: WorkflowConditionLiteral | readonly WorkflowConditionLiteral[]
): right is readonly WorkflowConditionLiteral[] {
  return Array.isArray(right);
}

function renderPort(
  bodyIndent: string,
  port: WorkflowInputPort | WorkflowOutputPort
): string {
  return emitMapping(bodyIndent, WORKFLOW_PORT_KEY_ORDER, port);
}

function renderNode(bodyIndent: string, node: WorkflowNode): string {
  return emitMapping(bodyIndent, WORKFLOW_NODE_KEY_ORDER, node);
}

function renderCondition(indent: string, condition: WorkflowCondition): string {
  const nestedIndent = `${indent}${PHASE_YAML_INDENT}`;
  let out = '';
  for (const key of WORKFLOW_CONDITION_KEY_ORDER) {
    switch (key) {
      case 'left':
        out += emitKey(indent, 'left');
        out += emitMapping(nestedIndent, WORKFLOW_OPERAND_KEY_ORDER, condition.left);
        break;
      case 'operator':
        out += emitEntry(indent, 'operator', condition.operator);
        break;
      case 'right':
        if (condition.right === undefined) break;
        out += isLiteralList(condition.right)
          ? emitSequence(indent, 'right', condition.right)
          : emitEntry(indent, 'right', condition.right);
        break;
    }
  }
  return out;
}

function renderConnection(bodyIndent: string, connection: WorkflowConnection): string {
  const nestedIndent = `${bodyIndent}${PHASE_YAML_INDENT}`;
  let out = '';
  for (const key of WORKFLOW_CONNECTION_KEY_ORDER) {
    switch (key) {
      case 'from':
      case 'to':
        out += emitKey(bodyIndent, key);
        out += emitMapping(nestedIndent, WORKFLOW_ENDPOINT_KEY_ORDER, connection[key]);
        break;
      case 'condition':
        if (connection.condition === undefined) break;
        out += emitKey(bodyIndent, 'condition');
        out += renderCondition(nestedIndent, connection.condition);
        break;
      case 'handoff':
      case 'priority':
      case 'isDefault':
      case 'selection':
        out += emitMapping(bodyIndent, [key], connection);
        break;
    }
  }
  return out;
}

function renderBinding(bodyIndent: string, binding: WorkflowBinding): string {
  let out = '';
  for (const key of WORKFLOW_BINDING_KEY_ORDER) {
    if (key === 'source') {
      if (binding.kind === 'input') {
        out += emitKey(bodyIndent, 'source');
        out += emitMapping(
          `${bodyIndent}${PHASE_YAML_INDENT}`,
          WORKFLOW_BINDING_SOURCE_KEY_ORDER,
          binding.source
        );
      }
      continue;
    }
    out += emitMapping(bodyIndent, [key], binding);
  }
  return out;
}

function renderExecutionDefaults(indent: string, spec: WorkflowYamlSpec): string {
  if (spec.executionDefaults === undefined) return '';
  const body = emitMapping(
    `${indent}${PHASE_YAML_INDENT}`,
    EXECUTION_DEFAULTS_KEY_ORDER,
    spec.executionDefaults
  );
  if (body.length === 0) return '';
  return emitKey(indent, 'executionDefaults') + body;
}

function renderSpec(indent: string, spec: WorkflowYamlSpec): string {
  let out = '';
  for (const key of WORKFLOW_SPEC_KEY_ORDER) {
    switch (key) {
      case 'inputs':
        if (spec.inputs !== undefined) {
          out += emitMappingSequence(indent, 'inputs', spec.inputs, renderPort);
        }
        break;
      case 'outputs':
        if (spec.outputs !== undefined) {
          out += emitMappingSequence(indent, 'outputs', spec.outputs, renderPort);
        }
        break;
      case 'nodes':
        out += emitMappingSequence(indent, 'nodes', spec.nodes, renderNode);
        break;
      case 'connections':
        out += emitMappingSequence(indent, 'connections', spec.connections, renderConnection);
        break;
      case 'bindings':
        if (spec.bindings !== undefined) {
          out += emitMappingSequence(indent, 'bindings', spec.bindings, renderBinding);
        }
        break;
      case 'startNodeIds':
        out += emitSequence(indent, 'startNodeIds', spec.startNodeIds);
        break;
      case 'executionDefaults':
        out += renderExecutionDefaults(indent, spec);
        break;
      case 'recommendedNext':
        if (spec.recommendedNext !== undefined) {
          out += emitSequence(indent, 'recommendedNext', spec.recommendedNext);
        }
        break;
    }
  }
  return out;
}

/**
 * Emit a Workflow's two body mappings (`metadata` and `spec`) at any indent.
 * Reused by both root `serializeWorkflowDocument` and `included.workflows`.
 */
export function emitWorkflowDocumentBody(
  indent: string,
  body: WorkflowYamlDocumentBody
): string {
  const fieldIndent = `${indent}${PHASE_YAML_INDENT}`;
  return (
    emitKey(indent, 'metadata') +
    emitMapping(fieldIndent, WORKFLOW_METADATA_KEY_ORDER, body.metadata) +
    emitKey(indent, 'spec') +
    renderSpec(fieldIndent, body.spec)
  );
}

function renderIncluded(included: WorkflowYamlIncluded | undefined): string {
  if (included === undefined) return '';
  let body = '';
  for (const key of WORKFLOW_INCLUDED_KEY_ORDER) {
    switch (key) {
      case 'workflows':
        if (included.workflows !== undefined) {
          body += emitMappingSequence(
            PHASE_YAML_INDENT,
            'workflows',
            included.workflows,
            emitWorkflowDocumentBody
          );
        }
        break;
      case 'phases':
        if (included.phases !== undefined) {
          body += emitMappingSequence(
            PHASE_YAML_INDENT,
            'phases',
            included.phases,
            emitPhaseDocumentBody
          );
        }
        break;
    }
  }
  if (body.length === 0) return '';
  return emitKey('', 'included') + body;
}

/**
 * Render a Workflow package document to canonical UTF-8 text.
 */
export function serializeWorkflowDocument(document: WorkflowYamlDocument): string {
  let out = '';
  for (const key of WORKFLOW_PACKAGE_DOCUMENT_KEY_ORDER) {
    switch (key) {
      case 'apiVersion':
      case 'kind':
        out += emitMapping('', [key], document);
        break;
      case 'metadata':
        out += emitWorkflowDocumentBody('', document);
        break;
      case 'spec':
        break;
      case 'included':
        out += renderIncluded(document.included);
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading a Workflow package back — feature 086 / feature 263 (FR-R5-F04)
// ---------------------------------------------------------------------------

/** One classified resource in a Workflow package. */
export type WorkflowPackageResource =
  | {
      readonly ok: true;
      readonly resourceKind: 'workflow';
      readonly definition: WorkflowDefinition;
    }
  | {
      readonly ok: true;
      readonly resourceKind: 'phase';
      readonly document: PhaseYamlDocument;
    }
  | {
      readonly ok: false;
      readonly resourceKind: ProcessYamlResourceKind;
      /** `null` when the resource did not carry a readable, well-formed id. */
      readonly resourceId: string | null;
      readonly defects: readonly ImportDefect[];
    };

export type WorkflowPackageResult =
  | { readonly ok: true; readonly resources: readonly WorkflowPackageResource[] }
  | { readonly ok: false; readonly refusal: DocumentRefusal };

const WORKFLOW_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set<string>(
  WORKFLOW_PACKAGE_DOCUMENT_KEY_ORDER
);
const WORKFLOW_BODY_KEYS: ReadonlySet<string> = new Set<string>(['metadata', 'spec']);
const WORKFLOW_METADATA_KEYS: ReadonlySet<string> = new Set<string>(WORKFLOW_METADATA_KEY_ORDER);
const WORKFLOW_SPEC_KEYS: ReadonlySet<string> = new Set<string>(WORKFLOW_SPEC_KEY_ORDER);

function refuseWorkflowPackage(code: DocumentRefusalCode, message: string): WorkflowPackageResult {
  return { ok: false, refusal: { code, message } };
}

function classifyWorkflow(
  node: YamlMappingNode,
  includedDefects: readonly ImportDefect[],
  topLevelKeys: ReadonlySet<string> = WORKFLOW_TOP_LEVEL_KEYS
): WorkflowPackageResource {
  const defects: ImportDefect[] = [];
  for (const entry of node.entries) {
    if (!topLevelKeys.has(entry.key)) defects.push(unknownField(entry.key));
  }
  defects.push(...includedDefects);

  const metadataSection = readSection(node, 'metadata', defects);
  const specSection = readSection(node, 'spec', defects);

  const raw = Object.create(null) as Record<string, unknown>;
  let resourceId: string | null = null;

  if (metadataSection !== null) {
    admitSection(metadataSection, WORKFLOW_METADATA_KEYS, raw, defects, { id: 'workflowId' });
    if (!hasOwn(raw, 'version')) {
      defects.push(defect('version', 'required', 'version is required'));
    }
    const id = findScalar(metadataSection, 'id');
    if (id !== undefined && PIPELINE_ID_PATTERN.test(id.value)) resourceId = id.value;
  }
  if (specSection !== null) {
    admitSection(specSection, WORKFLOW_SPEC_KEYS, raw, defects);
  }

  if (metadataSection === null || specSection === null) {
    return { ok: false, resourceKind: 'workflow', resourceId, defects: Object.freeze(defects) };
  }

  const validated = validateWorkflowDefinition(raw, {
    allowLegacyId: false,
    allowLegacyPipelineId: false
  });
  for (const error of validated.errors) {
    defects.push(
      defect(error.field === 'workflowId' ? 'id' : error.field, error.code, error.message)
    );
  }

  if (defects.length > 0 || validated.definition === null) {
    return { ok: false, resourceKind: 'workflow', resourceId, defects: Object.freeze(defects) };
  }
  return { ok: true, resourceKind: 'workflow', definition: validated.definition };
}

/**
 * An included child Workflow, classified by the same rules as the root Workflow.
 */
export function classifyIncludedWorkflow(item: YamlNode): WorkflowPackageResource {
  if (item.kind !== 'mapping') {
    return {
      ok: false,
      resourceKind: 'workflow',
      resourceId: null,
      defects: Object.freeze([
        defect(
          'included.workflows',
          'mapping-required',
          'Each included workflow must be a mapping'
        )
      ])
    };
  }
  return classifyWorkflow(item, [], WORKFLOW_BODY_KEYS);
}

/**
 * An included Phase, classified by the shipped Phase rules (`validatePhaseDocument`).
 */
export function classifyIncludedPhase(item: YamlNode): WorkflowPackageResource {
  if (item.kind !== 'mapping') {
    return {
      ok: false,
      resourceKind: 'phase',
      resourceId: null,
      defects: Object.freeze([
        defect('included.phases', 'mapping-required', 'Each included phase must be a mapping')
      ])
    };
  }

  const result = validatePhaseDocument(standaloneNode(item, PHASE_YAML_KIND));
  if (result.ok) return { ok: true, resourceKind: 'phase', document: result.document };
  if (result.kind === 'document') {
    return {
      ok: false,
      resourceKind: 'phase',
      resourceId: null,
      defects: Object.freeze([
        defect('included.phases', result.refusal.code, result.refusal.message)
      ])
    };
  }
  return {
    ok: false,
    resourceKind: 'phase',
    resourceId: result.resourceId,
    defects: result.defects
  };
}

function readGraphShape(node: YamlMappingNode): {
  readonly nodeIds: readonly string[];
  readonly edges: readonly WorkflowGraphEdge[];
} {
  const spec = node.entries.find((entry) => entry.key === 'spec');
  if (spec === undefined || spec.value.kind !== 'mapping') return { nodeIds: [], edges: [] };

  const nodesEntry = spec.value.entries.find((entry) => entry.key === 'nodes');
  const nodeIds: string[] = [];
  if (nodesEntry !== undefined && nodesEntry.value.kind === 'sequence') {
    for (const item of nodesEntry.value.items) {
      if (item.kind !== 'mapping') continue;
      const declared = findScalar(item, 'nodeId');
      if (declared !== undefined && declared.value.length > 0) nodeIds.push(declared.value);
    }
  }

  const knownNodeIds = new Set(nodeIds);
  const connectionsEntry = spec.value.entries.find((entry) => entry.key === 'connections');
  const edges: WorkflowGraphEdge[] = [];
  if (connectionsEntry !== undefined && connectionsEntry.value.kind === 'sequence') {
    const endpointNodeId = (item: YamlMappingNode, side: 'from' | 'to'): string | null => {
      const endpoint = item.entries.find((entry) => entry.key === side);
      if (endpoint === undefined || endpoint.value.kind !== 'mapping') return null;
      if (side === 'to') {
        const kindScalar = findScalar(endpoint.value, 'kind');
        if (kindScalar?.value === 'return') return null;
      }
      const declared = findScalar(endpoint.value, 'nodeId');
      if (declared === undefined || declared.value.length === 0) return null;
      if (side === 'to' && declared.value === 'return' && !knownNodeIds.has('return')) {
        return null;
      }
      return declared.value;
    };
    for (const item of connectionsEntry.value.items) {
      if (item.kind !== 'mapping') continue;
      const from = endpointNodeId(item, 'from');
      const to = endpointNodeId(item, 'to');
      if (from === null || to === null) continue;
      edges.push({ from, to });
    }
  }

  return { nodeIds, edges };
}

function firstCycle(
  nodeIds: readonly string[],
  edges: readonly WorkflowGraphEdge[]
): readonly string[] | null {
  const { residual } = topologicalOrder(nodeIds, edges);
  if (residual.length === 0) return null;
  const [component] = stronglyConnectedComponents(residual, edges);
  return component === undefined ? null : [...component].sort();
}

/**
 * Classify every resource a Workflow package declares.
 */
export function parseWorkflowPackage(node: YamlMappingNode): WorkflowPackageResult {
  const apiVersion = findScalar(node, 'apiVersion');
  if (apiVersion === undefined) {
    return refuseWorkflowPackage('unsupported-version', 'Document does not declare apiVersion');
  }
  if (apiVersion.value !== PHASE_YAML_API_VERSION) {
    return refuseWorkflowPackage(
      'unsupported-version',
      `Unsupported apiVersion '${echo(apiVersion.value)}'; this build reads ${PHASE_YAML_API_VERSION}`
    );
  }
  const kind = findScalar(node, 'kind');
  if (kind === undefined) {
    return refuseWorkflowPackage('unsupported-kind', 'Document does not declare kind');
  }
  if (kind.value !== WORKFLOW_YAML_KIND) {
    return refuseWorkflowPackage(
      'unsupported-kind',
      `Unsupported kind '${echo(kind.value)}'; expected ${WORKFLOW_YAML_KIND}`
    );
  }

  const included = readIncludedSections(node, WORKFLOW_INCLUDED_KEY_ORDER);
  const includedDefects = [...included.defects];
  if (included.present && included.declared.size === 0) {
    includedDefects.push(
      defect(
        'included',
        'required',
        `included must declare at least one of: ${WORKFLOW_INCLUDED_KEY_ORDER.join(', ')}`
      )
    );
  }

  const workflows = included.bySection.get('workflows') ?? [];
  const phases = included.bySection.get('phases') ?? [];

  if (declaresSecondRoot([...workflows, ...phases])) {
    return refuseWorkflowPackage(
      'multi-document',
      'An included resource declares its own apiVersion or kind; a package declares exactly one root'
    );
  }

  const repeatedWorkflow = firstRepeatedDeclaredId([node, ...workflows], 'id');
  if (repeatedWorkflow !== null) {
    return refuseWorkflowPackage(
      'duplicate-id',
      `Two Workflows in the package declare the id '${echo(repeatedWorkflow)}'; each id may be declared once`
    );
  }
  const repeatedPhase = firstRepeatedDeclaredId(phases, 'phaseId');
  if (repeatedPhase !== null) {
    return refuseWorkflowPackage(
      'duplicate-id',
      `Two included Phases declare the id '${echo(repeatedPhase)}'; each id may be declared once`
    );
  }

  for (const candidate of [node, ...workflows]) {
    if (candidate.kind !== 'mapping') continue;
    const shape = readGraphShape(candidate);
    const cycle = firstCycle(shape.nodeIds, shape.edges);
    if (cycle !== null) {
      return refuseWorkflowPackage(
        'graph-cycle',
        `Nodes form a cycle: ${echo(cycle.join(', '))}`
      );
    }
  }

  return {
    ok: true,
    resources: Object.freeze([
      classifyWorkflow(node, includedDefects),
      ...workflows.map(classifyIncludedWorkflow),
      ...phases.map(classifyIncludedPhase)
    ])
  };
}
