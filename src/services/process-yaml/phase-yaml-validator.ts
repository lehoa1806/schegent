// Feature 084 T016 — the closed-format validator.
//
// Two refusal levels, and the distinction is the point (FR-027):
//
//   document — `apiVersion` or `kind` is absent or unsupported. The file is
//              not a thing this build knows how to read, so no plan row is
//              produced for it at all.
//   resource — the envelope is ours but the resource inside is malformed.
//              Every defect is collected in one pass (FR-026) so an operator
//              fixing a document sees the whole list rather than peeling it
//              one error per attempt.
//
// Two properties are structural rather than remembered:
//
//   * The admitted key sets are the emitter's key-order constants. A field
//     added to the format is admitted by the reader and the writer at the same
//     moment, and a field NOT in those lists — `promptVersion`, `sourceScope` —
//     is refused by the closed-format rule without a denial list to maintain
//     (FR-001, FR-009). Feature 098 admitted `sideEffects` and `evidencePolicy`
//     by the single `SPEC_KEY_ORDER` edit that property describes; the two that
//     remain refused are host-resolved state, not authored fields, which is why
//     they are named here rather than merely omitted.
//   * Every length, pattern and range is imported from the catalog validator,
//     so the format cannot drift from the values the catalog already accepts
//     (FR-008).
//
// What this module deliberately does NOT do: parse `retryCondition`. It is
// carried as inert text in both directions (FR-012); the DSL is evaluated by
// the existing save path at commit time, unchanged.
//
// Errors are values. Nothing here throws.

import {
  PHASE_DESCRIPTION_MAX_LEN,
  PHASE_ID_PATTERN,
  PHASE_INSTRUCTION_MAX_LEN,
  PHASE_NAME_MAX_LEN,
  PHASE_SKILL_MAX_LEN,
  PHASE_TIMEOUT_MAX,
  PHASE_TIMEOUT_MIN
} from '../../config/process-definition-validator';
import {
  PHASE_EFFORT_LEVELS,
  PHASE_EVIDENCE_POLICIES,
  PHASE_SIDE_EFFECTS,
  type PhaseDefinitionEffort,
  type PhaseEvidencePolicy,
  type PhaseSideEffects
} from '../../contracts/process-definitions';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../runner/backend-runner-factory';
import {
  PHASE_YAML_API_VERSION,
  PHASE_YAML_KIND,
  type DocumentRefusal,
  type DocumentRefusalCode,
  type ImportDefect,
  type PhaseYamlDocument,
  type PhaseYamlMetadata,
  type PhaseYamlSpec,
  type YamlMappingNode,
  type YamlScalarNode
} from './types';
import { DOCUMENT_KEY_ORDER, METADATA_KEY_ORDER, SPEC_KEY_ORDER } from './yaml-serializer';

/**
 * How long a defect's field path may be.
 *
 * Bounded because part of a field path can be author-supplied — an unknown key
 * from a document nobody here wrote is quoted back as the field it was found at,
 * and an unbounded one is a wall of text in the plan table.
 *
 * Widened from 32 to 48 by feature 086. The format's own deepest path,
 * `connections[0].condition.left.source`, is 36 characters, so 32 handed the
 * operator `connections[0].condition.left.so` and no way to find the field. The
 * catalog-side validator already chose 48 for exactly this shape
 * (`WORKFLOW_ERROR_FIELD_MAX` in `workflow-definition-validator.ts`), which left
 * the exchange reader as the narrower of two caps on the one kind with the
 * deepest paths. Exported so a test asserts against the constant rather than a
 * number written twice, since that is how the two came to disagree.
 */
export const DEFECT_FIELD_MAX = 48;
const DEFECT_CODE_MAX = 64;
const DEFECT_MESSAGE_MAX = 512;
/** How much of an author-supplied value a refusal may quote back. */
const ECHO_MAX = 64;

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set<string>(DOCUMENT_KEY_ORDER);
const METADATA_KEYS: ReadonlySet<string> = new Set<string>(METADATA_KEY_ORDER);
const SPEC_KEYS: ReadonlySet<string> = new Set<string>(SPEC_KEY_ORDER);

