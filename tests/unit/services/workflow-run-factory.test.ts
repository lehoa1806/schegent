// Feature 087 (T041, US4) — the fallback path is untouched.
//
// T040 added one branch to `WorkflowRunFactory.create()`: a queue item carrying
// a `runPlan` uses the frozen definition and resolves nothing. Every other item
// takes the original branch, and this pins that "every other" is genuinely
// unchanged — the risk of a `?? fallback` rewrite is not that the new path is
// wrong, it is that the old one quietly stops being the old one.
//
// The pre-feature behaviour is reconstructed rather than remembered: the run a
// plan-less item produces is compared field-by-field against
// `resolvePipeline(requestedId)`, which is the function the pre-feature `create()`
// called. So the comparison stays honest even if the catalog or the snapshot
// helpers change. Feature 098 (T024/T025) did modify that function — it answers
// with a discriminated resolution and refuses rather than substituting — which is
// why the comparison now goes through the `resolved()` helper below.
//
// The `pipeline-snapshot.test.ts` integration suite covers the *plan-carrying*
// half, including the deleted-Phase and deleted-Pipeline cases.

import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../../src/config/pipeline-config';
import { snapshotPhaseDef, snapshotPipelineContract } from '../../../src/config/pipeline-snapshot';
import type { FrozenRunPlan } from '../../../src/contracts/run-request';
import { SanitizedLogger } from '../../../src/lib/logger';
import { ensureExtendedFeatureRequest, type FeatureRequest } from '../../../src/queue/feature-request';
import { buildMutationPlan } from '../../../src/services/mutation-plan';
import {
  UnresolvablePipelineError,
  WorkflowRunFactory
} from '../../../src/services/workflow-run-factory';
import type { WorkflowRunPipeline } from '../../../src/state/workflow-run';

const ALPHA: PhaseDef = {
  id: 'alpha', name: 'Alpha', version: 1, instruction: 'Alpha prompt.'
};
const BETA: PhaseDef = {
  id: 'beta', name: 'Beta', version: 1, instruction: 'Beta prompt.'
};
const DONE: PhaseDef = {
  id: 'done', name: 'Done', version: 1, instruction: '(no-op)'
};

const AB_FLOW: PipelineDef = {
  id: 'ab-flow', name: 'A then B', phases: ['alpha', 'beta']
};

function catalog(): PipelineCatalog {
  return buildCatalog([ALPHA, BETA, DONE], [AB_FLOW], { claude: [], codex: [], agy: [] }, 'ab-flow');
}

function factory(getCatalog: () => PipelineCatalog = catalog): WorkflowRunFactory {
  return new WorkflowRunFactory({
    getCatalog,
    defaultRunnerKind: 'claude',
    logger: new SanitizedLogger()
  });
}

/** Feature 098 (T020/T023) — the post-feature shape of a catalog with nothing in it. */
function emptyCatalog(): PipelineCatalog {
  return buildCatalog([], [], { claude: [], codex: [], agy: [] }, '');
}

function plainItem(overrides: Partial<FeatureRequest> = {}): FeatureRequest {
  return {
    ...ensureExtendedFeatureRequest({
      id: 'req-1', description: 'started the ordinary way', enqueuedAt: 1,
      status: 'pending', position: 0, runId: null
    }),
    ...overrides
  };
}

/**
 * Feature 098 (T024) — `resolvePipeline` answers with a discriminated resolution
 * now, so a test that wants the Pipeline says so and a refusal fails loudly here
 * rather than as `undefined.phases` three assertions later.
 */
function resolved(subject: WorkflowRunFactory, id: string): WorkflowRunPipeline {
  const resolution = subject.resolvePipeline(id);
  if (!resolution.ok) throw new Error(`expected '${id}' to resolve, got ${resolution.refusal.reason}`);
  return resolution.pipeline;
}

