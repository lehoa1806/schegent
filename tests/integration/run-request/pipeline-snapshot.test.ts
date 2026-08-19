// Feature 087 (US4, T004) — the process is frozen at Run creation.
//
// This is the D1 regression, and it is deliberately the first thing written for
// this feature: it is red against the pre-feature code, and turning it green is
// what the freeze exists to do.
//
// The pre-existing `pipeline-catalog-run-snapshot.test.ts` pins a *different*
// guarantee — that the object `resolvePipeline()` returns is deep-copied, so an
// edit to the authored row cannot reach into it afterwards. That is about
// aliasing. This test is about *timing*: resolution happens at drain, so an
// operator edit landing between enqueue and drain is picked up by the run no
// matter how deeply the result is copied.
//
// The two deletion cases are the ones a fallback-shaped implementation absorbs
// silently. `resolvePipeline()` used to substitute the built-in Pipeline for an
// unknown id and to drop a Phase the catalog lost, so a run whose Pipeline was
// deleted executed something else entirely and never reported that it did (spec
// FR-033, US4 scenarios 2 and 3, quickstart Scenario 8 steps 4-5). Feature 098
// (T024/T025) made both a refusal, which is what this test always asked of the
// composed path — the plan is still what makes the run's own process immune.

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
import { WorkflowRunFactory } from '../../../src/services/workflow-run-factory';

const ALPHA: PhaseDef = {
  id: 'alpha', name: 'Alpha', version: 1, instruction: 'Original alpha prompt.',
  sourceScope: 'built-in'
};
const BETA: PhaseDef = {
  id: 'beta', name: 'Beta', version: 1, instruction: 'Original beta prompt.',
  sourceScope: 'built-in'
};
const DONE: PhaseDef = {
  id: 'done', name: 'Done', version: 1, instruction: '(no-op)', sourceScope: 'built-in'
};

function pipelineAB(): PipelineDef {
  return { id: 'ab-flow', name: 'A then B', phases: ['alpha', 'beta'], sourceScope: 'workspace' };
}

/**
 * A catalog behind a mutable cell, so a test can make the edit land *after* the
 * plan is frozen and *before* the factory runs — the window this feature closes.
 */
function harness(): {
  readonly factory: WorkflowRunFactory;
  freezePlan: (pipelineId: string) => FrozenRunPlan;
  replaceCatalog: (phases: PhaseDef[], pipelines: PipelineDef[]) => void;
} {
  let catalog: PipelineCatalog = buildCatalog(
    [ALPHA, BETA, DONE], [pipelineAB()], { claude: [], codex: [], agy: [] }, 'ab-flow'
  );
  const factory = new WorkflowRunFactory({
    getCatalog: () => catalog,
    defaultRunnerKind: 'claude',
    logger: new SanitizedLogger()
  });
  return {
    factory,
    // Stands in for what `validateRunRequest()` produces: the expanded
    // definition resolved through the effective catalog, at submission.
    freezePlan: (pipelineId: string): FrozenRunPlan => {
      const pipeline = catalog.pipelinesById.get(pipelineId);
      if (!pipeline) throw new Error(`test setup: '${pipelineId}' is not in the catalog`);
      const phases = pipeline.phases
        .map((phaseId) => catalog.phasesById.get(phaseId))
        .filter((def): def is PhaseDef => def !== undefined)
        .map((def) => snapshotPhaseDef(def, 'claude'));
      return {
        pipeline: snapshotPipelineContract(pipeline, phases),
        inputs: [], supplemental: [], outputs: [], frozenAt: 1
      };
    },
    replaceCatalog: (phases, pipelines) => {
      catalog = buildCatalog(
        phases, pipelines, { claude: [], codex: [], agy: [] }, pipelines[0]?.id ?? 'ab-flow'
      );
    }
  };
}

function queueItem(plan: FrozenRunPlan): FeatureRequest {
  return {
    ...ensureExtendedFeatureRequest({
      id: 'req-1', description: 'compose a run', enqueuedAt: 1,
      status: 'pending', position: 0, runId: null
    }),
    pipelineId: plan.pipeline.id,
    runPlan: plan
  };
}

describe('a queued composed Run executes the definition frozen at submission (US4)', () => {
  it('follows the original Phase order and prompt after the catalog is reordered and edited', async () => {
    const { factory, freezePlan, replaceCatalog } = harness();
    const plan = freezePlan('ab-flow');

    // The operator edits between enqueue and drain: reorder, and rewrite alpha.
    replaceCatalog(
      [{ ...ALPHA, instruction: 'Rewritten alpha prompt.' }, BETA, DONE],
      [{ ...pipelineAB(), phases: ['beta', 'alpha'] }]
    );

    const run = await factory.create(queueItem(plan), null, 'ab-flow');

    expect(run.pipeline?.phases.map((phase) => phase.id)).toEqual(['alpha', 'beta']);
    expect(run.pipeline?.phases[0]?.instruction).toBe('Original alpha prompt.');
  });

  it('still executes a Phase that was deleted from the catalog, without substituting `done`', async () => {
    const { factory, freezePlan, replaceCatalog } = harness();
    const plan = freezePlan('ab-flow');

    replaceCatalog([ALPHA, DONE], [pipelineAB()]);

    const run = await factory.create(queueItem(plan), null, 'ab-flow');

    expect(run.pipeline?.phases.map((phase) => phase.id)).toEqual(['alpha', 'beta']);
    expect(run.pipeline?.phases[1]?.instruction).toBe('Original beta prompt.');
  });

  it('still executes a Pipeline that was deleted, without falling back to the built-in one', async () => {
    const { factory, freezePlan, replaceCatalog } = harness();
    const plan = freezePlan('ab-flow');

    replaceCatalog([ALPHA, BETA, DONE], [{ id: 'other', name: 'Other', phases: ['done'] }]);

    const run = await factory.create(queueItem(plan), null, 'ab-flow');

    expect(run.pipeline?.id).toBe('ab-flow');
    expect(run.pipeline?.phases.map((phase) => phase.id)).toEqual(['alpha', 'beta']);
  });

  it('resolves nothing when a plan is present — the frozen Phase list is used verbatim', async () => {
    const { factory, freezePlan } = harness();
    const plan = freezePlan('ab-flow');

    const run = await factory.create(queueItem(plan), null, 'ab-flow');

    expect(run.pipeline).toEqual(plan.pipeline);
  });
});

describe('a queue item without a frozen plan keeps the pre-feature behavior', () => {
  it('resolves through the catalog at drain, exactly as before', async () => {
    const { factory } = harness();
    const legacy = ensureExtendedFeatureRequest({
      id: 'req-legacy', description: 'started before this feature', enqueuedAt: 1,
      status: 'pending', position: 0, runId: null
    });

    const run = await factory.create(legacy, null, 'ab-flow');

    expect(run.pipeline?.id).toBe('ab-flow');
    // Feature 098 (T025, FR-022) — `['alpha', 'beta']`, not `['alpha', 'beta',
    // 'done']`: the resolver no longer appends a terminal `done` Phase. What this
    // test is about is unchanged — a plan-less item still resolves through the
    // catalog at drain — and the sequence it resolves is now the authored one.
    expect(run.pipeline?.phases.map((phase) => phase.id)).toEqual(['alpha', 'beta']);
  });
});