const INTEGER_PATTERN = /^[-+]?\d+$/;

export interface PhaseYamlValidationOk {
  readonly ok: true;
  readonly document: PhaseYamlDocument;
}

export interface PhaseYamlDocumentRefusal {
  readonly ok: false;
  readonly kind: 'document';
  readonly refusal: DocumentRefusal;
}

export interface PhaseYamlResourceRefusal {
  readonly ok: false;
  readonly kind: 'resource';
  /** `null` when the document did not carry a readable, well-formed id. */
  readonly resourceId: string | null;
  readonly defects: readonly ImportDefect[];
}

export type PhaseYamlValidationResult =
  | PhaseYamlValidationOk
  | PhaseYamlDocumentRefusal
  | PhaseYamlResourceRefusal;

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * One bounded defect. Exported because feature 085's package reader classifies
 * resources of two kinds and must produce defects the operator sees beside these
 * ones; a second copy of the three caps is a second thing to keep in step.
 */
export function defect(field: string, code: string, message: string): ImportDefect {
  return Object.freeze({
    field: bounded(field, DEFECT_FIELD_MAX),
    code: bounded(code, DEFECT_CODE_MAX),
    message: bounded(message, DEFECT_MESSAGE_MAX)
  });
}

function refuseDocument(code: DocumentRefusalCode, message: string): PhaseYamlDocumentRefusal {
  return {
    ok: false,
    kind: 'document',
    refusal: { code, message: bounded(message, DEFECT_MESSAGE_MAX) }
  };
}

/** Exported for the package reader, so both kinds report a stray key identically. */
export function unknownField(key: string): ImportDefect {
  return defect(key, 'unknown-field', `Unknown field '${bounded(key, DEFECT_FIELD_MAX)}'`);
}

/** First entry wins on a duplicate key; the package reader agrees with this. */
export function findScalar(node: YamlMappingNode, key: string): YamlScalarNode | undefined {
  const entry = node.entries.find((candidate) => candidate.key === key);
  return entry !== undefined && entry.value.kind === 'scalar' ? entry.value : undefined;
}

function hasKey(node: YamlMappingNode, key: string): boolean {
  return node.entries.some((candidate) => candidate.key === key);
}

/** A scalar the format requires. Absent and wrong-shaped are different mistakes. */
function requireScalar(
  node: YamlMappingNode,
  key: string,
  defects: ImportDefect[]
): YamlScalarNode | null {
  const scalar = findScalar(node, key);
  if (scalar !== undefined) return scalar;
  if (hasKey(node, key)) {
    defects.push(defect(key, 'scalar-required', `${key} must be a single value`));
  } else {
    defects.push(defect(key, 'required', `${key} is required`));
  }
  return null;
}

/** A scalar the format allows. Returns undefined when absent or wrong-shaped. */
function optionalScalar(
  node: YamlMappingNode,
  key: string,
  defects: ImportDefect[]
): YamlScalarNode | undefined {
  const scalar = findScalar(node, key);
  if (scalar !== undefined) return scalar;
  if (hasKey(node, key)) {
    defects.push(defect(key, 'scalar-required', `${key} must be a single value`));
  }
  return undefined;
}

/**
 * Read an integer. A quoted scalar is text by the author's own hand and never
 * satisfies a numeric field — that is what the `quoted` flag is carried for.
 */