/** What `validateRunRequest()` produces, reduced to what the factory reads. */
function planFor(pipeline: PipelineDef, phases: readonly PhaseDef[]): FrozenRunPlan {
  return {
    pipeline: snapshotPipelineContract(pipeline, phases.map((phase) => snapshotPhaseDef(phase, 'claude'))),
    inputs: [{ portId: 'brief', type: 'text', value: 'ship it' }],
    supplemental: [],
    outputs: [],
    frozenAt: 1
  };
}

describe('a queue item without a frozen plan resolves exactly as before (T041)', () => {
  it('produces the same Pipeline the pre-feature resolve path produces', async () => {
    const subject = factory();

    const run = await subject.create(plainItem(), null, 'ab-flow');

    expect(run.pipeline).toEqual(resolved(subject, 'ab-flow'));
  });

  it('writes no runInputs, so the record serializes as it did before', async () => {
    const run = await factory().create(plainItem(), null, 'ab-flow');

    expect(Object.keys(run)).not.toContain('runInputs');
    expect(Object.keys(run)).not.toContain('runOutputs');
  });

  it('starts at the same phase and carries the same mutation plan', async () => {
    const subject = factory();
    const pipeline = resolved(subject, 'ab-flow');

    const run = await subject.create(plainItem(), null, 'ab-flow');

    expect(run.currentPhase).toBe(pipeline.phases[0]?.id);
    expect(run.mutationPlan?.fingerprint).toBe(buildMutationPlan(pipeline).fingerprint);
  });
});

// Feature 098 (T020, US3, FR-023/FR-024, SC-007/SC-008) — the two substitutions
// this factory used to perform become refusals.
//
// The test that stood here pinned the fail-open fallback deliberately: under
// feature 087 an unknown id became the built-in Pipeline, and that was the
// behaviour every pre-composed start path had. It is now the defect. With the
// built-in layer emptied the fallback substitutes *nothing* — or, while the rows
// are still present, a Spec-kit Pipeline the operator never asked for — so the
// honest answer is a refusal naming the id that failed to resolve.
//
// Both refusals are values, not throws: `resolvePipeline` is also read from
// snapshot-projection paths where a throw takes down the sidebar render rather
// than refusing a launch. `create()` is the one caller that converts a refusal
// into a failure, and it does so the way it already fails an unapproved mutation
// plan — before any Run record exists.
describe('an unresolvable definition is refused, not substituted (T020)', () => {
  it('refuses an unknown Pipeline id, naming it', () => {
    const resolution = factory().resolvePipeline('no-such-pipeline');

    expect(resolution).toEqual({
      ok: false,
      refusal: { reason: 'pipeline-not-found', pipelineId: 'no-such-pipeline' }
    });
  });

  it('creates no Run record for an unknown Pipeline id', async () => {
    await expect(factory().create(plainItem(), null, 'no-such-pipeline')).rejects.toThrow(
      UnresolvablePipelineError
    );
  });

  it('carries the requested id on the error the caller sees', async () => {
    // SC-007 is about the operator seeing *which* id failed, so the refusal has
    // to survive the hop out of the factory rather than being flattened into a
    // generic start failure.
    const error = await factory()
      .create(plainItem(), null, 'no-such-pipeline')
      .then(() => null, (err: unknown) => err);

    expect(error).toBeInstanceOf(UnresolvablePipelineError);
    expect((error as UnresolvablePipelineError).refusal).toEqual({
      reason: 'pipeline-not-found',
      pipelineId: 'no-such-pipeline'
    });
    expect((error as Error).message).toContain('no-such-pipeline');
  });

  it('refuses a Pipeline naming a Phase id with no definition, rather than omitting it', () => {
    // The pre-feature expression was `phasesById.get(phaseId) ?? get('done')`,
    // and since no `PhaseDef` ever declared `done` the miss resolved to
    // `undefined` and the Phase was dropped — a Run that silently executed a
    // shorter sequence than the Pipeline named (FR-022).
    const gapped: PipelineDef = {
      id: 'gapped', name: 'Has a gap', phases: ['alpha', 'ghost']
    };
    const subject = factory(() =>
      buildCatalog([ALPHA, BETA], [gapped], { claude: [], codex: [], agy: [] }, 'gapped')
    );

    expect(subject.resolvePipeline('gapped')).toEqual({
      ok: false,
      refusal: { reason: 'unknown-phase', pipelineId: 'gapped', phaseId: 'ghost' }
    });
  });

  it('appends no terminal phase to a Pipeline that does not name one', () => {
    // The terminal `done` append went with the substitution (FR-021/FR-022). It
    // depended on the same never-resolving lookup, so nothing it produced ever
    // reached a Run — but a `done` reappearing here would mean a Phase in the
    // snapshot that no Pipeline declared.
    const pipeline = resolved(factory(), 'ab-flow');

    expect(pipeline.phases.map((phase) => phase.id)).toEqual(['alpha', 'beta']);
  });
});

