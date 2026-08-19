// Feature 098 (FR-042, source task T468) — the definition source for behavior
// tests.
//
// Until this file existed, a test that needed "some Phase" reached for
// `BUILT_IN_PHASES` and a test that needed "some Pipeline" reached for
// `BUILT_IN_PIPELINE`. That coupled every resolution test to the product's own
// compiled-in content: the assertions read as though they were about resolution
// while they were in fact about the built-in rows, so emptying those rows would
// fail hundreds of tests that have nothing to do with what the built-in layer
// contains.
//
// So the definitions here are written out in full rather than derived, and
// deliberately do **not** reuse a real Phase or Pipeline id. A fixture that
// borrowed `speckit-plan` would still be asserting something about the product's
// vocabulary; one that borrows nothing can only be asserting resolution.
//
// Two shapes are exported because tests need both ends of the pipe: the authored
// `PhaseDefinition` a document carries, and the runtime `PhaseDef` the catalog
// resolves to. Keep them in step by hand — they are not projections of each
// other, and a test that mixes one file's authored row with another's runtime row
// is testing the fixture rather than the product.

import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../src/config/pipeline-config';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { PipelineDefinition } from '../../src/contracts/pipeline-definitions';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../src/runner/backend-runner-factory';

/**
 * Ids the fixture claims. Chosen to collide with nothing in the product or in
 * `repo/examples/`, so an import-presence scan over a catalog holding these rows
 * says something about the scan rather than about the id.
 */
export const FIXTURE_PHASE_IDS = Object.freeze({
  first: 'fixture-first',
  second: 'fixture-second',
  gitCapable: 'fixture-git-capable',
  skillBased: 'fixture-skill-based',
  undeclared: 'fixture-undeclared'
});

export const FIXTURE_PIPELINE_IDS = Object.freeze({
  simple: 'fixture-simple-pipeline',
  single: 'fixture-single-phase-pipeline'
});

/** A Phase declaring the FR-005 defaults explicitly. */
export const FIXTURE_PHASE_FIRST: PhaseDef = Object.freeze({
  id: FIXTURE_PHASE_IDS.first,
  name: 'Fixture First',
  version: 1,
  instruction: 'Do the first fixture thing.',
  model: 'fixture-model',
  runner: 'claude' as BackendRunnerKind,
  sideEffects: 'workspace',
  evidencePolicy: 'required'
});

/** A loopable Phase with a retry condition, for retry-path tests. */
export const FIXTURE_PHASE_SECOND: PhaseDef = Object.freeze({
  id: FIXTURE_PHASE_IDS.second,
  name: 'Fixture Second',
  version: 1,
  instruction: 'Do the second fixture thing.',
  loopable: true,
  retryCondition: 'pending_tasks > 0',
  sideEffects: 'workspace',
  evidencePolicy: 'best-effort'
});

/**
 * A Git-capable Phase under an id the product does not recognise. The point of
 * the fixture: the capability comes from the declaration, never from the id.
 */
export const FIXTURE_PHASE_GIT_CAPABLE: PhaseDef = Object.freeze({
  id: FIXTURE_PHASE_IDS.gitCapable,
  name: 'Fixture Git Capable',
  version: 1,
  instruction: 'Commit the fixture work.',
  sideEffects: 'git',
  evidencePolicy: 'required'
});

/** A skill-based Phase — `skill` and `instruction` are mutually exclusive. */
export const FIXTURE_PHASE_SKILL_BASED: PhaseDef = Object.freeze({
  id: FIXTURE_PHASE_IDS.skillBased,
  name: 'Fixture Skill Based',
  version: 1,
  skill: 'fixture-skill',
  sideEffects: 'none',
  evidencePolicy: 'none'
});

/**
 * A Phase declaring neither containment field. Kept separate from the others so
 * a test asserting the FR-005 resolver defaults has a row that genuinely omits
 * them, rather than one that happens to declare the default value.
 */
export const FIXTURE_PHASE_UNDECLARED: PhaseDef = Object.freeze({
  id: FIXTURE_PHASE_IDS.undeclared,
  name: 'Fixture Undeclared',
  version: 1,
  instruction: 'Declare nothing about containment.'
});

