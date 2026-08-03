// Feature 085 T020 — `PipelineYamlDocument` <- `PipelineDefinition`, and bytes.
//
// Two steps kept separate on purpose. The mapping is a rename and a regrouping
// and nothing else: `pipelineId` becomes `metadata.id`, the authored body moves
// under `spec`, and every other value is carried verbatim (data-model.md §2.2,
// research R4). The emission decides bytes, and it decides them from the key
// order constants in `yaml-serializer.ts` rather than from the order in which a
// caller happened to build the object — nothing here reads `Object.keys`.
//
// Two rules make the round trip lossless, and both live in the emission step:
//
//   * An empty list is OMITTED, not written as a childless key. `inputs:` with
//     nothing under it reads back as an empty MAPPING, which would corrupt the
//     round trip in exactly the case where nothing is happening (research R3).
//     The reader reads an absent list-typed key as `[]` (data-model.md §2.5).
//   * An absent optional stays absent. Nothing is defaulted on the way out.
//
// Every scalar style decision goes through `scalar-style.ts` by way of the
// emitters, so this module cannot disagree with the reader about what is safe to
// write plain.
//
// `included` (feature 085 T025) is the operator's inclusion choice made
// concrete. A references-only document has no such key at all (FR-013) — not an
// empty one, not a null one — and an included Phase is written by the shipped
// Phase body emitter, so a packaged Phase and a standalone one are the same
// bytes at a different indent (FR-008).
//
// Feature 085 T031 adds the read direction. Two levels, and the difference is
// what FR-023 and FR-029 turn on:
//
//   document — the envelope is not one this build reads. Nothing is classified,
//              so there is no partial row for a plan to be built from.
//   resource — the envelope is ours and a resource inside it is malformed. It
//              names EVERY defect found in one pass (FR-027), and the other
//              resources the document declares are still classified.
//
// The reader owns the document top level and the two admitted key sets, and
// nothing below them. A metadata or spec key it admits is handed on verbatim to
// `validatePipelineDefinition`, which owns every pattern, length, range, and
// enum — reached rather than restated, so the exchange format cannot come to
// accept a value the catalog would reject. The one seam is the documented
// rename: the document's key is `id`, the catalog's is `pipelineId`, so a defect
// on it is mapped back to `id` (data-model.md §2.2). An included Phase is routed
// through the shipped `validatePhaseDocument`, which is what makes a packaged
// Phase and a standalone one the same resource at a different indent (FR-008).
//
// A Phase reference is a plain identifier and stays one (FR-009). A path-shaped
// reference fails the id pattern like any other malformed id; it is never
// opened, joined, or resolved as a location, and the refusal does not echo it.

import {
  PIPELINE_ID_PATTERN,
  validatePipelineDefinition
} from '../../config/pipeline-definition-validator';
import type {
  PhaseBinding,
  PipelineDefinition,
  PipelineInputPort,
  PipelineOutputPort
} from '../../contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../contracts/process-definitions';
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
  PipelineYamlDocument,
  PipelineYamlIncluded,
  PipelineYamlSpec,
  ProcessYamlResourceKind,
  YamlMappingEntry,
  YamlMappingNode,
  YamlNode,
  YamlScalarNode
} from './types';
import {
  PHASE_YAML_API_VERSION,
  PHASE_YAML_INDENT,
  PHASE_YAML_KIND,
  PIPELINE_YAML_KIND
} from './types';
import {
  BINDING_SOURCE_KEY_ORDER,
  EXECUTION_DEFAULTS_KEY_ORDER,
  INPUT_BINDING_KEY_ORDER,
  INPUT_PORT_KEY_ORDER,
  OUTPUT_BINDING_KEY_ORDER,
  OUTPUT_PORT_KEY_ORDER,
  PACKAGE_DOCUMENT_KEY_ORDER,
  PIPELINE_METADATA_KEY_ORDER,
  PIPELINE_SPEC_KEY_ORDER,
  emitKey,
  emitMapping,
  emitMappingSequence,
  emitPhaseDocumentBody,
  emitSequence
} from './yaml-serializer';

