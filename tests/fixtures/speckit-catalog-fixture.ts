// Feature 098 (T080) — the Spec Kit and bugfix definitions, for the tests that
// cannot use the neutral T005 fixture.
//
// `process-catalog-fixture.ts` is the default source for anything about
// *resolution*, and it borrows no real id on purpose. This file is the
// exception, and it exists for one reason: the host still keys on a handful of
// these exact strings, so a test of that behavior needs definitions carrying
// them. Rewriting those tests onto neutral ids would not make them
// vocabulary-independent — it would delete their coverage, because the branch
// under test only fires on the literal:
//
//   - `LOOP_PHASES` in `src/controller/phase.ts` decides which Phase loops from
//     four Spec Kit ids.
//   - `nextSuccessor` in the same file falls back to a hardcoded Spec Kit chain.
//   - `workflow-run-factory.ts` skips the Phase after `speckit-specify` when a
//     featureDir is supplied.
//   - `phase-sequencer.ts` treats `bugfix-verify-pre` / `bugfix-verify-post` as
//     a pair.
//   - `workflow-run-migrator.ts` branches on the `bugfix-` id prefix.
//
// So the rows below are a statement about the host's *residual* hardcoded
// vocabulary, not about the catalog: the product ships none of them, and every
// definition here is built by this file. When those five sites are gone this
// file goes with them.
//
// The content mirrors `repo/examples/speckit-new-feature.pipeline.yaml` and
// `repo/examples/speckit-bugfix.pipeline.yaml`, which are now the only place the
// process content lives. Instructions are the short form — the examples carry
// multi-paragraph prompts, and no test here asserts on prompt text, so copying
// eight kilobytes of instruction to keep them byte-identical would buy nothing
// and rot immediately.

import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../src/config/pipeline-config';
import type { BackendRunnerKind } from '../../src/runner/backend-runner-factory';
import type { WorkflowRunPipeline } from '../../src/state/workflow-run';
import { emptyModels } from './process-catalog-fixture';

/** The model `repo/examples/` declares on every Phase in both documents. */
export const EXAMPLE_MODEL = 'claude-sonnet-5';

export const SPECKIT_PIPELINE_ID = 'speckit-new-feature';
export const SPECKIT_BUGFIX_PIPELINE_ID = 'speckit-bugfix';

export const SPECKIT_PHASE_IDS: readonly string[] = Object.freeze([
  'speckit-specify',
  'speckit-clarify',
  'speckit-plan',
  'speckit-tasks',
  'speckit-checklist',
  'speckit-analyze',
  'speckit-implement',
  'speckit-review',
  'finalize'
]);

export const BUGFIX_PHASE_IDS: readonly string[] = Object.freeze([
  'bugfix-report',
  'bugfix-patch',
  'bugfix-verify-pre',
  'bugfix-implement',
  'bugfix-verify-post'
]);

/**
 * The retry conditions the Spec Kit document declares. Kept as a lookup rather
 * than spread through the rows below so the four looping Phases are visible as a
 * set — `LOOP_PHASES` in `controller/phase.ts` names the same four, and a drift
 * between the two is what a reader comes here to check.
 */
const SPECKIT_RETRY_CONDITIONS: Readonly<Record<string, string>> = Object.freeze({
  'speckit-clarify': 'open_questions > 0',
  'speckit-analyze': 'critical_issues > 0',
  'speckit-implement': 'pending_tasks > 0',
  'speckit-review':
    'pending_tasks > 0 || code_review_findings > 0 || security_review_findings > 0'
});

/** The two Phases the document pins to a runner; the rest inherit. */
const SPECKIT_PINNED_RUNNERS: readonly string[] = Object.freeze([
  'speckit-specify',
  'finalize'
]);

const SPECKIT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'speckit-specify': 'Spec-kit Specify',
  'speckit-clarify': 'Spec-kit Clarify',
  'speckit-plan': 'Spec-kit Plan',
  'speckit-tasks': 'Spec-kit Tasks',
  'speckit-checklist': 'Spec-kit Checklist',
  'speckit-analyze': 'Spec-kit Analyze',
  'speckit-implement': 'Spec-kit Implement',
  'speckit-review': 'Spec-kit Review',
  finalize: 'Finalize'
});

const BUGFIX_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'bugfix-report': 'Spec-kit Bugfix Report',
  'bugfix-patch': 'Spec-kit Bugfix Patch',
  'bugfix-verify-pre': 'Spec-kit Bugfix Verify (pre)',
  'bugfix-implement': 'Spec-kit Implement (bugfix)',
  'bugfix-verify-post': 'Spec-kit Bugfix Verify (post)'
});