describe('a queue item carrying a frozen plan uses it verbatim (T040)', () => {
  it('takes the plan\'s Pipeline rather than resolving the requested id', async () => {
    const plan = planFor(AB_FLOW, [ALPHA, BETA]);
    const item = plainItem({ pipelineId: 'ab-flow', runPlan: plan });

    // A different id is requested on purpose: under the plan branch it must not
    // be consulted at all.
    const run = await factory().create(item, null, 'no-such-pipeline');

    expect(run.pipeline).toEqual(plan.pipeline);
  });

  it('records the bindings the Run executed with', async () => {
    const plan = planFor(AB_FLOW, [ALPHA, BETA]);

    const run = await factory().create(plainItem({ runPlan: plan }), null, 'ab-flow');

    expect(run.runInputs).toEqual([{ portId: 'brief', type: 'text', value: 'ship it' }]);
  });

  it('records no outputs at creation — those are resolved at completion (FR-040)', async () => {
    const run = await factory().create(
      plainItem({ runPlan: planFor(AB_FLOW, [ALPHA, BETA]) }), null, 'ab-flow'
    );

    expect(Object.keys(run)).not.toContain('runOutputs');
  });
});

// Feature 098 (T023, US3, FR-029, SC-009) — the refusals above sit on the
// resolution path, and a frozen plan does not travel it.
//
// This is the standing hard rule on drain-time resolution, asserted rather than
// stated: the operator approved one process and must watch that process run. The
// catalog here holds *nothing* — not a stale definition, not a renamed one — so
// every substitution and every refusal the feature introduces has its worst case
// available, and the only thing that can carry the Run is the snapshot itself.
describe('a frozen plan bypasses every refusal (T023)', () => {
  it('executes every Phase in the snapshot, in order, against an empty catalog', async () => {
    const plan = planFor(AB_FLOW, [ALPHA, BETA]);

    const run = await factory(emptyCatalog).create(
      plainItem({ pipelineId: 'ab-flow', runPlan: plan }), null, 'ab-flow'
    );

    expect(run.pipeline?.phases.map((phase) => phase.id)).toEqual(['alpha', 'beta']);
    expect(run.pipeline).toEqual(plan.pipeline);
    expect(run.currentPhase).toBe('alpha');
  });

  it('refuses nothing, even though the requested id resolves to nothing', async () => {
    const subject = factory(emptyCatalog);
    // The same id, on the same factory, without a plan: the refusal is live, so
    // the plan branch is demonstrably bypassing it rather than resolving to the
    // same answer by luck.
    expect(subject.resolvePipeline('ab-flow').ok).toBe(false);

    const run = await subject.create(
      plainItem({ runPlan: planFor(AB_FLOW, [ALPHA, BETA]) }), null, 'ab-flow'
    );

    expect(run.pipeline?.id).toBe('ab-flow');
  });
});