/**
 * The distinct Phases a sequence names, in first-mention order (FR-016).
 *
 * One line, but it is the single derivation site: the exporter walks it to
 * decide what to resolve and in what order to refuse, and the mapper walks it
 * again to decide what to write. Two copies of "first-mention, de-duplicated"
 * is how the refusal order and the emitted order come to disagree.
 *
 * `Set` preserves insertion order, so first mention wins and every later
 * mention of the same id collapses onto it — which is exactly FR-015's "each
 * appearing exactly once regardless of how many positions name it".
 */
export function referencedPhaseOrder(phaseIds: readonly string[]): readonly string[] {
  return [...new Set(phaseIds)];
}

/**
 * The `included` section, or `undefined` when there is nothing to include.
 *
 * Order and de-duplication are derived HERE, from `phaseIds`, rather than taken
 * from the caller's array — so a caller that resolved its Phases in some other
 * order still writes a document FR-016 admits. `phases` is a lookup, not a
 * sequence.
 *
 * A referenced id the caller did not supply is skipped rather than stubbed. The
 * exporter refuses the whole export before reaching this point when a reference
 * does not resolve (FR-017), so the gap is unreachable in the shipped path; a
 * stub would be the partial document that requirement forbids.
 */
function includedSection(
  phaseIds: readonly string[],
  phases: readonly PhaseDefinition[]
): PipelineYamlIncluded | undefined {
  const byId = new Map(phases.map((phase) => [phase.phaseId, phase]));
  const bodies: PhaseYamlDocumentBody[] = [];
  for (const phaseId of referencedPhaseOrder(phaseIds)) {
    const definition = byId.get(phaseId);
    if (definition === undefined) continue;
    // FR-008 — the same two mappings the single-Phase document defines, built
    // by the same mapper. `apiVersion` and `kind` are dropped because the
    // package already declared them, and a repeat is a second root (FR-003).
    const document = documentFromPhaseDefinition(definition);
    bodies.push({ metadata: document.metadata, spec: document.spec });
  }
  return bodies.length === 0 ? undefined : { phases: bodies };
}

/**
 * Turn a catalog definition into a portable package document.
 *
 * `includedPhases` is the operator's inclusion choice made concrete: omitted for
 * a references-only export, which produces no `included` key at all (FR-013).
 * Supplying it never changes `spec.phaseIds` — inclusion adds definitions, it
 * does not change what the Pipeline runs or in what order (FR-019).
 */
export function documentFromPipelineDefinition(
  definition: PipelineDefinition,
  includedPhases?: readonly PhaseDefinition[]
): PipelineYamlDocument {
  const spec: PipelineYamlSpec = {
    phaseIds: definition.phaseIds,
    inputs: definition.inputs,
    outputs: definition.outputs,
    bindings: definition.bindings,
    ...(definition.executionDefaults !== undefined
      ? { executionDefaults: definition.executionDefaults }
      : {}),
    recommendedNext: definition.recommendedNext
  };
  const included =
    includedPhases === undefined
      ? undefined
      : includedSection(definition.phaseIds, includedPhases);

  return {
    apiVersion: PHASE_YAML_API_VERSION,
    kind: PIPELINE_YAML_KIND,
    metadata: {
      id: definition.pipelineId,
      name: definition.name,
      version: definition.version,
      ...(definition.description !== undefined ? { description: definition.description } : {})
    },
    spec,
    ...(included !== undefined ? { included } : {})
  };
}

function renderInputPort(bodyIndent: string, port: PipelineInputPort): string {
  return emitMapping(bodyIndent, INPUT_PORT_KEY_ORDER, port);
}

function renderOutputPort(bodyIndent: string, port: PipelineOutputPort): string {
  return emitMapping(bodyIndent, OUTPUT_PORT_KEY_ORDER, port);
}

/**
 * One binding entry. An output binding is a flat mapping; an input binding's
 * `source` is a nested one, so its key order is walked here rather than handed
 * to `emitMapping`, which writes scalars only.
 */
function renderBinding(bodyIndent: string, binding: PhaseBinding): string {
  if (binding.kind === 'output') {
    return emitMapping(bodyIndent, OUTPUT_BINDING_KEY_ORDER, binding);
  }
  let out = '';
  for (const key of INPUT_BINDING_KEY_ORDER) {
    if (key === 'source') {
      out += emitKey(bodyIndent, 'source');
      out += emitMapping(
        `${bodyIndent}${PHASE_YAML_INDENT}`,
        BINDING_SOURCE_KEY_ORDER,
        binding.source
      );
      continue;
    }
    out += emitMapping(bodyIndent, [key], binding);
  }
  return out;
}