const BUGFIX_INSTRUCTIONS: Readonly<Record<string, string>> = Object.freeze({
  'bugfix-report': '/speckit-bugfix-report',
  'bugfix-patch': '/speckit-bugfix-patch',
  'bugfix-verify-pre': '/speckit-bugfix-verify',
  'bugfix-implement': '/speckit-implement',
  'bugfix-verify-post': '/speckit-bugfix-verify'
});

function speckitPhase(id: string): PhaseDef {
  const retryCondition = SPECKIT_RETRY_CONDITIONS[id];
  return Object.freeze({
    id,
    name: SPECKIT_NAMES[id]!,
    version: 1,
    // Every Spec Kit Phase but the last wraps the slash command of the same
    // name; `finalize` wraps none, so it gets a sentence instead of a `/finalize`
    // that resolves to nothing.
    instruction: id === 'finalize' ? 'Finalize the feature.' : `/${id}`,
    model: EXAMPLE_MODEL,
    ...(SPECKIT_PINNED_RUNNERS.includes(id) ? { runner: 'claude' as BackendRunnerKind } : {}),
    // `retryCondition` alone, with no `loopable` — that is what both the deleted
    // built-ins and `repo/examples/` declare. Setting `loopable: true` here would
    // silently multiply the invocation ceiling every planned-total assertion
    // reads.
    ...(retryCondition ? { retryCondition } : {})
  });
}

function bugfixPhase(id: string): PhaseDef {
  return Object.freeze({
    id,
    name: BUGFIX_NAMES[id]!,
    version: 1,
    instruction: BUGFIX_INSTRUCTIONS[id]!,
    model: EXAMPLE_MODEL
  });
}

export const SPECKIT_PHASE_DEFS: readonly PhaseDef[] = Object.freeze(
  SPECKIT_PHASE_IDS.map(speckitPhase)
);

export const BUGFIX_PHASE_DEFS: readonly PhaseDef[] = Object.freeze(
  BUGFIX_PHASE_IDS.map(bugfixPhase)
);

/** Both documents' Phases, which is what a catalog holding both needs. */
export const SPECKIT_ALL_PHASE_DEFS: readonly PhaseDef[] = Object.freeze([
  ...SPECKIT_PHASE_DEFS,
  ...BUGFIX_PHASE_DEFS
]);

export const SPECKIT_PIPELINE: PipelineDef = Object.freeze({
  id: SPECKIT_PIPELINE_ID,
  name: 'Spec-kit New Feature',
  version: 1,
  phases: SPECKIT_PHASE_IDS
});

export const BUGFIX_PIPELINE: PipelineDef = Object.freeze({
  id: SPECKIT_BUGFIX_PIPELINE_ID,
  name: 'Spec-kit Bugfix',
  version: 1,
  phases: BUGFIX_PHASE_IDS
});

export const SPECKIT_PIPELINE_DEFS: readonly PipelineDef[] = Object.freeze([
  SPECKIT_PIPELINE,
  BUGFIX_PIPELINE
]);

/**
 * Feature 098 (T055) — the same Pipeline as it is frozen *onto a Run*.
 *
 * A `PipelineDef` names its Phases; a `WorkflowRunPipeline` carries the resolved
 * definitions, and the projector reads only the second. It needs its own export
 * because the projector no longer invents a Phase list for a Run that lacks one:
 * a Run with no snapshot projects zero tiles, so a projection test that wants a
 * phase strip has to freeze one, exactly as `createRun()` does in production.
 * The Spec Kit ids rather than the neutral ones for the reason this whole file
 * exists: these are the ids the example documents carry, so a projection test
 * reads the same rows the operator would import. The sub-progress cases no
 * longer depend on the names — the iteration bar keys on each Phase's
 * `retryCondition`, which this fixture declares alongside them.
 */
export const SPECKIT_RUN_PIPELINE: WorkflowRunPipeline = Object.freeze({
  id: SPECKIT_PIPELINE_ID,
  name: SPECKIT_PIPELINE.name,
  version: SPECKIT_PIPELINE.version,
  phases: SPECKIT_PHASE_DEFS
});

/**
 * A catalog holding both documents, as a workspace that imported them resolves.
 *
 * The default is the Spec Kit Pipeline unless a caller names otherwise, which
 * is the arrangement the deleted `BUILT_IN_CATALOG` had — the tests that used it
 * enqueue against `defaultPipelineId` when their options omit a Pipeline.
 */
export function buildSpeckitCatalog(
  defaultPipelineId: string = SPECKIT_PIPELINE_ID
): PipelineCatalog {
  return buildCatalog(
    SPECKIT_ALL_PHASE_DEFS,
    SPECKIT_PIPELINE_DEFS,
    emptyModels(),
    defaultPipelineId
  );
}