export const FIXTURE_PHASES: readonly PhaseDef[] = Object.freeze([
  FIXTURE_PHASE_FIRST,
  FIXTURE_PHASE_SECOND,
  FIXTURE_PHASE_GIT_CAPABLE,
  FIXTURE_PHASE_SKILL_BASED,
  FIXTURE_PHASE_UNDECLARED
]);

/** Two Phases in sequence — enough to exercise advance, retry, and terminal. */
export const FIXTURE_PIPELINE_SIMPLE: PipelineDef = Object.freeze({
  id: FIXTURE_PIPELINE_IDS.simple,
  name: 'Fixture Simple Pipeline',
  version: 1,
  phases: Object.freeze([FIXTURE_PHASE_IDS.first, FIXTURE_PHASE_IDS.second]) as readonly string[]
});

/** One Phase — the shortest sequence a Run can have. */
export const FIXTURE_PIPELINE_SINGLE: PipelineDef = Object.freeze({
  id: FIXTURE_PIPELINE_IDS.single,
  name: 'Fixture Single Phase Pipeline',
  version: 1,
  phases: Object.freeze([FIXTURE_PHASE_IDS.first]) as readonly string[]
});

export const FIXTURE_PIPELINES: readonly PipelineDef[] = Object.freeze([
  FIXTURE_PIPELINE_SIMPLE,
  FIXTURE_PIPELINE_SINGLE
]);

/** The authored document rows corresponding to the runtime rows above. */
export const FIXTURE_PHASE_DEFINITION_FIRST: PhaseDefinition = Object.freeze({
  phaseId: FIXTURE_PHASE_IDS.first,
  name: 'Fixture First',
  version: 1,
  instruction: 'Do the first fixture thing.',
  model: 'fixture-model',
  runner: 'claude' as BackendRunnerKind,
  sideEffects: 'workspace',
  evidencePolicy: 'required'
});

export const FIXTURE_PHASE_DEFINITION_SECOND: PhaseDefinition = Object.freeze({
  phaseId: FIXTURE_PHASE_IDS.second,
  name: 'Fixture Second',
  version: 1,
  instruction: 'Do the second fixture thing.',
  loopable: true,
  retryCondition: 'pending_tasks > 0',
  sideEffects: 'workspace',
  evidencePolicy: 'best-effort'
});

export const FIXTURE_PHASE_DEFINITION_SKILL_BASED: PhaseDefinition = Object.freeze({
  phaseId: FIXTURE_PHASE_IDS.skillBased,
  name: 'Fixture Skill Based',
  version: 1,
  skill: 'fixture-skill',
  sideEffects: 'none',
  evidencePolicy: 'none'
});

export const FIXTURE_PHASE_DEFINITION_GIT_CAPABLE: PhaseDefinition = Object.freeze({
  phaseId: FIXTURE_PHASE_IDS.gitCapable,
  name: 'Fixture Git Capable',
  version: 1,
  instruction: 'Commit the fixture work.',
  sideEffects: 'git',
  evidencePolicy: 'required'
});

export const FIXTURE_PHASE_DEFINITION_UNDECLARED: PhaseDefinition = Object.freeze({
  phaseId: FIXTURE_PHASE_IDS.undeclared,
  name: 'Fixture Undeclared',
  version: 1,
  instruction: 'Declare nothing about containment.'
});

// Feature 098 (T080) — all five, in the same order as `FIXTURE_PHASES`. It held
// three until a fixture needed to author the two-Phase Pipeline into a scope and
// have it resolve; a document naming a Phase this list omits produces an invalid
// Pipeline row, which is a statement about the fixture rather than the product.
export const FIXTURE_PHASE_DEFINITIONS: readonly PhaseDefinition[] = Object.freeze([
  FIXTURE_PHASE_DEFINITION_FIRST,
  FIXTURE_PHASE_DEFINITION_SECOND,
  FIXTURE_PHASE_DEFINITION_GIT_CAPABLE,
  FIXTURE_PHASE_DEFINITION_SKILL_BASED,
  FIXTURE_PHASE_DEFINITION_UNDECLARED
]);

