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
// called and which this feature does not modify. So the comparison stays honest
// even if the catalog, the built-in Pipeline, or the snapshot helpers change.
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
import { WorkflowRunFactory } from '../../../src/services/workflow-run-factory';

const ALPHA: PhaseDef = {
  id: 'alpha', name: 'Alpha', version: 1, instruction: 'Alpha prompt.', sourceScope: 'built-in'
};
const BETA: PhaseDef = {
  id: 'beta', name: 'Beta', version: 1, instruction: 'Beta prompt.', sourceScope: 'built-in'
};
const DONE: PhaseDef = {
  id: 'done', name: 'Done', version: 1, instruction: '(no-op)', sourceScope: 'built-in'
};

const AB_FLOW: PipelineDef = {
  id: 'ab-flow', name: 'A then B', phases: ['alpha', 'beta'], sourceScope: 'workspace'
};

function catalog(): PipelineCatalog {
  return buildCatalog([ALPHA, BETA, DONE], [AB_FLOW], { claude: [], codex: [], agy: [] }, 'ab-flow');
}

function factory(): WorkflowRunFactory {
  return new WorkflowRunFactory({
    getCatalog: catalog,
    defaultRunnerKind: 'claude',
    logger: new SanitizedLogger()
  });
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

    expect(run.pipeline).toEqual(subject.resolvePipeline('ab-flow'));
  });

  it('keeps the fail-open fallback for an unknown Pipeline id', async () => {
    // Deliberately pinned rather than fixed. The fallback is wrong for a
    // *composed* run — which is why T040's branch exists — but it is the
    // behaviour every pre-existing start path has, and changing it here would be
    // a silent behavioural change to runs this feature never touched.
    const subject = factory();

    const run = await subject.create(plainItem(), null, 'no-such-pipeline');

    expect(run.pipeline).toEqual(subject.resolvePipeline('no-such-pipeline'));
    expect(run.pipeline?.phases.some((phase) => phase.id === 'done')).toBe(true);
  });

  it('writes no runInputs, so the record serializes as it did before', async () => {
    const run = await factory().create(plainItem(), null, 'ab-flow');

    expect(Object.keys(run)).not.toContain('runInputs');
    expect(Object.keys(run)).not.toContain('runOutputs');
  });

  it('starts at the same phase and carries the same mutation plan', async () => {
    const subject = factory();
    const resolved = subject.resolvePipeline('ab-flow');

    const run = await subject.create(plainItem(), null, 'ab-flow');

    expect(run.currentPhase).toBe(resolved.phases[0]?.id);
    expect(run.mutationPlan?.fingerprint).toBe(buildMutationPlan(resolved).fingerprint);
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
