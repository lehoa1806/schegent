// Feature 086 T013 — `WorkflowYamlDocument` <- `WorkflowDefinition`, and bytes.
//
// The Pipeline document's module is the template, deliberately and structurally:
// same two separated steps, same emitters, same three rules. What differs is the
// nine key orders and the shapes they walk, and nothing else — 086 widens the
// grammar by ZERO productions (research R1, pinned by the T001 gate and the T003
// hash freeze), so a Workflow document is written with the primitives 084 and 085
// already shipped.
//
// Step one is a rename and a regrouping and nothing else: `workflowId` becomes
// `metadata.id`, the authored body moves under `spec`, and every other value is
// carried verbatim (data-model.md §2.2). Step two decides bytes, and it decides
// them from the key-order constants in `yaml-serializer.ts` rather than from the
// order in which a caller happened to build the object — nothing here reads
// `Object.keys`.
//
// Three rules make the round trip lossless, and all three live in step two:
//
//   * An empty list is OMITTED, not written as a childless key. `connections:`
//     with nothing under it reads back as an empty MAPPING, which would corrupt
//     the round trip in exactly the case where nothing is happening (research
//     R3). The reader reads an absent list-typed key as `[]` (data-model.md
//     §2.5) — except for `nodes` and `startNodeIds`, which have no empty form:
//     a Workflow without them is not a Workflow, so their absence is a defect.
//   * An absent optional stays absent. Nothing is defaulted on the way out,
//     `version` least of all (FR-003a).
//   * A written `false` is written. Only an ABSENT optional is omitted, so an
//     `isDefault: false` the operator authored survives; collapsing it into
//     absence would silently rewrite the graph on the way out.
//
// Two absences are load-bearing. A connection carries no identifier of its own —
// positional addressing is for defect reporting only and must not leak into the
// document — and a Workflow's inputs and outputs are derived from its nodes'
// unbound ports and never stored, so there is no `spec.inputs` or `spec.outputs`
// arm below to omit. Both are standing hard rules, and `WorkflowYamlSpec` has no
// field for either, so neither is reachable from here.
//
// A condition is structured data, and this module treats it as such: `left`,
// `operator`, `right` are three mappings and a scalar walked by declared order.
// There is no string form to build and no expression to compose, so there is
// nothing here to parse and nothing to sandbox (FR-006).
//
// A Pipeline reference is a plain identifier and stays one. A path-shaped
// reference fails the id pattern like any other malformed id; it is never opened,
// joined, or resolved as a location.

import type { WorkflowGraphEdge } from '../../config/workflow-graph';
import { stronglyConnectedComponents, topologicalOrder } from '../../config/workflow-graph';
// The Workflow id pattern IS the Pipeline one — the catalog validator reuses it
// rather than declaring a third, so the reader reuses it too instead of writing a
// fourth copy of the same regex.
import { PIPELINE_ID_PATTERN } from '../../config/pipeline-definition-validator';
import { validateWorkflowDefinition } from '../../config/workflow-definition-validator';
import type { PhaseDefinition } from '../../contracts/process-definitions';
import type { PipelineDefinition } from '../../contracts/pipeline-definitions';
import type {
  WorkflowCondition,
  WorkflowConditionLiteral,
  WorkflowConnection,
  WorkflowDefinition,
  WorkflowNode
} from '../../contracts/workflow-definitions';
import {
  admitSection,
  declaresSecondRoot,
  echo,
  firstRepeatedDeclaredId,
  hasOwn,
  readIncludedSections
} from './package-reader';
import { documentFromPhaseDefinition } from './phase-yaml-mapper';
import { defect, findScalar, readSection, unknownField } from './phase-yaml-validator';
import {
  classifyIncludedPhase,
  classifyIncludedPipeline,
  documentFromPipelineDefinition,
  emitPipelineDocumentBody
} from './pipeline-document';
import type {
  DocumentRefusal,
  DocumentRefusalCode,
  ImportDefect,
  PhaseYamlDocument,
  PhaseYamlDocumentBody,
  PipelineYamlDocumentBody,
  ProcessYamlResourceKind,
  WorkflowYamlDocument,
  WorkflowYamlIncluded,
  WorkflowYamlSpec,
  YamlMappingNode
} from './types';
import {
  PHASE_YAML_API_VERSION,
  PHASE_YAML_INDENT,
  WORKFLOW_YAML_KIND
} from './types';
import { referencedPhaseClosure, referencedPipelineOrder } from './workflow-export-closure';
import {
  WORKFLOW_CONDITION_KEY_ORDER,
  WORKFLOW_CONNECTION_KEY_ORDER,
  WORKFLOW_ENDPOINT_KEY_ORDER,
  WORKFLOW_INCLUDED_KEY_ORDER,
  WORKFLOW_METADATA_KEY_ORDER,
  WORKFLOW_NODE_KEY_ORDER,
  WORKFLOW_OPERAND_KEY_ORDER,
  WORKFLOW_PACKAGE_DOCUMENT_KEY_ORDER,
  WORKFLOW_SPEC_KEY_ORDER,
  emitEntry,
  emitKey,
  emitMapping,
  emitMappingSequence,
  emitPhaseDocumentBody,
  emitSequence
} from './yaml-serializer';

