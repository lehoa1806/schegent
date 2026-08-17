// Feature 084 T019 — `PhaseYamlDocument` <-> `PhaseDefinition`.
//
// The mapping is a rename and a regrouping, nothing more: identity fields move
// under `metadata`, behavior fields under `spec`, and every value is carried
// verbatim (data-model "Field mapping"). In particular:
//
//   * An absent optional stays absent. Nothing is defaulted on the way out or
//     filled in on the way back (FR-016).
//   * `retryCondition` is inert text. This module does not import the DSL in
//     either direction, so it cannot normalize or reject an expression the
//     catalog would have accepted (FR-012).
//   * Host-resolved fields — `sideEffects`, `evidencePolicy`, `promptVersion`,
//     `sourceScope` — have no place to go, because the document type has no key
//     for them (FR-009).

import type { PhaseDefinition } from '../../contracts/process-definitions';
import type { PhaseYamlDocument, PhaseYamlSpec } from './types';
import { PHASE_YAML_API_VERSION, PHASE_YAML_KIND } from './types';
import { METADATA_KEY_ORDER, SPEC_KEY_ORDER } from './yaml-serializer';

/**
 * Every field the format carries. Derived from the emitter's key order so the
 * set cannot drift from what is actually written; the guard test pins it
 * against the catalog's authored fields (SC-008).
 */
export const PORTABLE_PHASE_FIELDS: ReadonlySet<string> = Object.freeze(
  new Set<string>([...METADATA_KEY_ORDER, ...SPEC_KEY_ORDER])
);

/** Turn a catalog definition into a portable document. */
export function documentFromPhaseDefinition(definition: PhaseDefinition): PhaseYamlDocument {
  const common = {
    ...(definition.runner !== undefined ? { runner: definition.runner } : {}),
    ...(definition.model !== undefined ? { model: definition.model } : {}),
    ...(definition.effort !== undefined ? { effort: definition.effort } : {}),
    ...(definition.timeoutSeconds !== undefined
      ? { timeoutSeconds: definition.timeoutSeconds }
      : {}),
    ...(definition.loopable !== undefined ? { loopable: definition.loopable } : {}),
    ...(definition.isRequired !== undefined ? { isRequired: definition.isRequired } : {}),
    ...(definition.forceContinueOnRetryCap !== undefined
      ? { forceContinueOnRetryCap: definition.forceContinueOnRetryCap }
      : {}),
    ...(definition.retryCondition !== undefined
      ? { retryCondition: definition.retryCondition }
      : {})
  };
  const spec: PhaseYamlSpec =
    definition.instruction !== undefined
      ? { instruction: definition.instruction, ...common }
      : { skill: definition.skill, ...common };

  return {
    apiVersion: PHASE_YAML_API_VERSION,
    kind: PHASE_YAML_KIND,
    metadata: {
      phaseId: definition.phaseId,
      name: definition.name,
      version: definition.version,
      ...(definition.description !== undefined ? { description: definition.description } : {})
    },
    spec
  };
}

/**
 * Turn a validated document into a catalog definition. The caller must have run
 * `validatePhaseDocument` first: that is where the closed key set and every
 * field's value range are enforced, and it is the only producer of this type
 * besides the function above.
 */
export function phaseDefinitionFromDocument(document: PhaseYamlDocument): PhaseDefinition {
  const { metadata, spec } = document;
  const common = {
    phaseId: metadata.phaseId,
    name: metadata.name,
    version: metadata.version,
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
    ...(spec.timeoutSeconds !== undefined ? { timeoutSeconds: spec.timeoutSeconds } : {}),
    ...(spec.loopable !== undefined ? { loopable: spec.loopable } : {}),
    ...(spec.retryCondition !== undefined ? { retryCondition: spec.retryCondition } : {}),
    ...(spec.isRequired !== undefined ? { isRequired: spec.isRequired } : {}),
    ...(spec.forceContinueOnRetryCap !== undefined
      ? { forceContinueOnRetryCap: spec.forceContinueOnRetryCap }
      : {}),
    ...(spec.runner !== undefined ? { runner: spec.runner } : {})
  };
  return spec.instruction !== undefined
    ? { ...common, instruction: spec.instruction }
    : { ...common, skill: spec.skill };
}