/**
 * `executionDefaults` follows the same omission rule as an empty list: a mapping
 * whose every field is absent has nothing to write, and a bare
 * `executionDefaults:` would read back as an empty mapping rather than as the
 * absence it represents.
 */
function renderExecutionDefaults(indent: string, spec: PipelineYamlSpec): string {
  if (spec.executionDefaults === undefined) return '';
  const body = emitMapping(
    `${indent}${PHASE_YAML_INDENT}`,
    EXECUTION_DEFAULTS_KEY_ORDER,
    spec.executionDefaults
  );
  if (body.length === 0) return '';
  return emitKey(indent, 'executionDefaults') + body;
}

/**
 * The dependency payload. Each entry is a Phase document's own body, emitted by
 * the shipped emitter rather than by a second copy of that walk (FR-008), so an
 * included Phase and a standalone one cannot diverge.
 *
 * The same omission rule as an empty list and an empty `executionDefaults`: no
 * phases means no `included` key, because a childless one reads back as an
 * empty mapping (research R3).
 */
function renderIncluded(included: PipelineYamlIncluded | undefined): string {
  if (included === undefined) return '';
  const body = emitMappingSequence(
    PHASE_YAML_INDENT,
    'phases',
    included.phases,
    emitPhaseDocumentBody
  );
  if (body.length === 0) return '';
  return emitKey('', 'included') + body;
}

function renderSpec(indent: string, spec: PipelineYamlSpec): string {
  let out = '';
  for (const key of PIPELINE_SPEC_KEY_ORDER) {
    switch (key) {
      case 'phaseIds':
        out += emitSequence(indent, 'phaseIds', spec.phaseIds);
        break;
      case 'inputs':
        out += emitMappingSequence(indent, 'inputs', spec.inputs, renderInputPort);
        break;
      case 'outputs':
        out += emitMappingSequence(indent, 'outputs', spec.outputs, renderOutputPort);
        break;
      case 'bindings':
        out += emitMappingSequence(indent, 'bindings', spec.bindings, renderBinding);
        break;
      case 'executionDefaults':
        out += renderExecutionDefaults(indent, spec);
        break;
      case 'recommendedNext':
        out += emitSequence(indent, 'recommendedNext', spec.recommendedNext);
        break;
    }
  }
  return out;
}

/**
 * Render a package document. The same document always renders to the same bytes
 * (FR-017), and the result parses back to the same document.
 */