/**
 * The resolved dependencies an inclusion export supplies (FR-017).
 *
 * A record rather than a bare array, because a Workflow has two dependency
 * classes and the modes differ in which they carry: the middle mode supplies
 * `pipelines` alone, the closure mode supplies both. A mode that omits `phases`
 * writes no `phases` key at all rather than an empty one (research R3).
 */
export interface WorkflowInclusion {
  readonly pipelines: readonly PipelineDefinition[];
  /**
   * The closure's Phases (feature 086 T028, FR-019). Absent in the middle mode,
   * which carries the compositions and leaves the Phases where they are.
   */
  readonly phases?: readonly PhaseDefinition[];
}

/**
 * The `included` section, or `undefined` when there is nothing to include.
 *
 * Order and de-duplication are derived HERE — the Pipelines from the graph, the
 * Phases from those Pipelines — rather than taken from the caller's arrays, so a
 * caller that resolved either level in some other order still writes the same
 * bytes (FR-021). Both are lookups, not sequences, and over-supplying either
 * cannot widen the document.
 *
 * A referenced id the caller did not supply is skipped rather than stubbed. The
 * exporter refuses the whole export before reaching this point when a reference
 * does not resolve (FR-022), so the gap is unreachable in the shipped path; a stub
 * would be the partial document that requirement forbids.
 */
function includedSection(
  nodes: readonly WorkflowNode[],
  inclusion: WorkflowInclusion
): WorkflowYamlIncluded | undefined {
  const byId = new Map(inclusion.pipelines.map((pipeline) => [pipeline.pipelineId, pipeline]));
  const bodies: PipelineYamlDocumentBody[] = [];
  // The order both sections are derived from: level 1 fixes it, level 2 follows it.
  const ordered: PipelineDefinition[] = [];
  for (const pipelineId of referencedPipelineOrder(nodes)) {
    const definition = byId.get(pipelineId);
    if (definition === undefined) continue;
    ordered.push(definition);
    // FR-008 — the same two mappings the single-Pipeline document defines, built
    // by the same mapper. `apiVersion` and `kind` are dropped because the package
    // already declared them, and a repeat is a second root (FR-002). The mapper is
    // called in its references-only form, so no Pipeline carries a nested
    // `included` either.
    const document = documentFromPipelineDefinition(definition);
    bodies.push({ metadata: document.metadata, spec: document.spec });
  }

  const phaseBodies = includedPhaseBodies(ordered, inclusion.phases);
  if (bodies.length === 0 && phaseBodies.length === 0) return undefined;
  return {
    pipelines: bodies,
    ...(phaseBodies.length === 0 ? {} : { phases: phaseBodies })
  };
}