function readInteger(scalar: YamlScalarNode): number | null {
  if (scalar.quoted || !INTEGER_PATTERN.test(scalar.value)) return null;
  const parsed = Number(scalar.value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readBoolean(scalar: YamlScalarNode): boolean | null {
  if (scalar.quoted) return null;
  if (scalar.value === 'true') return true;
  if (scalar.value === 'false') return false;
  return null;
}

/**
 * A required mapping section. Returning null rather than throwing is what lets a
 * caller report the structural defect alone instead of inventing a field defect
 * for every key the missing section would have carried.
 */
export function readSection(
  node: YamlMappingNode,
  key: string,
  defects: ImportDefect[]
): YamlMappingNode | null {
  const entry = node.entries.find((candidate) => candidate.key === key);
  if (entry === undefined) {
    defects.push(defect(key, 'required', `${key} is required`));
    return null;
  }
  if (entry.value.kind !== 'mapping') {
    defects.push(defect(key, 'mapping-required', `${key} must be a mapping`));
    return null;
  }
  return entry.value;
}

function validateMetadata(
  section: YamlMappingNode,
  defects: ImportDefect[]
): PhaseYamlMetadata | null {
  const before = defects.length;
  for (const entry of section.entries) {
    if (!METADATA_KEYS.has(entry.key)) defects.push(unknownField(entry.key));
  }

  let phaseId = '';
  const phaseIdNode = requireScalar(section, 'phaseId', defects);
  if (phaseIdNode !== null) {
    phaseId = phaseIdNode.value.trim();
    if (!PHASE_ID_PATTERN.test(phaseId)) {
      defects.push(
        defect('phaseId', 'invalid-pattern', `Phase id must match ${PHASE_ID_PATTERN.source}`)
      );
    }
  }

  let name = '';
  const nameNode = requireScalar(section, 'name', defects);
  if (nameNode !== null) {
    name = nameNode.value.trim();
    if (name.length === 0 || name.length > PHASE_NAME_MAX_LEN) {
      defects.push(
        defect(
          'name',
          'invalid-length',
          `Phase name must contain 1 to ${PHASE_NAME_MAX_LEN} characters`
        )
      );
    }
  }

  let version = 0;
  const versionNode = requireScalar(section, 'version', defects);
  if (versionNode !== null) {
    const parsed = readInteger(versionNode);
    if (parsed === null || parsed < 1) {
      defects.push(
        defect('version', 'positive-integer-required', 'Phase version must be a positive integer')
      );
    } else {
      version = parsed;
    }
  }

  let description: string | undefined;
  const descriptionNode = optionalScalar(section, 'description', defects);
  if (descriptionNode !== undefined) {
    if (descriptionNode.value.length > PHASE_DESCRIPTION_MAX_LEN) {
      defects.push(
        defect(
          'description',
          'invalid-length',
          `Phase description must be at most ${PHASE_DESCRIPTION_MAX_LEN} characters`
        )
      );
    } else {
      description = descriptionNode.value;
    }
  }

  if (defects.length !== before) return null;
  return { phaseId, name, version, ...(description !== undefined ? { description } : {}) };
}

function validateSpec(section: YamlMappingNode, defects: ImportDefect[]): PhaseYamlSpec | null {
  const before = defects.length;
  for (const entry of section.entries) {
    if (!SPEC_KEYS.has(entry.key)) defects.push(unknownField(entry.key));
  }

  const instruction = optionalScalar(section, 'instruction', defects)?.value;
  const skill = optionalScalar(section, 'skill', defects)?.value.trim();
  const hasInstruction = instruction !== undefined && instruction.trim().length > 0;
  const hasSkill = skill !== undefined && skill.length > 0;
  if (hasInstruction === hasSkill) {
    defects.push(
      defect('directive', 'exactly-one-required', 'Provide exactly one of instruction or skill')
    );
  }
  if (instruction !== undefined && (!hasInstruction || instruction.length > PHASE_INSTRUCTION_MAX_LEN)) {
    defects.push(
      defect(
        'instruction',
        'invalid-length',
        `Phase instruction must contain 1 to ${PHASE_INSTRUCTION_MAX_LEN} characters`
      )
    );
  }
  if (skill !== undefined && (!hasSkill || skill.length > PHASE_SKILL_MAX_LEN)) {
    defects.push(
      defect(
        'skill',
        'invalid-length',
        `Phase skill must contain 1 to ${PHASE_SKILL_MAX_LEN} characters`
      )
    );
  }

  let runner: BackendRunnerKind | undefined;
  const runnerNode = optionalScalar(section, 'runner', defects);
  if (runnerNode !== undefined) {
    if (!(SUPPORTED_BACKENDS as readonly string[]).includes(runnerNode.value)) {
      defects.push(
        defect(
          'runner',
          'invalid-enum',
          `Phase runner must be one of ${SUPPORTED_BACKENDS.join(', ')}`
        )
      );
    } else {
      runner = runnerNode.value as BackendRunnerKind;
    }
  }

  // Feature 098 — membership against the catalog's own enums, in the shape
  // `runner` above already uses. The values are value-imported from
  // `contracts/process-definitions` rather than written out, so the format cannot
  // admit a class the catalog would then reject (FR-001, FR-002). No new bound is
  // introduced: the refusal names the field and lists the legal values, and never
  // echoes the author's own text, so `ECHO_MAX` has nothing to cap here.
  let sideEffects: PhaseSideEffects | undefined;
  const sideEffectsNode = optionalScalar(section, 'sideEffects', defects);
  if (sideEffectsNode !== undefined) {
    if (!(PHASE_SIDE_EFFECTS as readonly string[]).includes(sideEffectsNode.value)) {
      defects.push(
        defect(
          'sideEffects',
          'invalid-enum',
          `Phase sideEffects must be one of ${PHASE_SIDE_EFFECTS.join(', ')}`
        )
      );
    } else {
      sideEffects = sideEffectsNode.value as PhaseSideEffects;
    }
  }

  let evidencePolicy: PhaseEvidencePolicy | undefined;
  const evidencePolicyNode = optionalScalar(section, 'evidencePolicy', defects);
  if (evidencePolicyNode !== undefined) {
    if (!(PHASE_EVIDENCE_POLICIES as readonly string[]).includes(evidencePolicyNode.value)) {
      defects.push(
        defect(
          'evidencePolicy',
          'invalid-enum',
          `Phase evidencePolicy must be one of ${PHASE_EVIDENCE_POLICIES.join(', ')}`
        )
      );
    } else {
      evidencePolicy = evidencePolicyNode.value as PhaseEvidencePolicy;
    }
  }

  let model: string | undefined;
  const modelNode = optionalScalar(section, 'model', defects);
  if (modelNode !== undefined) {
    if (modelNode.value.trim().length === 0) {
      defects.push(defect('model', 'non-empty-required', 'Phase model must be non-empty'));
    } else {
      model = modelNode.value.trim();
    }
  }

  let effort: PhaseDefinitionEffort | undefined;
  const effortNode = optionalScalar(section, 'effort', defects);
  if (effortNode !== undefined) {
    if (!(PHASE_EFFORT_LEVELS as readonly string[]).includes(effortNode.value)) {
      defects.push(
        defect(
          'effort',
          'invalid-enum',
          `Phase effort must be one of ${PHASE_EFFORT_LEVELS.join(', ')}`
        )
      );
    } else {
      effort = effortNode.value as PhaseDefinitionEffort;
    }
  }

  // The catalog's own cross-field rule. Checked here so preflight can say the
  // resource is invalid rather than letting the commit fail later (FR-021).
  if (runner === 'agy' && (effort === 'xhigh' || effort === 'max')) {
    defects.push(defect('effort', 'runner-incompatible', 'Agy supports low, medium, or high effort'));
  }

  let timeoutSeconds: number | undefined;
  const timeoutNode = optionalScalar(section, 'timeoutSeconds', defects);
  if (timeoutNode !== undefined) {
    const parsed = readInteger(timeoutNode);
    if (parsed === null || parsed < PHASE_TIMEOUT_MIN || parsed > PHASE_TIMEOUT_MAX) {
      defects.push(
        defect(
          'timeoutSeconds',
          'invalid-range',
          `Phase timeoutSeconds must be an integer from ${PHASE_TIMEOUT_MIN} to ${PHASE_TIMEOUT_MAX}`
        )
      );
    } else {
      timeoutSeconds = parsed;
    }
  }

  const loopable = readOptionalBoolean(section, 'loopable', defects);
  const isRequired = readOptionalBoolean(section, 'isRequired', defects);
  const forceContinueOnRetryCap = readOptionalBoolean(
    section,
    'forceContinueOnRetryCap',
    defects
  );

  let retryCondition: string | undefined;
  const retryNode = optionalScalar(section, 'retryCondition', defects);
  if (retryNode !== undefined) {
    if (retryNode.value.trim().length === 0) {
      defects.push(
        defect('retryCondition', 'non-empty-required', 'Phase retryCondition must be non-empty')
      );
    } else {
      // Carried verbatim. Never parsed, normalized, or rewritten here (FR-012).
      retryCondition = retryNode.value;
    }
  }

  if (defects.length !== before) return null;

  const common = {
    ...(runner !== undefined ? { runner } : {}),
    ...(sideEffects !== undefined ? { sideEffects } : {}),
    ...(evidencePolicy !== undefined ? { evidencePolicy } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(loopable !== undefined ? { loopable } : {}),
    ...(isRequired !== undefined ? { isRequired } : {}),
    ...(forceContinueOnRetryCap !== undefined ? { forceContinueOnRetryCap } : {}),
    ...(retryCondition !== undefined ? { retryCondition } : {})
  };
  return hasInstruction
    ? { instruction: instruction as string, ...common }
    : { skill: skill as string, ...common };
}

function readOptionalBoolean(
  section: YamlMappingNode,
  key: string,
  defects: ImportDefect[]
): boolean | undefined {
  const node = optionalScalar(section, key, defects);
  if (node === undefined) return undefined;
  const parsed = readBoolean(node);
  if (parsed === null) {
    defects.push(defect(key, 'boolean-required', `Phase ${key} must be true or false`));
    return undefined;
  }
  return parsed;
}

/**
 * The id an invalid resource reports, read independently of whether the rest of
 * `metadata` validated.
 *
 * `validateMetadata` returns null on ANY metadata defect, so reading the id off
 * its result would drop a perfectly readable `phaseId` because some *other*
 * field — a version, a name length — was wrong. Feature 085 makes that visible:
 * a package names several resources, and an invalid row with no id is the
 * difference between "this Phase is wrong" and "something in this file is
 * wrong". The pattern test is what keeps the documented contract honest — an id
 * that is not well-formed still reports `null`, so a malformed id is never
 * echoed back as though it were one.
 */
function readableResourceId(section: YamlMappingNode | null): string | null {
  if (section === null) return null;
  const node = findScalar(section, 'phaseId');
  if (node === undefined) return null;
  const phaseId = node.value.trim();
  return PHASE_ID_PATTERN.test(phaseId) ? phaseId : null;
}

/**
 * Validate one parsed document against the closed format.
 *
 * The version and kind gates run first and in that order: a document from a
 * format this build does not know is reported as such rather than as a pile of
 * field defects that would misdescribe it.
 */
export function validatePhaseDocument(node: YamlMappingNode): PhaseYamlValidationResult {
  const apiVersion = findScalar(node, 'apiVersion');
  if (apiVersion === undefined) {
    return refuseDocument('unsupported-version', 'Document does not declare apiVersion');
  }
  if (apiVersion.value !== PHASE_YAML_API_VERSION) {
    return refuseDocument(
      'unsupported-version',
      `Unsupported apiVersion '${bounded(apiVersion.value, ECHO_MAX)}'; this build reads ${PHASE_YAML_API_VERSION}`
    );
  }
  const kind = findScalar(node, 'kind');
  if (kind === undefined) {
    return refuseDocument('unsupported-kind', 'Document does not declare kind');
  }
  if (kind.value !== PHASE_YAML_KIND) {
    return refuseDocument(
      'unsupported-kind',
      `Unsupported kind '${bounded(kind.value, ECHO_MAX)}'; expected ${PHASE_YAML_KIND}`
    );
  }

  const defects: ImportDefect[] = [];
  for (const entry of node.entries) {
    if (!TOP_LEVEL_KEYS.has(entry.key)) defects.push(unknownField(entry.key));
  }

  const metadataSection = readSection(node, 'metadata', defects);
  const specSection = readSection(node, 'spec', defects);
  const metadata = metadataSection === null ? null : validateMetadata(metadataSection, defects);
  const spec = specSection === null ? null : validateSpec(specSection, defects);

  if (metadata === null || spec === null || defects.length > 0) {
    return {
      ok: false,
      kind: 'resource',
      resourceId: readableResourceId(metadataSection),
      defects: Object.freeze(defects)
    };
  }

  return {
    ok: true,
    document: {
      apiVersion: PHASE_YAML_API_VERSION,
      kind: PHASE_YAML_KIND,
      metadata,
      spec
    }
  };
}