export function serializePipelineDocument(document: PipelineYamlDocument): string {
  let out = '';
  for (const key of PACKAGE_DOCUMENT_KEY_ORDER) {
    switch (key) {
      case 'apiVersion':
      case 'kind':
        out += emitMapping('', [key], document);
        break;
      case 'metadata':
        out += emitKey('', 'metadata');
        out += emitMapping(PHASE_YAML_INDENT, PIPELINE_METADATA_KEY_ORDER, document.metadata);
        break;
      case 'spec':
        out += emitKey('', 'spec');
        out += renderSpec(PHASE_YAML_INDENT, document.spec);
        break;
      case 'included':
        // A references-only document has no such key — not an empty one, not a
        // null one (FR-013).
        out += renderIncluded(document.included);
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading a package back — feature 085 T031 (US3)
// ---------------------------------------------------------------------------

/** The admitted key sets are the emitter's, so reader and writer cannot drift. */
const PACKAGE_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set<string>(PACKAGE_DOCUMENT_KEY_ORDER);
const PIPELINE_METADATA_KEYS: ReadonlySet<string> = new Set<string>(PIPELINE_METADATA_KEY_ORDER);
const PIPELINE_SPEC_KEYS: ReadonlySet<string> = new Set<string>(PIPELINE_SPEC_KEY_ORDER);

const INTEGER_PATTERN = /^[-+]?\d+$/;

/** How much of an author-supplied value a refusal may quote back. */
const ECHO_MAX = 64;

/** One classified resource. FR-024: the document declares it, this describes it. */
export type PipelinePackageResource =
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
 * FR-029 is that a document-level refusal produces no plan — an empty list would
 * read as "nothing was declared", which is a different and wrong statement.
 */
export type PipelinePackageResult =
  | { readonly ok: true; readonly resources: readonly PipelinePackageResource[] }
  | { readonly ok: false; readonly refusal: DocumentRefusal };

function echo(value: string): string {
  return value.length <= ECHO_MAX ? value : value.slice(0, ECHO_MAX);
}

function refuse(code: DocumentRefusalCode, message: string): PipelinePackageResult {
  return { ok: false, refusal: { code, message } };
}

function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * A scalar's value as the catalog validator will see it.
 *
 * A quoted scalar is text by the author's own hand and stays text; an unquoted
 * one becomes an integer or a boolean when it reads as one. That split is not a
 * guess — `chooseScalarStyle` quotes exactly the scalars whose unquoted form
 * another reader would re-type, so a document this project wrote round-trips to
 * the values it started from. A float deliberately does not coerce: it reaches
 * the catalog as text and is refused there, rather than being silently rounded.
 */
function scalarValue(node: YamlScalarNode): string | number | boolean {
  if (node.quoted) return node.value;
  if (INTEGER_PATTERN.test(node.value)) {
    const parsed = Number(node.value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (node.value === 'true') return true;
  if (node.value === 'false') return false;
  return node.value;
}

/**
 * A node as a plain value.
 *
 * Every synthesized mapping is prototype-less. A mapping below the admitted key
 * sets — a port, a binding, `executionDefaults` — is forwarded wholesale to the
 * catalog validator, so a `__proto__` key in a document the operator did not
 * write would otherwise set a prototype instead of an own property and escape
 * both the unknown-field scan and `Object.keys`. First entry wins on a duplicate
 * key, which is the rule `findScalar` already follows.
 */
function plainValue(node: YamlNode): unknown {
  if (node.kind === 'scalar') return scalarValue(node);
  if (node.kind === 'sequence') return node.items.map(plainValue);
  const mapping = Object.create(null) as Record<string, unknown>;
  for (const entry of node.entries) {
    if (hasOwn(mapping, entry.key)) continue;
    mapping[entry.key] = plainValue(entry.value);
  }
  return mapping;
}

interface IncludedSectionRead {
  readonly items: readonly YamlNode[];
  readonly defects: readonly ImportDefect[];
}

/**
 * The `included` section, read once.
 *
 * Once, because the items feed two things that must agree: the second-root gate,
 * which runs before anything is classified, and the per-Phase classification
 * after it. Its structural defects belong to the root Pipeline — there is no
 * other resource to own them, and ignoring a malformed `included` would quietly
 * drop resources the document declared.
 */
function readIncluded(node: YamlMappingNode): IncludedSectionRead {
  const entry = node.entries.find((candidate) => candidate.key === 'included');
  if (entry === undefined) return { items: [], defects: [] };

  const defects: ImportDefect[] = [];
  if (entry.value.kind !== 'mapping') {
    defects.push(defect('included', 'mapping-required', 'included must be a mapping'));
    return { items: [], defects };
  }
  for (const child of entry.value.entries) {
    if (child.key !== 'phases') defects.push(unknownField(`included.${child.key}`));
  }
  const phases = entry.value.entries.find((candidate) => candidate.key === 'phases');
  if (phases === undefined) {
    defects.push(defect('included.phases', 'required', 'included.phases is required'));
    return { items: [], defects };
  }
  if (phases.value.kind !== 'sequence') {
    defects.push(
      defect('included.phases', 'sequence-required', 'included.phases must be a sequence')
    );
    return { items: [], defects };
  }
  return { items: phases.value.items, defects };
}

/**
 * FR-003a — a package has exactly one root. An included Phase that repeats
 * `apiVersion` or `kind` is a second one, and the whole document is refused
 * before any resource is classified so FR-029 holds.
 */
function declaresSecondRoot(items: readonly YamlNode[]): boolean {
  return items.some(
    (item) =>
      item.kind === 'mapping' &&
      item.entries.some((entry) => entry.key === 'apiVersion' || entry.key === 'kind')
  );
}

/**
 * The id an included Phase DECLARES, before anyone asks whether it is a good one.
 *
 * Read raw rather than taken from classification, because the check it feeds runs
 * before any resource is classified (FR-029) and because a malformed resource
 * still declared something. `classifyIncludedPhase` reports `resourceId: null` for
 * an id that fails the pattern — correct there, since a malformed row claims no id
 * for dependency resolution (FR-032) — but reusing that answer here would let a
 * well-formed resource silently win over a broken twin, which is exactly the
 * outcome FR-031 excludes.
 *
 * An absent or empty declaration is not a claim: two resources that name no id are
 * not two claims on one id, and each reports its own defect.
 */
function declaredPhaseId(item: YamlNode): string | null {
  if (item.kind !== 'mapping') return null;
  const metadata = item.entries.find((entry) => entry.key === 'metadata');
  if (metadata === undefined || metadata.value.kind !== 'mapping') return null;
  const declared = findScalar(metadata.value, 'phaseId');
  if (declared === undefined || declared.value.length === 0) return null;
  return declared.value;
}

/**
 * FR-031 — the first id two included resources both claim, or `null`.
 *
 * Ids are compared within `included.phases` only. The root Pipeline lives in a
 * different catalog, so a Phase spelled like the Pipeline is not a second claim on
 * the Pipeline's id, and a package declares exactly one root by construction —
 * `declaresSecondRoot` has already refused anything else.
 */
function firstRepeatedPhaseId(items: readonly YamlNode[]): string | null {
  const seen = new Set<string>();
  for (const item of items) {
    const declared = declaredPhaseId(item);
    if (declared === null) continue;
    if (seen.has(declared)) return declared;
    seen.add(declared);
  }
  return null;
}

/**
 * An included Phase as the standalone document it is the body of.
 *
 * The package declared `apiVersion` and `kind` once, for every resource in it
 * (FR-003). Putting them back on each Phase is what lets the shipped Phase
 * reader do the work: the defects and the id an included Phase gets are the ones
 * a standalone Phase document would have got, produced by the same rules rather
 * than by a second copy of them (FR-008).
 */
function standalonePhaseNode(item: YamlMappingNode): YamlMappingNode {
  const declare = (key: string, value: string): YamlMappingEntry => ({
    key,
    value: { kind: 'scalar', value, quoted: false, line: item.line },
    line: item.line
  });
  return {
    kind: 'mapping',
    line: item.line,
    entries: [
      declare('apiVersion', PHASE_YAML_API_VERSION),
      declare('kind', PHASE_YAML_KIND),
      ...item.entries
    ]
  };
}

function classifyIncludedPhase(item: YamlNode): PipelinePackageResource {
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

  const result = validatePhaseDocument(standalonePhaseNode(item));
  if (result.ok) return { ok: true, resourceKind: 'phase', document: result.document };
  if (result.kind === 'document') {
    // Unreachable while this reader supplies the envelope itself, and reported
    // as a resource defect rather than escalated: one malformed included Phase
    // must not take the rest of the document's resources with it (FR-024).
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

/**
 * Collect the admitted keys of one section into the raw object the catalog
 * validator reads, reporting anything the closed format does not admit.
 */
function admitSection(
  section: YamlMappingNode,
  admitted: ReadonlySet<string>,
  raw: Record<string, unknown>,
  defects: ImportDefect[],
  rename?: Readonly<Record<string, string>>
): void {
  for (const entry of section.entries) {
    if (!admitted.has(entry.key)) {
      defects.push(unknownField(entry.key));
      continue;
    }
    const key = rename?.[entry.key] ?? entry.key;
    if (hasOwn(raw, key)) continue;
    raw[key] = plainValue(entry.value);
  }
}

/**
 * The root Pipeline.
 *
 * A missing or malformed `metadata` or `spec` is reported alone. Running the
 * field rules over a section that is not there would invent a defect per key it
 * would have carried, which misdescribes the document — FR-027 requires every
 * defect FOUND, not every defect derivable.
 *
 * `version` is the one field presence-checked here, because the catalog defaults
 * an absent version to 1 rather than refusing it. Defaulting is right for a
 * catalog row an operator is editing; on an imported document it would invent a
 * version the author never wrote and make the round trip lossy. `id` and `name`
 * are deliberately not pre-checked — absent and malformed are the same mistake
 * for them, and the catalog already says so.
 */
function classifyPipeline(
  node: YamlMappingNode,
  includedDefects: readonly ImportDefect[]
): PipelinePackageResource {
  const defects: ImportDefect[] = [];
  for (const entry of node.entries) {
    if (!PACKAGE_TOP_LEVEL_KEYS.has(entry.key)) defects.push(unknownField(entry.key));
  }
  defects.push(...includedDefects);

  const metadataSection = readSection(node, 'metadata', defects);
  const specSection = readSection(node, 'spec', defects);

  const raw = Object.create(null) as Record<string, unknown>;
  let resourceId: string | null = null;

  if (metadataSection !== null) {
    admitSection(metadataSection, PIPELINE_METADATA_KEYS, raw, defects, { id: 'pipelineId' });
    if (!hasOwn(raw, 'version')) {
      defects.push(defect('version', 'required', 'version is required'));
    }
    // FR-026 — a bad version must not also hide which Pipeline is at fault.
    const id = findScalar(metadataSection, 'id');
    if (id !== undefined && PIPELINE_ID_PATTERN.test(id.value)) resourceId = id.value;
  }
  if (specSection !== null) {
    admitSection(specSection, PIPELINE_SPEC_KEYS, raw, defects);
  }

  if (metadataSection === null || specSection === null) {
    return { ok: false, resourceKind: 'pipeline', resourceId, defects: Object.freeze(defects) };
  }

  // The legacy `id` and `phases` spellings are not part of the exchange format,
  // so the catalog's ambiguity checks are unreachable from here by construction
  // rather than by suppression.
  const validated = validatePipelineDefinition(raw, { allowLegacyId: false });
  for (const error of validated.errors) {
    defects.push(
      defect(error.field === 'pipelineId' ? 'id' : error.field, error.code, error.message)
    );
  }

  if (defects.length > 0 || validated.definition === null) {
    return { ok: false, resourceKind: 'pipeline', resourceId, defects: Object.freeze(defects) };
  }
  return { ok: true, resourceKind: 'pipeline', definition: validated.definition };
}

/**
 * Classify every resource a package document declares (FR-023, FR-024).
 *
 * The version gate runs before the kind gate, so a document from a format this
 * build does not know is reported as such rather than as an unsupported kind
 * that happens to be spelled in a format nobody here reads.
 */
export function parsePipelinePackage(node: YamlMappingNode): PipelinePackageResult {
  const apiVersion = findScalar(node, 'apiVersion');
  if (apiVersion === undefined) {
    return refuse('unsupported-version', 'Document does not declare apiVersion');
  }
  if (apiVersion.value !== PHASE_YAML_API_VERSION) {
    return refuse(
      'unsupported-version',
      `Unsupported apiVersion '${echo(apiVersion.value)}'; this build reads ${PHASE_YAML_API_VERSION}`
    );
  }
  const kind = findScalar(node, 'kind');
  if (kind === undefined) {
    return refuse('unsupported-kind', 'Document does not declare kind');
  }
  if (kind.value !== PIPELINE_YAML_KIND) {
    return refuse(
      'unsupported-kind',
      `Unsupported kind '${echo(kind.value)}'; expected ${PIPELINE_YAML_KIND}`
    );
  }

  const included = readIncluded(node);
  if (declaresSecondRoot(included.items)) {
    return refuse(
      'multi-document',
      'An included Phase declares its own apiVersion or kind; a package declares exactly one root'
    );
  }

  // FR-031 — before classification, so the refusal produces no partial plan. A
  // plan is one row per declared resource keyed by id, and the presence oracle is
  // asked per row against the STORED catalog, never against the document's other
  // rows; two rows for one id would each plan a write and the last one to land
  // would win with nothing recording that it had.
  const repeated = firstRepeatedPhaseId(included.items);
  if (repeated !== null) {
    return refuse(
      'duplicate-id',
      `Two included Phases declare the id '${echo(repeated)}'; each id may be declared once`
    );
  }

  return {
    ok: true,
    resources: Object.freeze([
      classifyPipeline(node, included.defects),
      ...included.items.map(classifyIncludedPhase)
    ])
  };
}
