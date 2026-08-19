// FR-R3-001 (T269) — the two paths through `WorkflowRunFactory.create()` stay a
// discriminated choice.
//
// `workflow-run-factory.test.ts` already pins that a plan-less item resolves its
// Pipeline exactly as it did before feature 087. This file pins the half T259
// added on top of that: the *shape* of the record each path produces. The two
// spreads are conditioned on one `plan`, and the failure mode is not that one of
// them is wrong — it is that a later edit conditions them differently, or copies
// a field out of the envelope "for convenience", and a plan-less Run quietly
// grows a key or a composed Run quietly loses one.
//
// So the composed assertions are `toBe`, not `toEqual`. Consumed *by reference*
// is the whole design: an envelope that deep-equals the plan but is a different
// object is a copy, and a copy is the thing that went stale at this exact seam
// in feature 087. Structural equality cannot tell those apart.

import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../../src/config/pipeline-config';
import { snapshotPhaseDef, snapshotPipelineContract } from '../../../src/config/pipeline-snapshot';
import type { ExecutionEnvelope } from '../../../src/contracts/run-request';
import { SanitizedLogger } from '../../../src/lib/logger';
import { ensureExtendedFeatureRequest, type FeatureRequest } from '../../../src/queue/feature-request';
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

function item(overrides: Partial<FeatureRequest> = {}): FeatureRequest {
  return {
    ...ensureExtendedFeatureRequest({
      id: 'req-1', description: 'started the ordinary way', enqueuedAt: 1,
      status: 'pending', position: 0, runId: null
    }),
    ...overrides
  };
}

/**
 * A plan with **every** arm populated, including the three the factory has no
 * reason to look at.
 *
 * That is the point: the 087 defect was a seam that read one field of five and
 * dropped the rest, and a fixture that only fills the field the seam reads
 * cannot observe the difference between carrying the envelope and harvesting it.
 */
function fullPlan(): ExecutionEnvelope {
  return {
    pipeline: snapshotPipelineContract(
      AB_FLOW,
      [ALPHA, BETA].map((phase) => snapshotPhaseDef(phase, 'claude'))
    ),
    inputs: [{ portId: 'brief', type: 'text', value: 'ship it' }],
    supplemental: [{ kind: 'text', value: 'prefer tables' }],
    outputs: [
      { portId: 'report', type: 'markdown', target: 'out/report.md', overwriteConfirmed: false }
    ],
    instructions: 'cite every figure',
    frozenAt: 1
  };
}

/**
 * Every key a plan-less Run carries, recorded rather than derived.
 *
 * Deriving it from a second `create()` call would make the assertion tautological.
 * Written out, a change to the legacy record's serialized shape has to be made
 * deliberately, in this list, in the same diff.
 */
const LEGACY_KEYS = [
  'currentIteration',
  'currentPhase',
  'defaultRunnerKind',
  'delayedRetryCount',
  'featureDir',
  'featureId',
  'id',
  'lastError',
  'lastTransitionAt',
  'manualPauseAt',
  'manualPauseCause',
  'mutationPlan',
  'pendingRetryAt',
  'pendingRetryCause',
  'phaseBreakpoints',
  'phaseOverrides',
  'phasesCompleted',
  'pipeline',
  // FR-R3-008 (T385) — recorded deliberately, per the note above. The factory
  // freezes a progress total onto *every* Run it creates, plan or no plan, and
  // that is the field's contract rather than an oversight on this path: the
  // projector renders absence as "unknown", which is only sound if presence is
  // unconditional for everything written after the feature. A plan-less Run is
  // not a legacy record. `liveness` is deliberately *not* here — it is written on
  // first output, so a Run that has produced none has no stamp to carry, and this
  // list is the shape at creation.
  'plannedTotal',
  'rawTranscriptMode',
  'resumeTargetPhaseId',
  'startedAt',
  'status'
] as const;

describe('the plan-less path is untouched by the envelope (FR-R3-001, T267)', () => {
  it('adds no envelope key at all', async () => {
    const run = await factory().create(item(), null, 'ab-flow');

    // Not `toBeUndefined` — the key must be *absent*, because a present-but-
    // undefined key is a different serialized record and a different answer to
    // `'envelope' in run`, which is how the execution path discriminates.
    expect('envelope' in run).toBe(false);
    expect('runInputs' in run).toBe(false);
  });

  it('serializes with exactly the keys it did before the feature', async () => {
    const run = await factory().create(item(), null, 'ab-flow');

    expect(Object.keys(run).sort()).toEqual([...LEGACY_KEYS]);
  });

  it('still resolves its Pipeline from the catalog', async () => {
    const subject = factory();

    const run = await subject.create(item(), null, 'ab-flow');

    // Feature 098 (T024) — `resolvePipeline` answers with a discriminated
    // resolution, so the comparison is against the contract it resolved rather
    // than against the return value, which now also carries the `ok` tag.
    const resolution = subject.resolvePipeline('ab-flow');
    if (!resolution.ok) {
      throw new Error(`expected 'ab-flow' to resolve, got ${resolution.refusal.reason}`);
    }
    expect(run.pipeline).toEqual(resolution.pipeline);
  });
});

describe('the composed path carries the envelope by reference (FR-R3-001, T259)', () => {
  it('attaches the identical object the queue item carried', async () => {
    const plan = fullPlan();

    const run = await factory().create(item({ runPlan: plan }), null, 'ab-flow');

    expect(run.envelope).toBe(plan);
  });

  it('keeps every arm the factory has no reason to read', async () => {
    const plan = fullPlan();

    const run = await factory().create(item({ runPlan: plan }), null, 'ab-flow');

    expect(run.envelope?.supplemental).toBe(plan.supplemental);
    expect(run.envelope?.outputs).toBe(plan.outputs);
    expect(run.envelope?.instructions).toBe('cite every figure');
  });

  it('does not take a second snapshot of the pipeline', async () => {
    const plan = fullPlan();

    const run = await factory().create(item({ runPlan: plan }), null, 'ab-flow');

    // One snapshot, reachable two ways. `run.pipeline` is what the drive loop
    // reads and `run.envelope.pipeline` is what the request says it agreed to;
    // if these were ever two objects, they could diverge.
    expect(run.pipeline).toBe(plan.pipeline);
    expect(run.envelope?.pipeline).toBe(run.pipeline);
  });

  it('populates both conditioned keys together, never one of them', async () => {
    const plan = fullPlan();

    const run = await factory().create(item({ runPlan: plan }), null, 'ab-flow');

    expect('envelope' in run).toBe(true);
    expect('runInputs' in run).toBe(true);
    expect(run.runInputs).toBe(plan.inputs);
  });

  it('ignores the requested pipeline id entirely', async () => {
    const plan = fullPlan();

    // An id that would fail open to the built-in Pipeline if it were consulted.
    const run = await factory().create(item({ runPlan: plan }), null, 'no-such-pipeline');

    expect(run.pipeline).toBe(plan.pipeline);
  });
});