/**
 * The closure's Phase bodies, in closure order (FR-019, FR-020).
 *
 * Walked from the ORDERED Pipelines above, so the second section follows the
 * first rather than the caller's array — and de-duplicated closure-wide by
 * `referencedPhaseClosure`, so a Phase two Pipelines both name appears once.
 *
 * Empty whenever the caller supplied no Phases, which is the middle mode: the
 * absence is what makes `included.phases` omitted rather than written childless
 * (research R3).
 */
function includedPhaseBodies(
  ordered: readonly PipelineDefinition[],
  phases: readonly PhaseDefinition[] | undefined
): readonly PhaseYamlDocumentBody[] {
  if (phases === undefined || phases.length === 0) return [];
  const byId = new Map(phases.map((phase) => [phase.phaseId, phase]));
  const bodies: PhaseYamlDocumentBody[] = [];
  for (const phaseId of referencedPhaseClosure(ordered)) {
    const definition = byId.get(phaseId);
    if (definition === undefined) continue;
    // The shipped Phase mapper, for the same reason the Pipeline one is reused:
    // an included Phase and a standalone Phase are the same bytes at a different
    // indent because they come from the same function, not because two functions
    // agree today (FR-008).
    const document = documentFromPhaseDefinition(definition);
    bodies.push({ metadata: document.metadata, spec: document.spec });
  }
  return bodies;
}

/**
 * Turn a catalog definition into a portable package document.
 *
 * `inclusion` is the operator's choice made concrete: omitted for a
 * references-only export, which produces no `included` key at all (FR-015).
 * Supplying it never changes `spec` — inclusion ADDS a lookup table beside the
 * graph and never rewrites a node's `pipelineId` into an inline definition
 * (FR-009). That is what keeps a references-only document a byte prefix of the
 * self-contained one.
 */
export function documentFromWorkflowDefinition(
  definition: WorkflowDefinition,
  inclusion?: WorkflowInclusion
): WorkflowYamlDocument {
  const included =
    inclusion === undefined ? undefined : includedSection(definition.nodes, inclusion);

  return {
    apiVersion: PHASE_YAML_API_VERSION,
    kind: WORKFLOW_YAML_KIND,
    metadata: {
      id: definition.workflowId,
      name: definition.name,
      ...(definition.description !== undefined ? { description: definition.description } : {}),
      version: definition.version
    },
    spec: {
      nodes: definition.nodes,
      connections: definition.connections,
      startNodeIds: definition.startNodeIds
    },
    ...(included !== undefined ? { included } : {})
  };
}

/**
 * Whether a `right` is the list form.
 *
 * A named guard rather than a bare `Array.isArray`, which narrows to the mutable
 * `any[]` and so leaves `readonly WorkflowConditionLiteral[]` in the other branch
 * — the scalar emitter would then be handed a list the compiler still believes
 * could be there. The predicate makes the narrowing the compiler cannot infer
 * explicit, without widening what either branch accepts.
 */
function isLiteralList(
  right: WorkflowConditionLiteral | readonly WorkflowConditionLiteral[]
): right is readonly WorkflowConditionLiteral[] {
  return Array.isArray(right);
}

function renderNode(bodyIndent: string, node: WorkflowNode): string {
  return emitMapping(bodyIndent, WORKFLOW_NODE_KEY_ORDER, node);
}

/**
 * One condition, at the indent its own key established.
 *
 * `left` is a nested mapping and `right` is either one scalar or a bounded block
 * sequence, so the order is walked here rather than handed to `emitMapping`,
 * which writes scalars only. The arity is the validator's rule — `exists` takes
 * none, `in` takes a list, everything else takes one — and this function carries
 * whatever it was handed; a definition with the wrong arity is a definition the
 * catalog would have rejected before export ever saw it.
 */
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

/**
 * One connection entry. Both endpoints are structured mappings — never a dotted
 * `nodeId.portId` string, which would need a splitter and would mis-split an
 * identifier containing a dot (data-model.md §2.6).
 */
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
      case 'priority':
      case 'isDefault':
      case 'selection':
        // `emitMapping` skips an absent key, which is the omission rule for an
        // optional scalar. A present `false` is not absent and is written.
        out += emitMapping(bodyIndent, [key], connection);
        break;
    }
  }
  return out;
}