/**
 * The authored Pipeline rows corresponding to `FIXTURE_PIPELINES`. Same
 * hand-kept correspondence as the Phase pair above, and the same warning: the
 * authored row names `pipelineId`/`phaseIds` where the runtime row names
 * `id`/`phases`, so they are two shapes rather than one shape twice.
 */
export const FIXTURE_PIPELINE_DEFINITION_SIMPLE: PipelineDefinition = Object.freeze({
  pipelineId: FIXTURE_PIPELINE_IDS.simple,
  name: 'Fixture Simple Pipeline',
  version: 1,
  phaseIds: Object.freeze([FIXTURE_PHASE_IDS.first, FIXTURE_PHASE_IDS.second]) as readonly string[],
  inputs: Object.freeze([]) as readonly [],
  outputs: Object.freeze([]) as readonly [],
  bindings: Object.freeze([]) as readonly [],
  recommendedNext: Object.freeze([]) as readonly []
});

export const FIXTURE_PIPELINE_DEFINITION_SINGLE: PipelineDefinition = Object.freeze({
  pipelineId: FIXTURE_PIPELINE_IDS.single,
  name: 'Fixture Single Phase Pipeline',
  version: 1,
  phaseIds: Object.freeze([FIXTURE_PHASE_IDS.first]) as readonly string[],
  inputs: Object.freeze([]) as readonly [],
  outputs: Object.freeze([]) as readonly [],
  bindings: Object.freeze([]) as readonly [],
  recommendedNext: Object.freeze([]) as readonly []
});

export const FIXTURE_PIPELINE_DEFINITIONS: readonly PipelineDefinition[] = Object.freeze([
  FIXTURE_PIPELINE_DEFINITION_SIMPLE,
  FIXTURE_PIPELINE_DEFINITION_SINGLE
]);

/** Every supported backend mapped to no models — the shipped default. */
export function emptyModels(): Record<BackendRunnerKind, readonly string[]> {
  const models = {} as Record<BackendRunnerKind, readonly string[]>;
  for (const backend of SUPPORTED_BACKENDS) {
    models[backend] = Object.freeze([]);
  }
  return models;
}

/**
 * The catalog as it stands on a first run: no Phases, no Pipelines, no models,
 * and `defaultPipelineId: ''` (research.md R7). Tests asserting a refusal on an
 * unresolvable id build from here.
 */
export function buildEmptyCatalog(): PipelineCatalog {
  return buildCatalog([], [], emptyModels(), '');
}

/**
 * The fixture catalog: every Phase and Pipeline above, with the two-Phase
 * Pipeline as the default. Tests asserting resolution behavior build from here
 * instead of from `BUILT_IN_CATALOG`.
 */
export function buildFixtureCatalog(
  overrides: {
    readonly phases?: readonly PhaseDef[];
    readonly pipelines?: readonly PipelineDef[];
    readonly models?: Record<BackendRunnerKind, readonly string[]>;
    readonly defaultPipelineId?: string;
  } = {}
): PipelineCatalog {
  return buildCatalog(
    overrides.phases ?? FIXTURE_PHASES,
    overrides.pipelines ?? FIXTURE_PIPELINES,
    overrides.models ?? emptyModels(),
    overrides.defaultPipelineId ?? FIXTURE_PIPELINE_IDS.simple
  );
}

/**
 * A single Phase with the named fields replaced. For the common case where a
 * test needs one row differing from the fixture in one field, and copying the
 * whole literal would bury which field the test is actually about.
 */
export function fixturePhase(overrides: Partial<PhaseDef> & { readonly id: string }): PhaseDef {
  return Object.freeze({ ...FIXTURE_PHASE_FIRST, ...overrides });
}

/** The Pipeline equivalent of `fixturePhase`. */
export function fixturePipeline(
  overrides: Partial<PipelineDef> & { readonly id: string }
): PipelineDef {
  return Object.freeze({ ...FIXTURE_PIPELINE_SIMPLE, ...overrides });
}