/**
 * The dependency payload. Each entry is a Pipeline document's own body, emitted by
 * the shipped emitter rather than by a second copy of that walk (FR-008), so an
 * included Pipeline and a standalone one cannot diverge.
 *
 * The declared key order is walked rather than assumed, which is what fixes
 * `pipelines` before `phases` in the bytes. The `phases` arm is deliberately
 * present and empty rather than absent, so T028's mode has to be answered here
 * instead of arriving as a key this walk silently never reaches.
 *
 * Same omission rule as an empty list: nothing to include means no `included` key,
 * because a childless one reads back as an empty mapping (research R3).
 */
function renderIncluded(included: WorkflowYamlIncluded | undefined): string {
  if (included === undefined) return '';
  let body = '';
  for (const key of WORKFLOW_INCLUDED_KEY_ORDER) {
    switch (key) {
      case 'pipelines':
        body += emitMappingSequence(
          PHASE_YAML_INDENT,
          'pipelines',
          included.pipelines,
          emitPipelineDocumentBody
        );
        break;
      case 'phases':
        // Omitted entirely in the middle mode, which is why this reads the
        // optional rather than emitting an empty sequence (research R3): a
        // childless `phases:` reads back as an empty mapping.
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

function renderSpec(indent: string, spec: WorkflowYamlSpec): string {
  let out = '';
  for (const key of WORKFLOW_SPEC_KEY_ORDER) {
    switch (key) {
      case 'nodes':
        out += emitMappingSequence(indent, 'nodes', spec.nodes, renderNode);
        break;
      case 'connections':
        out += emitMappingSequence(indent, 'connections', spec.connections, renderConnection);
        break;
      case 'startNodeIds':
        out += emitSequence(indent, 'startNodeIds', spec.startNodeIds);
        break;
    }
  }
  return out;
}

/**
 * Render a package document. The same document always renders to the same bytes,
 * and the result parses back to the same document.
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
        out += emitKey('', 'metadata');
        out += emitMapping(PHASE_YAML_INDENT, WORKFLOW_METADATA_KEY_ORDER, document.metadata);
        break;
      case 'spec':
        out += emitKey('', 'spec');
        out += renderSpec(PHASE_YAML_INDENT, document.spec);
        break;
      case 'included':
        // A references-only document has no such key — not an empty one, not a
        // null one (FR-015).
        out += renderIncluded(document.included);
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading a Workflow package back — feature 086 T034, T035 (US4)
// ---------------------------------------------------------------------------
//
// The Pipeline reader is the template, one level up. Two levels of failure, and
// the difference is what FR-023 and FR-026 turn on:
//
//   document — the envelope is not one this build reads, or the graph is not a
//              graph. Nothing is classified, so there is no partial row for a
//              plan to be built from.
//   resource — the envelope is ours and a resource inside it is malformed. It
//              names EVERY defect found in one pass (FR-028), and the other
//              resources the document declares are still classified.
//
// This reader owns the document top level, the two admitted key sets, and the
// two `included` sections. It owns nothing below them: an admitted metadata or
// spec key is handed on verbatim to `validateWorkflowDefinition`, which owns every
// pattern, length, range, enum, condition shape, and operand set — reached rather
// than restated, so the exchange format cannot come to accept a value the catalog
// would reject. The one seam is the documented rename, `id` <-> `workflowId`.
//
// What it deliberately does NOT do is check endpoints. A connection naming an
// undeclared node, and a port the referenced Pipeline does not expose, are both
// `unresolved-endpoint` from `validateWorkflowGraph`, which needs the Pipeline
// catalog — and FR-041 puts resolution after parsing. A second endpoint detector
// here could disagree with the one guarding the save gate, so there is only one,
// and it runs where the catalog is in hand.
//
// The one graph property read here is acyclicity, and it is read with the shipped
// detector (`topologicalOrder` + `stronglyConnectedComponents` from
// `workflow-graph.ts`) rather than a second one. A cycle is a DOCUMENT refusal
// rather than a resource defect because it is a property of the graph as written,
// needs no catalog to see, and makes every downstream question meaningless
// (FR-036): condition scoping is defined by ancestry, and ancestry is undefined in
// a cycle.

/** One classified resource. FR-024: the document declares it, this describes it. */
export type WorkflowPackageResource =
  | {
      readonly ok: true;
      readonly resourceKind: 'workflow';
      readonly definition: WorkflowDefinition;
    }
  | {
      readonly ok: true;
      readonly resourceKind: 'pipeline';
      readonly definition: PipelineDefinition;
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

/**
 * The refused arm carries no `resources` key at all, rather than an empty one.
 * FR-026 is that a document-level refusal produces no plan — an empty list would
 * read as "nothing was declared", which is a different and wrong statement.
 */
export type WorkflowPackageResult =
  | { readonly ok: true; readonly resources: readonly WorkflowPackageResource[] }
  | { readonly ok: false; readonly refusal: DocumentRefusal };

/** The admitted key sets are the emitter's, so reader and writer cannot drift. */
const WORKFLOW_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set<string>(
  WORKFLOW_PACKAGE_DOCUMENT_KEY_ORDER
);
const WORKFLOW_METADATA_KEYS: ReadonlySet<string> = new Set<string>(WORKFLOW_METADATA_KEY_ORDER);
const WORKFLOW_SPEC_KEYS: ReadonlySet<string> = new Set<string>(WORKFLOW_SPEC_KEY_ORDER);

function refuseWorkflowPackage(code: DocumentRefusalCode, message: string): WorkflowPackageResult {
  return { ok: false, refusal: { code, message } };
}

/**
 * The root Workflow.
 *
 * A missing or malformed `metadata` or `spec` is reported alone. Running the field
 * rules over a section that is not there would invent a defect per key it would
 * have carried, which misdescribes the document — FR-028 requires every defect
 * FOUND, not every defect derivable.
 *
 * `version` is the one field presence-checked here, because the catalog defaults an
 * absent version to 1 rather than refusing it. Defaulting is right for a catalog
 * row an operator is editing; on an imported document it would invent a version
 * the author never wrote and make the round trip lossy (FR-003a). `id` and `name`
 * are deliberately not pre-checked — absent and malformed are the same mistake for
 * them, and the catalog already says so.
 */
function classifyWorkflow(
  node: YamlMappingNode,
  includedDefects: readonly ImportDefect[]
): WorkflowPackageResource {
  const defects: ImportDefect[] = [];
  for (const entry of node.entries) {
    if (!WORKFLOW_TOP_LEVEL_KEYS.has(entry.key)) defects.push(unknownField(entry.key));
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
    // FR-026 — a bad version must not also hide which Workflow is at fault.
    const id = findScalar(metadataSection, 'id');
    if (id !== undefined && PIPELINE_ID_PATTERN.test(id.value)) resourceId = id.value;
  }
  if (specSection !== null) {
    admitSection(specSection, WORKFLOW_SPEC_KEYS, raw, defects);
  }

  if (metadataSection === null || specSection === null) {
    return { ok: false, resourceKind: 'workflow', resourceId, defects: Object.freeze(defects) };
  }

  // The legacy `id` spelling is not part of the exchange format, so the catalog's
  // ambiguity check is unreachable from here by construction rather than by
  // suppression.
  const validated = validateWorkflowDefinition(raw, { allowLegacyId: false });
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
 * FR-036 / T035 — the node ids a cycle would be found among, and the edges between
 * them, read straight from the document.
 *
 * Read raw rather than from a classified definition, because the refusal is a
 * document refusal and therefore precedes classification. Only well-formed,
 * declared endpoints contribute an edge: an endpoint naming an undeclared node is
 * `unresolved-endpoint` from the graph validator later, and inventing a node for
 * it here would report a cycle through a node that does not exist.
 */
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

  const connectionsEntry = spec.value.entries.find((entry) => entry.key === 'connections');
  const edges: WorkflowGraphEdge[] = [];
  if (connectionsEntry !== undefined && connectionsEntry.value.kind === 'sequence') {
    const endpointNodeId = (item: YamlMappingNode, side: 'from' | 'to'): string | null => {
      const endpoint = item.entries.find((entry) => entry.key === side);
      if (endpoint === undefined || endpoint.value.kind !== 'mapping') return null;
      const declared = findScalar(endpoint.value, 'nodeId');
      return declared === undefined || declared.value.length === 0 ? null : declared.value;
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

/**
 * The nodes of the first cycle a document's graph contains, or `null`.
 *
 * The detector is the shipped one (`topologicalOrder` narrows to the residual,
 * `stronglyConnectedComponents` names every member), not a second copy: the run
 * time and the import path must agree about what a cycle is, and a self-edge is a
 * cycle of one in both because that is what the shipped pair already says.
 */
function firstCycle(nodeIds: readonly string[], edges: readonly WorkflowGraphEdge[]): readonly string[] | null {
  const { residual } = topologicalOrder(nodeIds, edges);
  if (residual.length === 0) return null;
  const [component] = stronglyConnectedComponents(residual, edges);
  return component === undefined ? null : [...component].sort();
}

/**
 * Classify every resource a Workflow package declares (FR-023, FR-024).
 *
 * The gates run in a fixed order, and the order is the argument:
 *
 *   1. `apiVersion`, then `kind` — a document from a format this build does not
 *      read is reported as such, rather than as an unsupported kind that happens
 *      to be spelled in a format nobody here reads.
 *   2. a second root — an included resource declaring its own envelope is not this
 *      format (FR-003a).
 *   3. a repeated id within a section — two rows for one id would each plan a
 *      write and the last to land would win with nothing recording that it had.
 *   4. a cycle — the graph as written is not a graph (FR-036).
 *
 * Every one of them refuses the DOCUMENT, so none can produce a partial plan.
 * Classification happens only after all four pass.
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
  // An `included` mapping that declares neither section is an empty one, written
  // where FR-015 says it should have been omitted. Which sections are mandatory is
  // this reader's rule and not the shared helper's, because the three export depths
  // differ precisely in which of them they write.
  if (included.present && included.declared.size === 0) {
    includedDefects.push(
      defect(
        'included',
        'required',
        `included must declare at least one of: ${WORKFLOW_INCLUDED_KEY_ORDER.join(', ')}`
      )
    );
  }

  const pipelines = included.bySection.get('pipelines') ?? [];
  const phases = included.bySection.get('phases') ?? [];

  if (declaresSecondRoot([...pipelines, ...phases])) {
    return refuseWorkflowPackage(
      'multi-document',
      'An included resource declares its own apiVersion or kind; a package declares exactly one root'
    );
  }

  // Per section, because each is a different catalog: a Phase spelled like the
  // Pipeline that includes it is not a second claim on the Pipeline's id.
  const repeatedPipeline = firstRepeatedDeclaredId(pipelines, 'id');
  if (repeatedPipeline !== null) {
    return refuseWorkflowPackage(
      'duplicate-id',
      `Two included Pipelines declare the id '${echo(repeatedPipeline)}'; each id may be declared once`
    );
  }
  const repeatedPhase = firstRepeatedDeclaredId(phases, 'phaseId');
  if (repeatedPhase !== null) {
    return refuseWorkflowPackage(
      'duplicate-id',
      `Two included Phases declare the id '${echo(repeatedPhase)}'; each id may be declared once`
    );
  }

  const shape = readGraphShape(node);
  const cycle = firstCycle(shape.nodeIds, shape.edges);
  if (cycle !== null) {
    return refuseWorkflowPackage(
      'graph-cycle',
      `Nodes form a cycle: ${echo(cycle.join(', '))}`
    );
  }

  return {
    ok: true,
    resources: Object.freeze([
      classifyWorkflow(node, includedDefects),
      ...pipelines.map(classifyIncludedPipeline),
      ...phases.map(classifyIncludedPhase)
    ])
  };
}
